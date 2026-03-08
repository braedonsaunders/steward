import { z } from "zod";
import { interpolateOperationValue } from "@/lib/adapters/execution-template";
import { stateStore } from "@/lib/state/store";
import type {
  Device,
  DeviceWidget,
  DeviceWidgetControl,
  DeviceWidgetControlParameter,
  DeviceWidgetControlResult,
} from "@/lib/state/types";
import type { WidgetOperationInput } from "@/lib/widgets/operations";
import { WidgetOperationSchema, executeWidgetOperation } from "@/lib/widgets/operations";

const ScalarValueSchema = z.union([z.string(), z.number(), z.boolean()]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function slugifyControlToken(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized.length > 0 ? normalized : undefined;
}

function humanizeControlToken(value: string): string {
  return value
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeWidgetControlParameterInput(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const explicitKey = readNonEmptyString(value.key)
    ?? readNonEmptyString(value.name)
    ?? readNonEmptyString(value.id)
    ?? readNonEmptyString(value.paramKey)
    ?? readNonEmptyString(value.parameterKey);
  const label = readNonEmptyString(value.label)
    ?? readNonEmptyString(value.title)
    ?? readNonEmptyString(value.name);
  const derivedKey = explicitKey
    ? slugifyControlToken(explicitKey)
    : label
      ? slugifyControlToken(label)
      : undefined;

  return {
    ...value,
    key: derivedKey ?? value.key,
    label: label ?? (derivedKey ? humanizeControlToken(derivedKey) : value.label),
  };
}

export const DeviceWidgetControlOptionSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
});

export const DeviceWidgetControlParameterSchema = z.preprocess(
  normalizeWidgetControlParameterInput,
  z.object({
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(80),
    description: z.string().max(240).optional(),
    type: z.enum(["string", "number", "boolean", "enum"]),
    required: z.boolean().optional(),
    defaultValue: ScalarValueSchema.optional(),
    placeholder: z.string().max(120).optional(),
    options: z.array(DeviceWidgetControlOptionSchema).max(20).optional(),
  }).superRefine((value, ctx) => {
    if (value.type === "enum" && (!value.options || value.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "enum controls require at least one option",
      });
    }
  }),
);

export const DeviceWidgetControlExecutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("operation"),
    operation: WidgetOperationSchema,
  }),
  z.object({
    kind: z.literal("state"),
    patch: z.record(z.string(), z.unknown()),
    mergeStrategy: z.enum(["deep-merge", "replace"]).optional(),
  }),
]);

export const DeviceWidgetControlSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
  kind: z.enum(["button", "toggle", "select", "form"]),
  parameters: z.array(DeviceWidgetControlParameterSchema).max(12).default([]),
  execution: DeviceWidgetControlExecutionSchema,
  confirmation: z.string().max(240).optional(),
  successMessage: z.string().max(240).optional(),
  danger: z.boolean().optional(),
});

export const DeviceWidgetControlListSchema = z.array(DeviceWidgetControlSchema).max(40);

function normalizeScalarValue(
  raw: unknown,
  parameter: DeviceWidgetControlParameter,
): string | number | boolean | undefined {
  if (typeof raw === "undefined") {
    return undefined;
  }

  if (parameter.type === "string") {
    if (typeof raw !== "string") {
      throw new Error(`${parameter.label} must be a string.`);
    }
    return raw;
  }

  if (parameter.type === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === "string" && raw.trim().length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    throw new Error(`${parameter.label} must be a number.`);
  }

  if (parameter.type === "boolean") {
    if (typeof raw === "boolean") {
      return raw;
    }
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
    throw new Error(`${parameter.label} must be true or false.`);
  }

  if (typeof raw !== "string") {
    throw new Error(`${parameter.label} must be one of the allowed options.`);
  }

  const options = parameter.options ?? [];
  if (!options.some((option) => option.value === raw)) {
    throw new Error(`${parameter.label} must be one of: ${options.map((option) => option.value).join(", ")}.`);
  }
  return raw;
}

function resolveControlValues(
  control: DeviceWidgetControl,
  inputValues: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const resolved: Record<string, string | number | boolean> = {};
  const providedKeys = new Set(Object.keys(inputValues ?? {}));

  for (const parameter of control.parameters) {
    const raw = inputValues && Object.prototype.hasOwnProperty.call(inputValues, parameter.key)
      ? inputValues[parameter.key]
      : parameter.defaultValue;
    const normalized = normalizeScalarValue(raw, parameter);
    if (typeof normalized === "undefined") {
      if (parameter.required) {
        throw new Error(`${parameter.label} is required.`);
      }
      continue;
    }
    resolved[parameter.key] = normalized;
    providedKeys.delete(parameter.key);
  }

  if (providedKeys.size > 0) {
    throw new Error(`Unknown control input: ${Array.from(providedKeys).join(", ")}.`);
  }

  return resolved;
}

function scalarParamsAsStrings(
  values: Record<string, string | number | boolean>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  );
}

function interpolateStructuredValue(
  value: unknown,
  host: string,
  params: Record<string, string | number | boolean>,
): unknown {
  const paramsAsStrings = scalarParamsAsStrings(params);

  if (typeof value === "string") {
    const exact = value.match(/^\{\{([a-zA-Z0-9_]+)\}\}$/);
    if (exact) {
      const exactValue = params[exact[1]];
      if (typeof exactValue !== "undefined") {
        return exactValue;
      }
      if (exact[1] === "host") {
        return host;
      }
    }
    return interpolateOperationValue(value, host, paramsAsStrings);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => interpolateStructuredValue(entry, host, params));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateStructuredValue(entry, host, params)]),
    );
  }

  return value;
}

function deepMergeRecords(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(next[key])) {
      next[key] = deepMergeRecords(next[key] as Record<string, unknown>, value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function getWidgetControl(widget: DeviceWidget, controlId: string): DeviceWidgetControl | null {
  return widget.controls.find((control) => control.id === controlId) ?? null;
}

export async function executeWidgetControl(args: {
  device: Device;
  widget: DeviceWidget;
  control: DeviceWidgetControl;
  inputValues?: Record<string, unknown>;
  approved?: boolean;
  actor?: "steward" | "user";
}): Promise<DeviceWidgetControlResult> {
  const startedAt = new Date().toISOString();
  const values = resolveControlValues(args.control, args.inputValues);

  if (args.control.execution.kind === "state") {
    const existingState = stateStore.getDeviceWidgetRuntimeState(args.widget.id)?.stateJson ?? {};
    const interpolated = interpolateStructuredValue(
      args.control.execution.patch,
      args.device.ip,
      values,
    );
    if (!isRecord(interpolated)) {
      throw new Error("Widget control state patch must resolve to an object.");
    }
    const nextState = args.control.execution.mergeStrategy === "replace"
      ? interpolated
      : deepMergeRecords(existingState, interpolated);
    const persisted = stateStore.upsertDeviceWidgetRuntimeState({
      widgetId: args.widget.id,
      deviceId: args.device.id,
      stateJson: nextState,
      updatedAt: new Date().toISOString(),
    });
    const completedAt = new Date().toISOString();
    const result: DeviceWidgetControlResult = {
      ok: true,
      status: "succeeded",
      summary: args.control.successMessage ?? `${args.control.label} updated ${args.widget.name}.`,
      widgetId: args.widget.id,
      widgetName: args.widget.name,
      controlId: args.control.id,
      controlLabel: args.control.label,
      executionKind: "state",
      approvalRequired: false,
      approved: true,
      details: {
        values,
        mergeStrategy: args.control.execution.mergeStrategy ?? "deep-merge",
      },
      stateJson: persisted.stateJson,
      startedAt,
      completedAt,
    };
    await stateStore.addAction({
      actor: args.actor ?? "steward",
      kind: "config",
      message: `Widget control ${args.control.label} on ${args.widget.name}: ${result.summary}`,
      context: {
        deviceId: args.device.id,
        widgetId: args.widget.id,
        controlId: args.control.id,
        executionKind: "state",
      },
    });
    return result;
  }

  const operation = args.control.execution.operation;
  const operationInput: WidgetOperationInput = {
    mode: operation.mode,
    kind: operation.kind,
    adapterId: operation.adapterId,
    timeoutMs: operation.timeoutMs,
    commandTemplate: operation.commandTemplate,
    brokerRequest: operation.brokerRequest as WidgetOperationInput["brokerRequest"],
    args: {
      ...(operation.args ?? {}),
      ...values,
    },
    expectedSemanticTarget: operation.expectedSemanticTarget,
  };

  const operationResult = await executeWidgetOperation({
    device: args.device,
    widget: args.widget,
    input: operationInput,
    approved: args.approved === true,
  });
  const completedAt = new Date().toISOString();

  const result: DeviceWidgetControlResult = {
    ok: operationResult.ok,
    status: operationResult.ok && operationResult.status === "succeeded" && args.control.successMessage
      ? "succeeded"
      : operationResult.status,
    summary: operationResult.ok && args.control.successMessage
      ? args.control.successMessage
      : operationResult.summary,
    widgetId: args.widget.id,
    widgetName: args.widget.name,
    controlId: args.control.id,
    controlLabel: args.control.label,
    executionKind: "operation",
    approvalRequired: operationResult.approvalRequired,
    approved: operationResult.approved,
    details: {
      values,
      operationKind: operation.kind,
      brokerProtocol: operationResult.details.protocol,
    },
    operationResult,
    startedAt,
    completedAt,
  };
  await stateStore.addAction({
    actor: args.actor ?? "steward",
    kind: "config",
    message: `Widget control ${args.control.label} on ${args.widget.name}: ${result.summary}`,
    context: {
      deviceId: args.device.id,
      widgetId: args.widget.id,
      controlId: args.control.id,
      executionKind: "operation",
      operationStatus: operationResult.status,
    },
  });
  return result;
}
