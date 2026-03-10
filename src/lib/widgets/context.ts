import { stateStore } from "@/lib/state/store";
import { getHttpApiCredentialAuth } from "@/lib/credentials/http-api";
import type {
  AccessMethod,
  Assurance,
  AssuranceRun,
  Device,
  DeviceBaseline,
  DeviceCredentialStatus,
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
  credentials: Array<{
    protocol: string;
    adapterId?: string;
    status: DeviceCredentialStatus;
    accountLabel?: string;
    lastValidatedAt?: string;
    updatedAt: string;
    scope: {
      level?: string;
      operations: string[];
    };
    auth?: {
      mode: string;
      headerName?: string;
      queryParamName?: string;
      pathPrefix?: string;
      appliedBySteward: boolean;
    };
  }>;
  accessMethods: Array<Pick<
    AccessMethod,
    "key" | "kind" | "title" | "protocol" | "port" | "secure" | "selected" | "status" | "credentialProtocol" | "summary"
  >>;
  baseline: DeviceBaseline | null;
  workloads: Workload[];
  assurances: Assurance[];
  latestAssuranceRuns: AssuranceRun[];
  findings: DeviceFinding[];
  incidents: Incident[];
  recommendations: Recommendation[];
  playbookRuns: PlaybookRun[];
  widgets: Array<
    Pick<DeviceWidget, "id" | "slug" | "name" | "description" | "status" | "revision" | "updatedAt">
    & {
      controlCount: number;
      controls: Array<Pick<DeviceWidget["controls"][number], "id" | "label" | "kind">>;
    }
  >;
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
    credentials,
    accessMethods,
    widgets,
  ] = await Promise.all([
    stateStore.getState(),
    Promise.resolve(stateStore.getWorkloads(deviceId)),
    Promise.resolve(stateStore.getAssurances(deviceId)),
    Promise.resolve(stateStore.getLatestAssuranceRuns(deviceId)),
    Promise.resolve(stateStore.getDeviceFindings(deviceId)),
    Promise.resolve(stateStore.getDeviceCredentials(deviceId)),
    Promise.resolve(stateStore.getAccessMethods(deviceId)),
    Promise.resolve(stateStore.getDeviceWidgets(deviceId)),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    device,
    credentials: credentials.map((credential) => {
      const auth = credential.protocol.toLowerCase() === "http-api"
        ? getHttpApiCredentialAuth(credential.scopeJson)
        : null;

      return {
        protocol: credential.protocol,
        adapterId: credential.adapterId,
        status: credential.status,
        accountLabel: credential.accountLabel,
        lastValidatedAt: credential.lastValidatedAt,
        updatedAt: credential.updatedAt,
        scope: {
          level: typeof credential.scopeJson.level === "string" ? credential.scopeJson.level : undefined,
          operations: Array.isArray(credential.scopeJson.operations)
            ? credential.scopeJson.operations
              .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            : [],
        },
        auth: auth
          ? {
            mode: auth.mode,
            headerName: auth.headerName,
            queryParamName: auth.queryParamName,
            pathPrefix: auth.pathPrefix,
            appliedBySteward: true,
          }
          : undefined,
      };
    }),
    accessMethods: accessMethods.map((method) => ({
      key: method.key,
      kind: method.kind,
      title: method.title,
      protocol: method.protocol,
      port: method.port,
      secure: method.secure,
      selected: method.selected,
      status: method.status,
      credentialProtocol: method.credentialProtocol,
      summary: method.summary,
    })),
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
      controlCount: widget.controls.length,
      controls: widget.controls.map((control) => ({
        id: control.id,
        label: control.label,
        kind: control.kind,
      })),
    })),
  };
}
