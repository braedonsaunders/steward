"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Shield,
  XCircle,
} from "lucide-react";
import type { PlaybookRun } from "@/lib/state/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { quickSpring } from "@/lib/motion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApprovalCardRun extends PlaybookRun {
  deviceName?: string;
  deviceIp?: string;
}

export interface ApprovalCardProps {
  run: ApprovalCardRun;
  onApprove: (id: string) => void;
  onDeny: (id: string, reason: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTION_CLASS_COLORS: Record<string, string> = {
  A: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  B: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  C: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  D: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
};

function useCountdown(expiresAt: string | undefined): string {
  const [remaining, setRemaining] = useState(() =>
    computeRemaining(expiresAt),
  );

  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => {
      setRemaining(computeRemaining(expiresAt));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return remaining;
}

function computeRemaining(expiresAt: string | undefined): string {
  if (!expiresAt) return "No expiry";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const totalSeconds = Math.floor(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApprovalCard({ run, onApprove, onDeny }: ApprovalCardProps) {
  const countdown = useCountdown(run.expiresAt);
  const reduceMotion = useReducedMotion();
  const [showDenyInput, setShowDenyInput] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const isExpired = countdown === "Expired";

  const handleDeny = () => {
    if (showDenyInput) {
      if (denyReason.trim()) {
        onDeny(run.id, denyReason.trim());
        setDenyReason("");
        setShowDenyInput(false);
      }
    } else {
      setShowDenyInput(true);
    }
  };

  return (
    <motion.div
      layout
      initial={reduceMotion ? undefined : { opacity: 0, y: 10 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={quickSpring}
    >
      <Card className="relative overflow-hidden">
        {/* TTL indicator bar */}
        <motion.div
          className={cn(
            "absolute top-0 left-0 h-1 w-full",
            isExpired
              ? "bg-destructive"
              : countdown.startsWith("0") || !countdown.includes("h")
                ? "bg-amber-500"
                : "bg-emerald-500",
          )}
          layout
          transition={quickSpring}
        />

        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">{run.name}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {run.deviceName ?? run.deviceId}
                {run.deviceIp && (
                  <span className="ml-1.5 font-mono text-xs text-muted-foreground/70">
                    ({run.deviceIp})
                  </span>
                )}
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
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3 pb-3">
          {/* Policy evaluation reason */}
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
            <Shield className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground">
                Policy Evaluation
              </p>
              <p className="mt-0.5 text-sm">{run.policyEvaluation.reason}</p>
            </div>
          </div>

          {/* Countdown */}
          <div className="flex items-center gap-2 text-sm">
            <Clock
              className={cn(
                "h-4 w-4",
                isExpired ? "text-destructive" : "text-muted-foreground",
              )}
            />
            <span
              className={cn(
                "font-mono tabular-nums",
                isExpired && "text-destructive font-medium",
              )}
            >
              {countdown}
            </span>
            <span className="text-muted-foreground">remaining</span>
          </div>

          {/* Incident link */}
          {run.incidentId && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />
              <span>Linked to incident {run.incidentId}</span>
            </div>
          )}

          {/* Deny reason input */}
          <AnimatePresence initial={false}>
            {showDenyInput ? (
              <motion.div
                className="space-y-2"
                initial={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                animate={reduceMotion ? undefined : { height: "auto", opacity: 1 }}
                exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                transition={quickSpring}
              >
                <Textarea
                  placeholder="Reason for denial..."
                  value={denyReason}
                  onChange={(e) => setDenyReason(e.target.value)}
                  className="min-h-[60px]"
                  autoFocus
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </CardContent>

        <CardFooter className="gap-2">
          <Button
            size="sm"
            onClick={() => onApprove(run.id)}
            disabled={isExpired}
          >
            <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
            Approve
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={handleDeny}
            disabled={isExpired || (showDenyInput && !denyReason.trim())}
          >
            <XCircle className="mr-1.5 h-3.5 w-3.5" />
            {showDenyInput ? "Confirm Deny" : "Deny"}
          </Button>
          {showDenyInput && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowDenyInput(false);
                setDenyReason("");
              }}
            >
              Cancel
            </Button>
          )}
        </CardFooter>
      </Card>
    </motion.div>
  );
}
