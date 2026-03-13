"use client";

import { useState } from "react";
import {
  Calendar,
  Clock,
  Plus,
  Shield,
  ShieldCheck,
} from "lucide-react";
import { useSteward } from "@/lib/hooks/use-steward";
import type {
  MaintenanceWindow,
  PolicyDecision,
  PolicyRule,
} from "@/lib/state/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTION_CLASS_COLORS: Record<string, string> = {
  A: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  B: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  C: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  D: "bg-red-500/15 text-red-700 dark:text-red-400",
};

function decisionVariant(
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

// ---------------------------------------------------------------------------
// Policy Rule Detail (expanded row)
// ---------------------------------------------------------------------------

function PolicyRuleDetail({
  rule,
  onClose,
}: {
  rule: PolicyRule;
  onClose: () => void;
}) {
  return (
    <Card className="border-primary/20 bg-muted/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{rule.name}</CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <CardDescription>{rule.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Action Classes
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rule.actionClasses?.length ? (
                rule.actionClasses.map((c) => (
                  <Badge
                    key={c}
                    className={cn(
                      "text-[10px] font-mono",
                      ACTION_CLASS_COLORS[c],
                    )}
                  >
                    {c}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">All</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Autonomy Tiers
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rule.autonomyTiers?.length ? (
                rule.autonomyTiers.map((t) => (
                  <Badge key={t} variant="outline" className="text-[10px]">
                    Tier {t}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">All</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Environment Labels
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rule.environmentLabels?.length ? (
                rule.environmentLabels.map((l) => (
                  <Badge key={l} variant="outline" className="text-[10px]">
                    {l}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">All</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Device Types
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rule.deviceTypes?.length ? (
                rule.deviceTypes.map((t) => (
                  <Badge key={t} variant="outline" className="text-[10px] capitalize">
                    {t.replace(/-/g, " ")}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">All</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Decision
            </p>
            <div className="mt-1">
              <Badge variant={decisionVariant(rule.decision)}>
                {decisionLabel(rule.decision)}
              </Badge>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Priority
            </p>
            <p className="mt-1 text-sm tabular-nums">{rule.priority}</p>
          </div>
        </div>
        <Separator />
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>
            Created{" "}
            {new Date(rule.createdAt).toLocaleDateString()}
          </span>
          <span>
            Updated{" "}
            {new Date(rule.updatedAt).toLocaleDateString()}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Maintenance Window Card
// ---------------------------------------------------------------------------

function MaintenanceWindowCard({ window }: { window: MaintenanceWindow }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{window.name}</CardTitle>
            <CardDescription className="mt-1">
              {window.deviceIds.length} device
              {window.deviceIds.length !== 1 ? "s" : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={window.enabled ? "default" : "outline"}>
              {window.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-xs">{window.cronStart}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span>{window.durationMinutes} minutes</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Created {new Date(window.createdAt).toLocaleDateString()}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PoliciesPage() {
  const { policyRules, maintenanceWindows, loading } = useSteward();
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [addRuleOpen, setAddRuleOpen] = useState(false);
  const [addWindowOpen, setAddWindowOpen] = useState(false);

  // Add rule form state
  const [newRuleName, setNewRuleName] = useState("");
  const [newRuleDescription, setNewRuleDescription] = useState("");
  const [newRuleDecision, setNewRuleDecision] = useState<PolicyDecision>("REQUIRE_APPROVAL");
  const [newRulePriority, setNewRulePriority] = useState("50");

  // Add window form state
  const [newWindowName, setNewWindowName] = useState("");
  const [newWindowCron, setNewWindowCron] = useState("");
  const [newWindowDuration, setNewWindowDuration] = useState("60");

  const sortedRules = [...policyRules].sort((a, b) => a.priority - b.priority);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-64" />
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-2xl font-semibold tracking-tight steward-heading-font">
          Policy Management
        </h1>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="rules" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="rules">
            <ShieldCheck className="mr-1.5 h-4 w-4" />
            Policy Rules
            <Badge variant="secondary" className="ml-1.5 tabular-nums text-[10px]">
              {policyRules.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="windows">
            <Calendar className="mr-1.5 h-4 w-4" />
            Maintenance Windows
            <Badge variant="secondary" className="ml-1.5 tabular-nums text-[10px]">
              {maintenanceWindows.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        {/* Policy Rules Tab */}
        <TabsContent value="rules" className="mt-4 min-h-0 flex-1 space-y-4 overflow-auto">
          <div className="flex justify-end">
            <Dialog open={addRuleOpen} onOpenChange={setAddRuleOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add Rule
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Policy Rule</DialogTitle>
                  <DialogDescription>
                    Create a new policy rule to govern playbook execution
                    decisions.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="rule-name">Name</Label>
                    <Input
                      id="rule-name"
                      value={newRuleName}
                      onChange={(e) => setNewRuleName(e.target.value)}
                      placeholder="e.g., Block prod D-class"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="rule-desc">Description</Label>
                    <Textarea
                      id="rule-desc"
                      value={newRuleDescription}
                      onChange={(e) => setNewRuleDescription(e.target.value)}
                      placeholder="Describe what this rule does..."
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="rule-decision">Decision</Label>
                      <Select
                        value={newRuleDecision}
                        onValueChange={(v) =>
                          setNewRuleDecision(v as PolicyDecision)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ALLOW_AUTO">Auto Allow</SelectItem>
                          <SelectItem value="REQUIRE_APPROVAL">
                            Require Approval
                          </SelectItem>
                          <SelectItem value="DENY">Deny</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="rule-priority">Priority</Label>
                      <Input
                        id="rule-priority"
                        type="number"
                        min="0"
                        max="1000"
                        value={newRulePriority}
                        onChange={(e) => setNewRulePriority(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    disabled={!newRuleName.trim()}
                    onClick={() => {
                      // Placeholder: in production this would call an API
                      setAddRuleOpen(false);
                      setNewRuleName("");
                      setNewRuleDescription("");
                      setNewRuleDecision("REQUIRE_APPROVAL");
                      setNewRulePriority("50");
                    }}
                  >
                    Create Rule
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {policyRules.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
                <ShieldCheck className="h-10 w-10 text-muted-foreground/40" />
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    No policy rules configured
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    Add rules to control how Steward handles different action
                    classes and autonomy tiers.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="overflow-hidden">
                <CardContent className="p-0 md:p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Priority</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Action Classes</TableHead>
                        <TableHead>Tiers</TableHead>
                        <TableHead>Decision</TableHead>
                        <TableHead>Enabled</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedRules.map((rule) => (
                        <TableRow
                          key={rule.id}
                          className="cursor-pointer"
                          onClick={() =>
                            setExpandedRule(
                              expandedRule === rule.id ? null : rule.id,
                            )
                          }
                        >
                          <TableCell className="tabular-nums font-mono text-xs">
                            {rule.priority}
                          </TableCell>
                          <TableCell className="font-medium">
                            {rule.name}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {rule.actionClasses?.length ? (
                                rule.actionClasses.map((c) => (
                                  <Badge
                                    key={c}
                                    className={cn(
                                      "text-[10px] font-mono",
                                      ACTION_CLASS_COLORS[c],
                                    )}
                                  >
                                    {c}
                                  </Badge>
                                ))
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  All
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {rule.autonomyTiers?.length ? (
                              <span className="text-sm tabular-nums">
                                {rule.autonomyTiers.join(", ")}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                All
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant={decisionVariant(rule.decision)}>
                              {decisionLabel(rule.decision)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Switch
                              checked={rule.enabled}
                              size="sm"
                              onClick={(e) => e.stopPropagation()}
                              onCheckedChange={() => {
                                // Placeholder: in production this would call an API
                              }}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Expanded rule detail */}
              {expandedRule && (
                <PolicyRuleDetail
                  rule={sortedRules.find((r) => r.id === expandedRule)!}
                  onClose={() => setExpandedRule(null)}
                />
              )}
            </>
          )}
        </TabsContent>

        {/* Maintenance Windows Tab */}
        <TabsContent value="windows" className="mt-4 min-h-0 flex-1 space-y-4 overflow-auto">
          <div className="flex justify-end">
            <Dialog open={addWindowOpen} onOpenChange={setAddWindowOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add Window
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Maintenance Window</DialogTitle>
                  <DialogDescription>
                    Define a recurring maintenance window where certain
                    restrictions are relaxed.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="window-name">Name</Label>
                    <Input
                      id="window-name"
                      value={newWindowName}
                      onChange={(e) => setNewWindowName(e.target.value)}
                      placeholder="e.g., Sunday night maintenance"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="window-cron">
                      Cron Schedule (start)
                    </Label>
                    <Input
                      id="window-cron"
                      value={newWindowCron}
                      onChange={(e) => setNewWindowCron(e.target.value)}
                      placeholder="e.g., 0 2 * * 0"
                      className="font-mono"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="window-duration">
                      Duration (minutes)
                    </Label>
                    <Input
                      id="window-duration"
                      type="number"
                      min="5"
                      max="1440"
                      value={newWindowDuration}
                      onChange={(e) => setNewWindowDuration(e.target.value)}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    disabled={!newWindowName.trim() || !newWindowCron.trim()}
                    onClick={() => {
                      // Placeholder: in production this would call an API
                      setAddWindowOpen(false);
                      setNewWindowName("");
                      setNewWindowCron("");
                      setNewWindowDuration("60");
                    }}
                  >
                    Create Window
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {maintenanceWindows.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
                <Calendar className="h-10 w-10 text-muted-foreground/40" />
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    No maintenance windows configured
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    Define recurring windows when automated actions have relaxed
                    policy restrictions.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {maintenanceWindows.map((w) => (
                <MaintenanceWindowCard key={w.id} window={w} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
