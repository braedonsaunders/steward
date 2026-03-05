"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Clock,
  Lightbulb,
  Monitor,
  MonitorOff,
  Play,
  Shield,
  ShieldCheck,
} from "lucide-react";
import type { DailyDigest } from "@/lib/state/types";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { fadeUpItemVariants, staggerContainerVariants } from "@/lib/motion";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityVariant(
  severity: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (severity) {
    case "critical":
      return "destructive";
    case "warning":
      return "secondary";
    default:
      return "outline";
  }
}

function priorityVariant(
  priority: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (priority) {
    case "high":
      return "destructive";
    case "medium":
      return "secondary";
    default:
      return "outline";
  }
}

function riskTypeBadge(type: string): string {
  switch (type) {
    case "cert-expiry":
      return "Certificate";
    case "backup-failure":
      return "Backup";
    case "firmware-vuln":
      return "Firmware";
    default:
      return "Other";
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DigestViewProps {
  digest: DailyDigest;
}

export function DigestView({ digest }: DigestViewProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className="space-y-6"
      variants={reduceMotion ? undefined : staggerContainerVariants}
      initial={reduceMotion ? undefined : "initial"}
      animate={reduceMotion ? undefined : "animate"}
    >
      {/* Period */}
      <motion.p className="text-sm text-muted-foreground" variants={reduceMotion ? undefined : fadeUpItemVariants}>
        Period: {formatDate(digest.periodStart)} &mdash;{" "}
        {formatDate(digest.periodEnd)}
      </motion.p>

      {/* Stats row */}
      <motion.div className="grid grid-cols-2 gap-3 sm:grid-cols-4" variants={reduceMotion ? undefined : fadeUpItemVariants}>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10">
              <Monitor className="h-4.5 w-4.5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-xl font-semibold tabular-nums">
                {digest.stats.devicesOnline}
              </p>
              <p className="text-[11px] text-muted-foreground">Online</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10">
              <MonitorOff className="h-4.5 w-4.5 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <p className="text-xl font-semibold tabular-nums">
                {digest.stats.devicesOffline}
              </p>
              <p className="text-[11px] text-muted-foreground">Offline</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10">
              <AlertTriangle className="h-4.5 w-4.5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-xl font-semibold tabular-nums">
                {digest.stats.incidentsOpened}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Incidents Opened
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10">
              <Play className="h-4.5 w-4.5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-xl font-semibold tabular-nums">
                {digest.stats.playbooksRun}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Playbooks ({digest.stats.playbooksSucceeded} ok)
              </p>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Overnight Incidents */}
      <motion.div variants={reduceMotion ? undefined : fadeUpItemVariants}>
        <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4" />
            Overnight Incidents
            <Badge variant="secondary" className="ml-1 tabular-nums">
              {digest.overnightIncidents.length}
            </Badge>
          </CardTitle>
          <CardDescription>
            Incidents detected during the reporting period
          </CardDescription>
        </CardHeader>
        <CardContent>
          {digest.overnightIncidents.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No incidents during this period.
            </p>
          ) : (
            <div className="space-y-2">
              {digest.overnightIncidents.map((incident) => (
                <div
                  key={incident.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{incident.title}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant={severityVariant(incident.severity)} className="text-[10px]">
                        {incident.severity}
                      </Badge>
                      <span className="text-xs text-muted-foreground capitalize">
                        {incident.status}
                      </span>
                      {incident.autoRemediated && (
                        <Badge variant="outline" className="text-[10px]">
                          <ShieldCheck className="mr-1 h-3 w-3" />
                          Auto-remediated
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
        </Card>
      </motion.div>

      {/* New Risks */}
      <motion.div variants={reduceMotion ? undefined : fadeUpItemVariants}>
        <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" />
            New Risks
            <Badge variant="secondary" className="ml-1 tabular-nums">
              {digest.newRisks.length}
            </Badge>
          </CardTitle>
          <CardDescription>
            Newly identified risks requiring attention
          </CardDescription>
        </CardHeader>
        <CardContent>
          {digest.newRisks.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No new risks identified.
            </p>
          ) : (
            <div className="space-y-2">
              {digest.newRisks.map((risk, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {riskTypeBadge(risk.type)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {risk.deviceIds.length} device
                        {risk.deviceIds.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <p className="mt-1 text-sm">{risk.description}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
        </Card>
      </motion.div>

      {/* Pending Approvals */}
      <motion.div variants={reduceMotion ? undefined : fadeUpItemVariants}>
        <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" />
            Pending Approvals
            <Badge variant="secondary" className="ml-1 tabular-nums">
              {digest.pendingApprovals.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {digest.pendingApprovals.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No pending approvals.
            </p>
          ) : (
            <div className="space-y-2">
              {digest.pendingApprovals.map((approval) => (
                <div
                  key={approval.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <p className="text-sm">{approval.summary}</p>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Expires {formatDate(approval.expiresAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
        </Card>
      </motion.div>

      {/* Top Recommendations */}
      <motion.div variants={reduceMotion ? undefined : fadeUpItemVariants}>
        <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4" />
            Top Recommendations
            <Badge variant="secondary" className="ml-1 tabular-nums">
              {digest.topRecommendations.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {digest.topRecommendations.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No recommendations at this time.
            </p>
          ) : (
            <div className="space-y-2">
              {digest.topRecommendations.map((rec) => (
                <div
                  key={rec.id}
                  className="rounded-md border p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">{rec.title}</p>
                    <Badge
                      variant={priorityVariant(rec.priority)}
                      className="shrink-0 text-[10px]"
                    >
                      {rec.priority}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {rec.impact}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
