"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Server,
  Shield,
  XCircle,
} from "lucide-react";
import { useSteward } from "@/lib/hooks/use-steward";
import type {
  ChatMessagePlaybookRunLink,
  PlaybookRun,
  PlaybookRunStatus,
  PlaybookStep,
  PolicyDecision,
} from "@/lib/state/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

function statusBadgeVariant(
  status: PlaybookRunStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed":
      return "default";
    case "failed":
    case "quarantined":
    case "denied":
      return "destructive";
    case "approved":
    case "preflight":
    case "executing":
    case "waiting":
    case "verifying":
    case "rolling_back":
      return "secondary";
    default:
      return "outline";
  }
}

function statusLabel(status: PlaybookRunStatus): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function decisionBadgeVariant(
  decision: PolicyDecision,
): "default" | "secondary" | "destructive" | "outline" {
  switch (decision) {
    case "ALLOW_AUTO":
      return "default";
    case "REQUIRE_APPROVAL":
      return "secondary";
    case "DENY":
      return "destructive";
    default:
      return "outline";
  }
}

function decisionLabel(decision: PolicyDecision): string {
  switch (decision) {
    case "ALLOW_AUTO":
      return "Auto Allow";
    case "REQUIRE_APPROVAL":
      return "Require Approval";
    case "DENY":
      return "Deny";
    default:
      return decision;
  }
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) {
    return "--";
  }

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "--";
  }

  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function findCurrentStep(run: PlaybookRun): PlaybookStep | null {
  const phaseSteps = run.status === "rolling_back"
    ? [run.rollbackSteps]
    : run.status === "verifying"
      ? [run.verificationSteps, run.steps]
      : [run.steps, run.verificationSteps, run.rollbackSteps];

  for (const stepList of phaseSteps) {
    const current = stepList.find((step) => step.status === "running" || step.status === "waiting");
    if (current) {
      return current;
    }
  }

  for (const stepList of phaseSteps) {
    const next = stepList.find((step) => step.status === "pending");
    if (next) {
      return next;
    }
  }

  return null;
}

function buildProgressSummary(run: PlaybookRun): string {
  const allSteps = [...run.steps, ...run.verificationSteps, ...run.rollbackSteps];
  if (allSteps.length === 0) {
    return "No step details available yet.";
  }

  const completeCount = allSteps.filter((step) => (
    step.status === "passed" || step.status === "skipped" || step.status === "rolled_back"
  )).length;

  const current = findCurrentStep(run);
  if (current) {
    const prefix = current.status === "pending" ? "Next step" : "Current step";
    return `${completeCount}/${allSteps.length} steps complete. ${prefix}: ${current.label}.`;
  }

  return `${completeCount}/${allSteps.length} steps complete.`;
}

export interface ChatPlaybookRunWidgetProps {
  runLink: ChatMessagePlaybookRunLink;
}

export function ChatPlaybookRunWidget({ runLink }: ChatPlaybookRunWidgetProps) {
  const {
    playbookRuns,
    devices,
    approveAction,
    denyAction,
  } = useSteward();
  const [denyMode, setDenyMode] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);

  const run = useMemo(
    () => playbookRuns.find((candidate) => candidate.id === runLink.runId),
    [playbookRuns, runLink.runId],
  );
  const device = useMemo(
    () => devices.find((candidate) => candidate.id === (run?.deviceId ?? runLink.deviceId)),
    [devices, run?.deviceId, runLink.deviceId],
  );

  const status = run?.status ?? runLink.status;
  const waitingState = run?.evidence.waiting;
  const canApprove = run?.status === "pending_approval";
  const deviceLabel = device?.name ?? run?.deviceId ?? runLink.deviceId;
  const deviceHref = `/devices/${encodeURIComponent(run?.deviceId ?? runLink.deviceId)}`;
  const jobsHref = `/jobs?run=${encodeURIComponent(runLink.runId)}`;

  const handleApprove = async () => {
    if (!run) {
      return;
    }
    setSubmitting("approve");
    try {
      await approveAction(run.id);
    } finally {
      setSubmitting(null);
    }
  };

  const handleDeny = async () => {
    if (!run || !denyReason.trim()) {
      return;
    }
    setSubmitting("deny");
    try {
      await denyAction(run.id, denyReason.trim());
      setDenyReason("");
      setDenyMode(false);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Card className="overflow-hidden border-primary/15 bg-muted/20 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Job
            </p>
            <CardTitle className="mt-1 text-base">
              {run?.name ?? "Durable playbook run"}
            </CardTitle>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5" />
                {deviceLabel}
                {device?.ip && (
                  <span className="font-mono text-[11px] text-muted-foreground/70">
                    {device.ip}
                  </span>
                )}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Updated {formatTimestamp(run?.updatedAt ?? run?.startedAt ?? run?.createdAt)}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {run && (
              <Badge
                className={cn(
                  "border font-mono text-[11px]",
                  run.actionClass === "A" && "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
                  run.actionClass === "B" && "border-blue-500/30 bg-blue-500/15 text-blue-700 dark:text-blue-400",
                  run.actionClass === "C" && "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400",
                  run.actionClass === "D" && "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-400",
                )}
              >
                Class {run.actionClass}
              </Badge>
            )}
            <Badge variant={statusBadgeVariant(status)}>{statusLabel(status)}</Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {run && (
          <div className="rounded-md border bg-background/70 px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Shield className="h-3.5 w-3.5" />
                Policy
              </span>
              <Badge variant={decisionBadgeVariant(run.policyEvaluation.decision)}>
                {decisionLabel(run.policyEvaluation.decision)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Risk {run.policyEvaluation.riskScore.toFixed(2)}
              </span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{run.policyEvaluation.reason}</p>
          </div>
        )}

        {waitingState ? (
          <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2.5 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{waitingState.label}</p>
            <p className="mt-1">{waitingState.reason}</p>
            <p className="mt-1 text-xs">
              Next wake: <span className="tabular-nums">{formatTimestamp(waitingState.nextWakeAt)}</span>
            </p>
          </div>
        ) : run ? (
          <div className="rounded-md border bg-background/70 px-3 py-2.5 text-sm text-muted-foreground">
            {buildProgressSummary(run)}
          </div>
        ) : (
          <div className="rounded-md border bg-background/70 px-3 py-2.5 text-sm text-muted-foreground">
            Steward created the job and is waiting for the latest run state to load.
          </div>
        )}

        {run && (run.status === "failed" || run.status === "quarantined") && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="font-medium text-foreground">Job needs attention</p>
              <p className="mt-1">
                Open the job to review evidence, failed steps, and rollback state.
              </p>
            </div>
          </div>
        )}

        {canApprove && denyMode && (
          <Textarea
            value={denyReason}
            onChange={(event) => setDenyReason(event.target.value)}
            placeholder="Reason for denial..."
            className="min-h-[76px] bg-background/80"
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          {canApprove && (
            <Button size="sm" onClick={handleApprove} disabled={submitting !== null}>
              {submitting === "approve" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              Approve
            </Button>
          )}
          {canApprove && (
            denyMode ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={handleDeny}
                  disabled={submitting !== null || !denyReason.trim()}
                >
                  {submitting === "deny" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                  Confirm Deny
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDenyMode(false);
                    setDenyReason("");
                  }}
                  disabled={submitting !== null}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDenyMode(true)}
                disabled={submitting !== null}
              >
                <XCircle className="h-3.5 w-3.5" />
                Deny
              </Button>
            )
          )}
          <Button asChild size="sm" variant="outline">
            <Link href={jobsHref}>
              <ExternalLink className="h-3.5 w-3.5" />
              Open Job
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={deviceHref}>Open Device</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
