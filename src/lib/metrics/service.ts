import { routeFinding } from "@/lib/findings/router";
import { stateStore } from "@/lib/state/store";
import type { Device, DeviceBaseline, MetricSample, ServiceContract } from "@/lib/state/types";

export const DEVICE_LATENCY_METRIC_KEY = "device.latency_ms";
export const ASSURANCE_RESULT_METRIC_KEY = "assurance.result_score";

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], mean: number): number {
  if (values.length < 2) {
    return 0;
  }
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function assuranceStatusScore(status: "pass" | "fail" | "pending" | "skipped"): number {
  switch (status) {
    case "pass":
      return 1;
    case "pending":
      return 0.5;
    case "fail":
      return 0;
    default:
      return 0.25;
  }
}

function latencyBounds(
  baseline: DeviceBaseline | undefined,
  samples: MetricSample[],
): { lower: number; upper: number; mean: number } {
  const historical = samples
    .map((sample) => sample.value)
    .filter((value) => Number.isFinite(value));
  const mean = historical.length > 0 ? average(historical) : (baseline?.avgLatencyMs ?? 0);
  const deviation = historical.length > 1 ? standardDeviation(historical, mean) : 0;
  const lower = Math.max(0, baseline?.minLatencyMs ?? Math.max(0, mean - Math.max(5, deviation * 2)));
  const upper = Math.max(
    baseline?.maxLatencyMs ?? 0,
    mean + Math.max(10, deviation * 3),
    mean * 1.75,
    25,
  );
  return { lower, upper, mean };
}

export async function recordDeviceLatencyMetric(
  device: Device,
  latencyMs: number,
  baseline?: DeviceBaseline,
): Promise<{
  sample: MetricSample;
  anomalous: boolean;
  anomalyScore?: number;
  baselineLower: number;
  baselineUpper: number;
}> {
  const series = stateStore.upsertMetricSeries({
    scopeType: "device",
    scopeId: device.id,
    metricKey: DEVICE_LATENCY_METRIC_KEY,
    unit: "ms",
    source: "icmp_ping",
    retentionDays: 90,
  });
  const historical = stateStore.getRecentMetricSamples("device", device.id, DEVICE_LATENCY_METRIC_KEY, 30);
  const bounds = latencyBounds(baseline, historical);
  const hasEnoughHistory = historical.length >= 5 || (baseline?.samples ?? 0) >= 5;
  const anomalous = hasEnoughHistory && latencyMs > bounds.upper;
  const anomalyScore = anomalous
    ? Number(((latencyMs - bounds.upper) / Math.max(bounds.upper, 1)).toFixed(4))
    : undefined;

  const sample = stateStore.recordMetricSample({
    seriesId: series.id,
    scopeType: "device",
    scopeId: device.id,
    metricKey: DEVICE_LATENCY_METRIC_KEY,
    value: latencyMs,
    unit: "ms",
    source: "icmp_ping",
    observedAt: new Date().toISOString(),
    dimensionsJson: {
      ip: device.ip,
      deviceName: device.name,
      siteId: device.siteId ?? "site.local.default",
    },
    anomalyScore,
    baselineLower: bounds.lower,
    baselineUpper: bounds.upper,
  });

  const findingKey = `latency-anomaly:${device.id}`;
  const existingLatencyFinding = stateStore
    .getDeviceFindings(device.id, "open")
    .find((finding) => finding.dedupeKey === findingKey);

  if (anomalous) {
    const summary = `${device.name} latency measured ${Math.round(latencyMs)}ms, above expected upper bound ${Math.round(bounds.upper)}ms.`;
    const severity = latencyMs >= bounds.upper * 1.5 ? "critical" : "warning";
    const routed = await routeFinding({
      incidents: stateStore.getIncidents(),
      source: "metric.latency",
      finding: {
        deviceId: device.id,
        dedupeKey: findingKey,
        findingType: "latency_anomaly",
        severity,
        title: `${device.name} latency anomaly`,
        summary,
        evidenceJson: {
          metricKey: DEVICE_LATENCY_METRIC_KEY,
          latencyMs,
          baselineLower: bounds.lower,
          baselineUpper: bounds.upper,
          anomalyScore,
        },
        status: "open",
      },
      occurrenceMetadata: {
        metricSampleId: sample.id,
        anomalyScore,
      },
      incident: {
        title: `${device.name} latency anomaly`,
        summary,
        severity,
        notifyOnOpen: true,
        metadata: {
          metricKey: DEVICE_LATENCY_METRIC_KEY,
          deviceId: device.id,
        },
        resolveMessage: `Latency recovered for ${device.name}.`,
      },
    });
    await stateStore.setIncidents(routed.incidents.slice(0, 400));
  } else if (existingLatencyFinding) {
    const routed = await routeFinding({
      incidents: stateStore.getIncidents(),
      source: "metric.latency",
      finding: {
        deviceId: device.id,
        dedupeKey: findingKey,
        findingType: "latency_anomaly",
        severity: existingLatencyFinding.severity,
        title: existingLatencyFinding.title,
        summary: `${device.name} latency returned to ${Math.round(latencyMs)}ms, within expected range.`,
        evidenceJson: {
          metricKey: DEVICE_LATENCY_METRIC_KEY,
          latencyMs,
          baselineLower: bounds.lower,
          baselineUpper: bounds.upper,
        },
        status: "resolved",
      },
      occurrenceMetadata: {
        metricSampleId: sample.id,
        recovered: true,
      },
      incident: {
        title: existingLatencyFinding.title,
        summary: existingLatencyFinding.summary,
        severity: existingLatencyFinding.severity,
        metadata: {
          metricKey: DEVICE_LATENCY_METRIC_KEY,
          deviceId: device.id,
        },
        resolveMessage: `Latency recovered for ${device.name}.`,
      },
    });
    await stateStore.setIncidents(routed.incidents.slice(0, 400));
  }

  return {
    sample,
    anomalous,
    anomalyScore,
    baselineLower: bounds.lower,
    baselineUpper: bounds.upper,
  };
}

export function recordAssuranceResultMetric(
  device: Device,
  contract: ServiceContract,
  status: "pass" | "fail" | "pending" | "skipped",
  evaluatedAt: string,
): MetricSample {
  const series = stateStore.upsertMetricSeries({
    scopeType: "assurance",
    scopeId: contract.id,
    metricKey: ASSURANCE_RESULT_METRIC_KEY,
    source: "assurance_runtime",
    retentionDays: 90,
  });

  return stateStore.recordMetricSample({
    seriesId: series.id,
    scopeType: "assurance",
    scopeId: contract.id,
    metricKey: ASSURANCE_RESULT_METRIC_KEY,
    value: assuranceStatusScore(status),
    source: "assurance_runtime",
    observedAt: evaluatedAt,
    dimensionsJson: {
      deviceId: device.id,
      workloadId: contract.workloadId ?? null,
      monitorType: contract.monitorType,
      status,
    },
  });
}
