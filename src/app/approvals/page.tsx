"use client";

import { useMemo, useState } from "react";
import {
  Inbox,
  ShieldCheck,
} from "lucide-react";
import { useSteward } from "@/lib/hooks/use-steward";
import { ApprovalCard } from "@/components/approval-card";
import { PlaybookRunCard } from "@/components/playbook-run-card";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

export default function ApprovalsPage() {
  const {
    pendingApprovals,
    playbookRuns,
    devices,
    loading,
    approveAction,
    denyAction,
  } = useSteward();

  // Build device lookup for card display
  const deviceMap = useMemo(() => {
    const map = new Map<string, { name: string; ip: string }>();
    for (const d of devices) {
      map.set(d.id, { name: d.name, ip: d.ip });
    }
    return map;
  }, [devices]);

  // Recent resolved approvals (approved, denied, completed, failed) - last 20
  const recentResolved = useMemo(() => {
    return playbookRuns
      .filter((r) =>
        ["approved", "denied", "completed", "failed", "quarantined"].includes(
          r.status,
        ),
      )
      .sort(
        (a, b) =>
          new Date(b.completedAt ?? b.createdAt).getTime() -
          new Date(a.completedAt ?? a.createdAt).getTime(),
      )
      .slice(0, 20);
  }, [playbookRuns]);
  const [pendingPage, setPendingPage] = useState(1);
  const [resolvedPage, setResolvedPage] = useState(1);
  const pageSize = 6;

  const pendingTotalPages = Math.max(1, Math.ceil(pendingApprovals.length / pageSize));
  const resolvedTotalPages = Math.max(1, Math.ceil(recentResolved.length / pageSize));
  const currentPendingPage = Math.min(pendingPage, pendingTotalPages);
  const currentResolvedPage = Math.min(resolvedPage, resolvedTotalPages);
  const pagedPending = pendingApprovals.slice((currentPendingPage - 1) * pageSize, currentPendingPage * pageSize);
  const pagedResolved = recentResolved.slice((currentResolvedPage - 1) * pageSize, currentResolvedPage * pageSize);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-6 w-10 rounded-full" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-2xl font-semibold tracking-tight">
          Pending Approvals
        </h1>
        <Badge
          variant={pendingApprovals.length > 0 ? "destructive" : "secondary"}
          className="tabular-nums"
        >
          {pendingApprovals.length}
        </Badge>
      </div>

      <Tabs defaultValue="pending" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="pending">Pending ({pendingApprovals.length})</TabsTrigger>
          <TabsTrigger value="resolved">Recently Resolved ({recentResolved.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="pending" className="mt-4 min-h-0 flex-1 overflow-auto">
          {pendingApprovals.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
                <Inbox className="h-10 w-10 text-muted-foreground/40" />
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    No pending approvals
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    All playbook runs have been resolved. New approvals will appear here when policy requires human review.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                {pagedPending.map((run) => {
                  const device = deviceMap.get(run.deviceId);
                  return (
                    <ApprovalCard
                      key={run.id}
                      run={{
                        ...run,
                        deviceName: device?.name,
                        deviceIp: device?.ip,
                      }}
                      onApprove={approveAction}
                      onDeny={denyAction}
                    />
                  );
                })}
              </div>
              {pendingApprovals.length > pageSize && (
                <div className="flex items-center justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPendingPage((p) => Math.max(1, p - 1))} disabled={currentPendingPage === 1}>Prev</Button>
                  <span className="text-xs text-muted-foreground tabular-nums">Page {currentPendingPage} / {pendingTotalPages}</span>
                  <Button variant="outline" size="sm" onClick={() => setPendingPage((p) => Math.min(pendingTotalPages, p + 1))} disabled={currentPendingPage >= pendingTotalPages}>Next</Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>
        <TabsContent value="resolved" className="mt-4 min-h-0 flex-1 overflow-auto">
          {recentResolved.length > 0 ? (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                {pagedResolved.map((run) => (
                  <PlaybookRunCard key={run.id} run={run} />
                ))}
              </div>
              {recentResolved.length > pageSize && (
                <div className="flex items-center justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setResolvedPage((p) => Math.max(1, p - 1))} disabled={currentResolvedPage === 1}>Prev</Button>
                  <span className="text-xs text-muted-foreground tabular-nums">Page {currentResolvedPage} / {resolvedTotalPages}</span>
                  <Button variant="outline" size="sm" onClick={() => setResolvedPage((p) => Math.min(resolvedTotalPages, p + 1))} disabled={currentResolvedPage >= resolvedTotalPages}>Next</Button>
                </div>
              )}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No resolved runs yet.
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
