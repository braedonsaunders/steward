"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  RotateCcw,
  SkipForward,
  XCircle,
} from "lucide-react";
import type {
  PlaybookRun,
  PlaybookRunStatus,
  PlaybookStep,
  PlaybookStepStatus,
} from "@/lib/state/types";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { quickSpring } from "@/lib/motion";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTION_CLASS_COLORS: Record<string, string> = {
  A: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  B: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  C: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  D: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
};

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
    case "executing":
    case "preflight":
    case "verifying":
    case "rolling_back":
      return "secondary";
    default:
      return "outline";
  }
}

function statusLabel(status: PlaybookRunStatus): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function StepStatusIcon({ status }: { status: PlaybookStepStatus }) {
  switch (status) {
    case "passed":
      return <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />;
    case "skipped":
      return <SkipForward className="h-4 w-4 text-muted-foreground" />;
    case "rolled_back":
      return <RotateCcw className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function StepList({ steps, title }: { steps: PlaybookStep[]; title: string }) {
  if (steps.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="space-y-1">
        {steps.map((step) => (
          <div
            key={step.id}
            className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2"
          >
            <StepStatusIcon status={step.status} />
            <span className="flex-1 text-sm">{step.label}</span>
            <Badge variant="outline" className="text-[10px] font-normal">
              {step.status}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PlaybookRunCardProps {
  run: PlaybookRun;
}

export function PlaybookRunCard({ run }: PlaybookRunCardProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      layout
      initial={reduceMotion ? undefined : { opacity: 0, y: 10 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={quickSpring}
    >
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">{run.name}</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {run.family} &middot; Device {run.deviceId}
                {run.incidentId && <> &middot; Incident {run.incidentId}</>}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                className={cn(
                  "border font-mono text-[11px]",
                  ACTION_CLASS_COLORS[run.actionClass] ?? "",
                )}
              >
                Class {run.actionClass}
              </Badge>
              <Badge variant={statusBadgeVariant(run.status)}>
                {statusLabel(run.status)}
              </Badge>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Steps */}
          <StepList steps={run.steps} title="Execution Steps" />
          <StepList steps={run.verificationSteps} title="Verification Steps" />
          <StepList steps={run.rollbackSteps} title="Rollback Steps" />

          {/* Evidence log (collapsible) */}
          {run.evidence.logs.length > 0 && (
            <div>
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setEvidenceOpen(!evidenceOpen)}
              >
                {evidenceOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Evidence Log ({run.evidence.logs.length} entries)
              </button>
              <AnimatePresence initial={false}>
                {evidenceOpen ? (
                  <motion.div
                    initial={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                    animate={reduceMotion ? undefined : { height: "auto", opacity: 1 }}
                    exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                    transition={quickSpring}
                  >
                    <ScrollArea className="mt-2 max-h-48 rounded-md border bg-muted/30 p-3">
                      <div className="space-y-1">
                        {run.evidence.logs.map((log, idx) => (
                          <p
                            key={idx}
                            className="font-mono text-xs text-muted-foreground"
                          >
                            {log}
                          </p>
                        ))}
                      </div>
                    </ScrollArea>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          )}

          {/* Timing info */}
          <Separator />
          <div className="grid grid-cols-3 gap-4 text-xs">
            <div>
              <p className="font-medium text-muted-foreground">Created</p>
              <p className="mt-0.5 tabular-nums">{formatTimestamp(run.createdAt)}</p>
            </div>
            <div>
              <p className="font-medium text-muted-foreground">Started</p>
              <p className="mt-0.5 tabular-nums">{formatTimestamp(run.startedAt)}</p>
            </div>
            <div>
              <p className="font-medium text-muted-foreground">Completed</p>
              <p className="mt-0.5 tabular-nums">{formatTimestamp(run.completedAt)}</p>
            </div>
          </div>

          {/* Approval / Denial metadata */}
          {run.approvedBy && (
            <p className="text-xs text-muted-foreground">
              Approved by <span className="font-medium text-foreground">{run.approvedBy}</span>
              {run.approvedAt && <> at {formatTimestamp(run.approvedAt)}</>}
            </p>
          )}
          {run.deniedBy && (
            <p className="text-xs text-muted-foreground">
              Denied by <span className="font-medium text-destructive">{run.deniedBy}</span>
              {run.deniedAt && <> at {formatTimestamp(run.deniedAt)}</>}
              {run.denialReason && (
                <>
                  {" "}
                  &mdash; <em>{run.denialReason}</em>
                </>
              )}
            </p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
