import { randomUUID } from "node:crypto";

export interface SagaStep<TContext = Record<string, unknown>> {
  id: string;
  execute: (ctx: TContext) => Promise<void>;
  compensate?: (ctx: TContext) => Promise<void>;
}

export interface SagaRunResult {
  id: string;
  ok: boolean;
  executedSteps: string[];
  compensatedSteps: string[];
  error?: string;
}

export async function runSaga<TContext>(steps: SagaStep<TContext>[], context: TContext): Promise<SagaRunResult> {
  const runId = randomUUID();
  const executed: SagaStep<TContext>[] = [];
  const compensated: string[] = [];

  try {
    for (const step of steps) {
      await step.execute(context);
      executed.push(step);
    }

    return {
      id: runId,
      ok: true,
      executedSteps: executed.map((step) => step.id),
      compensatedSteps: compensated,
    };
  } catch (error) {
    for (const step of executed.slice().reverse()) {
      if (!step.compensate) continue;
      try {
        await step.compensate(context);
        compensated.push(step.id);
      } catch {
        // Best-effort compensation.
      }
    }

    return {
      id: runId,
      ok: false,
      executedSteps: executed.map((step) => step.id),
      compensatedSteps: compensated,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
