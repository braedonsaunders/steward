import { stateStore } from "@/lib/state/store";
import type {
  Assurance,
  AssuranceRun,
  Device,
  DeviceBaseline,
  DeviceFinding,
  DeviceWidget,
  Incident,
  PlaybookRun,
  Recommendation,
  Workload,
} from "@/lib/state/types";

export interface DeviceWidgetContext {
  generatedAt: string;
  device: Device;
  baseline: DeviceBaseline | null;
  workloads: Workload[];
  assurances: Assurance[];
  latestAssuranceRuns: AssuranceRun[];
  findings: DeviceFinding[];
  incidents: Incident[];
  recommendations: Recommendation[];
  playbookRuns: PlaybookRun[];
  widgets: Array<Pick<DeviceWidget, "id" | "slug" | "name" | "description" | "status" | "revision" | "updatedAt">>;
}

export async function buildDeviceWidgetContext(deviceId: string): Promise<DeviceWidgetContext | null> {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    return null;
  }

  const [
    state,
    workloads,
    assurances,
    latestAssuranceRuns,
    findings,
    widgets,
  ] = await Promise.all([
    stateStore.getState(),
    Promise.resolve(stateStore.getWorkloads(deviceId)),
    Promise.resolve(stateStore.getAssurances(deviceId)),
    Promise.resolve(stateStore.getLatestAssuranceRuns(deviceId)),
    Promise.resolve(stateStore.getDeviceFindings(deviceId)),
    Promise.resolve(stateStore.getDeviceWidgets(deviceId)),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    device,
    baseline: state.baselines.find((item) => item.deviceId === deviceId) ?? null,
    workloads,
    assurances,
    latestAssuranceRuns,
    findings,
    incidents: state.incidents
      .filter((incident) => incident.deviceIds.includes(deviceId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20),
    recommendations: state.recommendations
      .filter((recommendation) => recommendation.relatedDeviceIds.includes(deviceId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 20),
    playbookRuns: state.playbookRuns
      .filter((run) => run.deviceId === deviceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 20),
    widgets: widgets.map((widget) => ({
      id: widget.id,
      slug: widget.slug,
      name: widget.name,
      description: widget.description,
      status: widget.status,
      revision: widget.revision,
      updatedAt: widget.updatedAt,
    })),
  };
}
