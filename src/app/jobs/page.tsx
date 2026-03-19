"use client";

import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  Inbox,
} from "lucide-react";
import { useSteward } from "@/lib/hooks/use-steward";
import {
  bucketPlaybookRuns,
  countOpenJobs,
  jobsTabForStatus,
  type JobsTabValue,
} from "@/lib/jobs";
import type { PlaybookRun } from "@/lib/state/types";
import { ApprovalCard } from "@/components/approval-card";
import { PlaybookRunCard } from "@/components/playbook-run-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function isJobsTabValue(value: string | null): value is JobsTabValue {
  return value === "active"
    || value === "waiting"
    || value === "pending"
    || value === "attention"
    || value === "history";
}

function EmptyState({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Inbox className="h-10 w-10 text-muted-foreground/35" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="max-w-xl text-xs text-muted-foreground/70">{body}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function JobsStatCard({
  title,
  count,
  description,
}: {
  title: string;
  count: number;
  description: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">{count}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function RunGrid({
  runs,
  deviceMap,
  selectedRunId,
}: {
  runs: PlaybookRun[];
  deviceMap: Map<string, { name: string; ip: string }>;
  selectedRunId?: string;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {runs.map((run) => {
        const device = deviceMap.get(run.deviceId);
        return (
          <PlaybookRunCard
            key={run.id}
            run={run}
            deviceName={device?.name}
            deviceIp={device?.ip}
            className={run.id === selectedRunId ? "border-primary/40 ring-2 ring-primary/20" : undefined}
          />
        );
      })}
    </div>
  );
}

export default function JobsPage() {
  return (
    <Suspense fallback={<JobsPageSkeleton />}>
      <JobsPageContent />
    </Suspense>
  );
}

function JobsPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-6 w-12 rounded-full" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[1, 2, 3, 4].map((index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-[480px]" />
    </div>
  );
}

function JobsPageContent() {
  const {
    approveAction,
    denyAction,
    devices,
    loading,
    pendingApprovals,
    playbookRuns,
  } = useSteward();
  const searchParams = useSearchParams();
  const selectedRunId = searchParams.get("run") ?? undefined;
  const [manualTab, setManualTab] = useState<JobsTabValue>("active");

  const deviceMap = useMemo(() => {
    const next = new Map<string, { name: string; ip: string }>();
    for (const device of devices) {
      next.set(device.id, {
        name: device.name,
        ip: device.ip,
      });
    }
    return next;
  }, [devices]);

  const buckets = useMemo(() => bucketPlaybookRuns(playbookRuns), [playbookRuns]);
  const currentTab = useMemo(() => {
    const requestedView = searchParams.get("view");
    if (isJobsTabValue(requestedView)) {
      return requestedView;
    }

    if (!selectedRunId) {
      return manualTab;
    }

    const selectedRun = playbookRuns.find((run) => run.id === selectedRunId);
    if (selectedRun) {
      return jobsTabForStatus(selectedRun.status);
    }

    return manualTab;
  }, [manualTab, playbookRuns, searchParams, selectedRunId]);

  if (loading) {
    return (
      <JobsPageSkeleton />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Activity className="h-6 w-6 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight steward-heading-font">Jobs</h1>
            <Badge variant={countOpenJobs(playbookRuns) > 0 ? "secondary" : "outline"} className="tabular-nums">
              {countOpenJobs(playbookRuns)}
            </Badge>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Durable playbook runs started from chat, incidents, or operator actions. Use this view for active work, waiting checkpoints, approvals, failures, and recent history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/policies">Open Policies</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <JobsStatCard
          title="Active"
          count={buckets.active.length}
          description="Queued, executing, verifying, or rolling back."
        />
        <JobsStatCard
          title="Waiting"
          count={buckets.waiting.length}
          description="Paused on a condition and scheduled to resume."
        />
        <JobsStatCard
          title="Pending Approval"
          count={pendingApprovals.length}
          description="Blocked on operator approval before execution."
        />
        <JobsStatCard
          title="Needs Attention"
          count={buckets.attention.length}
          description="Failed or quarantined runs that need review."
        />
      </div>

      <Tabs value={currentTab} onValueChange={(value) => setManualTab(value as JobsTabValue)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="active">
            Active ({buckets.active.length})
          </TabsTrigger>
          <TabsTrigger value="waiting">
            Waiting ({buckets.waiting.length})
          </TabsTrigger>
          <TabsTrigger value="pending">
            Pending ({pendingApprovals.length})
          </TabsTrigger>
          <TabsTrigger value="attention">
            Attention ({buckets.attention.length})
          </TabsTrigger>
          <TabsTrigger value="history">
            History ({buckets.history.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="mt-4 min-h-0 flex-1 overflow-auto">
          {buckets.active.length > 0 ? (
            <RunGrid runs={buckets.active} deviceMap={deviceMap} selectedRunId={selectedRunId} />
          ) : (
            <EmptyState
              title="No active jobs"
              body="New durable work launched from chat or incidents will appear here as soon as it is approved or starts running."
            />
          )}
        </TabsContent>

        <TabsContent value="waiting" className="mt-4 min-h-0 flex-1 overflow-auto">
          {buckets.waiting.length > 0 ? (
            <RunGrid runs={buckets.waiting} deviceMap={deviceMap} selectedRunId={selectedRunId} />
          ) : (
            <EmptyState
              title="No waiting jobs"
              body="Long-running jobs that are paused on a background condition, maintenance checkpoint, or scheduled wake-up will show up here."
            />
          )}
        </TabsContent>

        <TabsContent value="pending" className="mt-4 min-h-0 flex-1 overflow-auto">
          {pendingApprovals.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {pendingApprovals.map((run) => {
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
          ) : (
            <EmptyState
              title="No pending approvals"
              body="Approval-gated jobs are clear. When policy gates a remediation or upgrade, it will appear here."
            />
          )}
        </TabsContent>

        <TabsContent value="attention" className="mt-4 min-h-0 flex-1 overflow-auto">
          {buckets.attention.length > 0 ? (
            <RunGrid runs={buckets.attention} deviceMap={deviceMap} selectedRunId={selectedRunId} />
          ) : (
            <EmptyState
              title="No jobs need attention"
              body="Failed and quarantined runs will surface here with evidence and rollback detail when Steward needs operator review."
            />
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4 min-h-0 flex-1 overflow-auto">
          {buckets.history.length > 0 ? (
            <RunGrid runs={buckets.history} deviceMap={deviceMap} selectedRunId={selectedRunId} />
          ) : (
            <EmptyState
              title="No job history yet"
              body="Completed and denied runs will accumulate here once the first durable job finishes or is rejected."
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
