"use client";

import { useEffect, useState } from "react";
import { Bot, Loader2, RefreshCw, Search } from "lucide-react";
import { fetchClientJson } from "@/lib/autonomy/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

interface SubagentItem {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused" | "disabled";
  scopeJson: {
    domain: string;
  };
  autonomyJson: {
    approvalMode: string;
    channelVoice: string;
  };
  missionCount: number;
  activeMissionCount: number;
  openInvestigationCount: number;
  memoryCount?: number;
  standingOrderCount?: number;
  delegationCount?: number;
  standingOrders?: Array<{ id: string }>;
}

export default function SubagentsPage() {
  const [subagents, setSubagents] = useState<SubagentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchClientJson<{ subagents: SubagentItem[] }>("/api/subagents");
      setSubagents(response.subagents);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load subagents");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggle = async (subagent: SubagentItem) => {
    setWorkingId(subagent.id);
    setError(null);
    try {
      await fetchClientJson(`/api/subagents/${subagent.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: subagent.status === "active" ? "paused" : "active",
        }),
      });
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update subagent");
    } finally {
      setWorkingId(null);
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredSubagents = subagents.filter((subagent) => {
    if (!normalizedQuery) {
      return true;
    }
    const haystack = [
      subagent.name,
      subagent.description,
      subagent.scopeJson.domain,
      subagent.autonomyJson.approvalMode,
      subagent.autonomyJson.channelVoice,
    ].join(" ").toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-auto pr-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Bot className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="steward-heading-font text-2xl font-semibold tracking-tight">Subagents</h1>
            <p className="text-sm text-muted-foreground">Domain custodians that own missions over time.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-[240px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search subagents" className="pl-9" />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading
          ? [1, 2, 3].map((item) => <Skeleton key={item} className="h-52" />)
          : filteredSubagents.map((subagent) => (
            <Card key={subagent.id}>
              <CardHeader className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">{subagent.name}</CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">{subagent.description}</p>
                  </div>
                  <Badge variant={subagent.status === "active" ? "default" : "outline"}>{subagent.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">Missions</p>
                    <p className="mt-1 text-xl font-semibold">{subagent.missionCount}</p>
                  </div>
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">Active</p>
                    <p className="mt-1 text-xl font-semibold">{subagent.activeMissionCount}</p>
                  </div>
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">Investigations</p>
                    <p className="mt-1 text-xl font-semibold">{subagent.openInvestigationCount}</p>
                  </div>
                </div>
                <div className="space-y-1 rounded-lg border border-border/70 p-3 text-xs text-muted-foreground">
                  <p>Domain: {subagent.scopeJson.domain}</p>
                  <p>Approval mode: {subagent.autonomyJson.approvalMode}</p>
                  <p className="line-clamp-2">Voice: {subagent.autonomyJson.channelVoice}</p>
                  <p>Memories: {subagent.memoryCount ?? 0}</p>
                  <p>Standing orders: {subagent.standingOrderCount ?? subagent.standingOrders?.length ?? 0}</p>
                  <p>Delegations: {subagent.delegationCount ?? 0}</p>
                </div>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={workingId === subagent.id}
                  onClick={() => void toggle(subagent)}
                >
                  {workingId === subagent.id ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : null}
                  {subagent.status === "active" ? "Pause Subagent" : "Activate Subagent"}
                </Button>
              </CardContent>
            </Card>
          ))}
        {!loading && filteredSubagents.length === 0 ? (
          <Card className="md:col-span-2 xl:col-span-3">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No subagents match the current search.
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
