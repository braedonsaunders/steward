"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Boxes,
  Camera,
  CircleHelp,
  Cpu,
  Database,
  Globe,
  HardDrive,
  Laptop,
  Maximize2,
  Monitor,
  Network,
  Printer,
  Server,
  Shield,
  Smartphone,
  Wifi,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useSteward } from "@/lib/hooks/use-steward";
import type { Device, DeviceStatus, DeviceType, GraphEdge } from "@/lib/state/types";
import { cn } from "@/lib/utils";

type TopologyColumn = "internet" | "edge" | "network" | "infrastructure" | "endpoints";
type TopologyNodeKind = "device" | "virtual";

interface TopologyLink {
  id: string;
  from: string;
  to: string;
  reason?: string;
}

interface TopologyStageNode {
  id: string;
  kind: TopologyNodeKind;
  column: TopologyColumn;
  label: string;
  subtitle: string;
  meta: string;
  device?: Device;
  gatewayScore?: number;
  parentId?: string;
  parentLabel?: string;
  parentReason?: string;
  childCount: number;
  incomingDependencyCount: number;
  outgoingDependencyCount: number;
}

interface TopologySection {
  id: string;
  cidr: string;
  inference: string;
  nodes: TopologyStageNode[];
  links: TopologyLink[];
  primaryEdgeId?: string;
  counts: {
    devices: number;
    edge: number;
    network: number;
    infrastructure: number;
    endpoints: number;
  };
}

interface PositionedTopologyNode extends TopologyStageNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

const COLUMN_LABELS: Record<TopologyColumn, string> = {
  internet: "Internet",
  edge: "Edge",
  network: "Network",
  infrastructure: "Infrastructure",
  endpoints: "Endpoints",
};

const COLUMN_ORDER: TopologyColumn[] = [
  "internet",
  "edge",
  "network",
  "infrastructure",
  "endpoints",
];

const EDGE_DEVICE_TYPES = new Set<DeviceType>([
  "router",
  "firewall",
  "modem",
  "load-balancer",
  "vpn-appliance",
  "wan-optimizer",
]);

const NETWORK_DEVICE_TYPES = new Set<DeviceType>([
  "router",
  "firewall",
  "modem",
  "load-balancer",
  "vpn-appliance",
  "wan-optimizer",
  "switch",
  "access-point",
  "controller",
  "pbx",
]);

const INFRASTRUCTURE_DEVICE_TYPES = new Set<DeviceType>([
  "server",
  "nas",
  "san",
  "hypervisor",
  "container-host",
  "vm-host",
  "kubernetes-master",
  "kubernetes-worker",
  "nvr",
  "dvr",
  "ups",
  "pdu",
  "bmc",
]);

const DEVICE_CARD_WIDTH = 164;
const DEVICE_CARD_HEIGHT = 82;
const COLUMN_GAP = 28;
const ROW_GAP = 16;
const STAGE_PADDING_X = 28;
const STAGE_PADDING_TOP = 54;
const STAGE_PADDING_BOTTOM = 24;

function formatDeviceType(type: DeviceType): string {
  return type.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatLastSeen(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function statusBadgeVariant(
  status: DeviceStatus,
): "default" | "destructive" | "secondary" | "outline" {
  switch (status) {
    case "online":
      return "default";
    case "offline":
      return "destructive";
    case "degraded":
      return "secondary";
    default:
      return "outline";
  }
}

function statusDotClass(status?: DeviceStatus): string {
  switch (status) {
    case "online":
      return "bg-emerald-500";
    case "offline":
      return "bg-red-500";
    case "degraded":
      return "bg-amber-500";
    default:
      return "bg-slate-400";
  }
}

function subnet24(ip: string): string {
  const parts = ip.split(".");
  if (parts.length !== 4) return "Unassigned";
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function parseIpv4(ip: string): number {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function isEdgeDevice(device: Device): boolean {
  return EDGE_DEVICE_TYPES.has(device.type);
}

function isNetworkDevice(device: Device): boolean {
  return NETWORK_DEVICE_TYPES.has(device.type);
}

function isInfrastructureDevice(device: Device): boolean {
  return INFRASTRUCTURE_DEVICE_TYPES.has(device.type);
}

function getGatewayScore(device: Device, incomingDependencyCount: number): number {
  let score = 0;

  switch (device.type) {
    case "router":
      score += 140;
      break;
    case "firewall":
      score += 130;
      break;
    case "modem":
      score += 120;
      break;
    case "load-balancer":
    case "vpn-appliance":
    case "wan-optimizer":
      score += 95;
      break;
    case "switch":
      score += 70;
      break;
    case "access-point":
      score += 55;
      break;
    default:
      break;
  }

  if (device.ip.endsWith(".1")) score += 60;
  if (device.ip.endsWith(".254")) score += 48;
  if (device.role && /\b(router|gateway|firewall|edge|modem)\b/i.test(device.role)) {
    score += 30;
  }
  if (device.services.some((service) => service.name.includes("dns") || service.port === 53)) {
    score += 12;
  }
  if (device.services.some((service) => service.port === 80 || service.port === 443)) {
    score += 10;
  }
  if (device.status === "online") {
    score += 8;
  }

  score += incomingDependencyCount * 4;
  return score;
}

function getNodeIcon(node: TopologyStageNode): LucideIcon {
  if (node.kind === "virtual") {
    return node.id.endsWith(":internet") ? Globe : Network;
  }

  switch (node.device?.type) {
    case "router":
    case "modem":
    case "load-balancer":
    case "wan-optimizer":
    case "vpn-appliance":
      return Network;
    case "firewall":
      return Shield;
    case "switch":
    case "controller":
      return Boxes;
    case "access-point":
      return Wifi;
    case "server":
    case "container-host":
    case "hypervisor":
    case "vm-host":
    case "kubernetes-master":
    case "kubernetes-worker":
      return Server;
    case "nas":
    case "san":
      return HardDrive;
    case "workstation":
      return Monitor;
    case "laptop":
      return Laptop;
    case "smartphone":
    case "tablet":
      return Smartphone;
    case "printer":
    case "scanner":
      return Printer;
    case "camera":
    case "nvr":
    case "dvr":
      return Camera;
    case "ups":
    case "pdu":
    case "bmc":
      return Cpu;
    case "point-of-sale":
    case "badge-reader":
    case "door-controller":
      return Database;
    default:
      return CircleHelp;
  }
}

function getNodeAccentClasses(node: TopologyStageNode): string {
  if (node.kind === "virtual") {
    return "bg-sky-500/12 text-sky-300 ring-sky-500/30";
  }

  switch (node.device?.type) {
    case "router":
    case "modem":
    case "load-balancer":
    case "wan-optimizer":
    case "vpn-appliance":
      return "bg-sky-500/12 text-sky-300 ring-sky-500/30";
    case "firewall":
      return "bg-rose-500/12 text-rose-300 ring-rose-500/30";
    case "switch":
    case "access-point":
    case "controller":
      return "bg-cyan-500/12 text-cyan-300 ring-cyan-500/30";
    case "server":
    case "container-host":
    case "hypervisor":
    case "vm-host":
    case "kubernetes-master":
    case "kubernetes-worker":
      return "bg-violet-500/12 text-violet-300 ring-violet-500/30";
    case "nas":
    case "san":
      return "bg-amber-500/12 text-amber-300 ring-amber-500/30";
    default:
      return "bg-slate-500/12 text-slate-300 ring-slate-500/30";
  }
}

function buildDeviceDependencyMaps(edges: GraphEdge[]) {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();

  for (const edge of edges) {
    if (edge.type !== "depends_on") continue;
    if (!edge.from.startsWith("device:") || !edge.to.startsWith("device:")) continue;

    const fromId = edge.from.replace(/^device:/, "");
    const toId = edge.to.replace(/^device:/, "");

    const outExisting = outgoing.get(fromId) ?? [];
    outExisting.push(edge);
    outgoing.set(fromId, outExisting);

    const inExisting = incoming.get(toId) ?? [];
    inExisting.push(edge);
    incoming.set(toId, inExisting);
  }

  return { outgoing, incoming };
}

function pickBestParentId(
  deviceId: string,
  outgoingDeps: Map<string, GraphEdge[]>,
  candidateParentIds: string[],
  gatewayScores: Map<string, number>,
): { parentId?: string; reason?: string } {
  const candidates = new Set(candidateParentIds);
  const dependencies = outgoingDeps.get(deviceId) ?? [];
  const matching = dependencies
    .map((edge) => ({
      targetId: edge.to.replace(/^device:/, ""),
      reason: typeof edge.properties.reason === "string" ? edge.properties.reason : undefined,
    }))
    .filter((item) => candidates.has(item.targetId));

  if (matching.length === 0) {
    return {};
  }

  matching.sort((a, b) => (gatewayScores.get(b.targetId) ?? 0) - (gatewayScores.get(a.targetId) ?? 0));
  return { parentId: matching[0].targetId, reason: matching[0].reason };
}

function buildTopologySections(devices: Device[], graphEdges: GraphEdge[]): TopologySection[] {
  const { outgoing, incoming } = buildDeviceDependencyMaps(graphEdges);
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  const grouped = new Map<string, Device[]>();

  for (const device of devices) {
    const cidr = subnet24(device.ip);
    const existing = grouped.get(cidr) ?? [];
    existing.push(device);
    grouped.set(cidr, existing);
  }

  return [...grouped.entries()]
    .sort((a, b) => parseIpv4(a[0].replace(/\.0\/24$/, ".0")) - parseIpv4(b[0].replace(/\.0\/24$/, ".0")))
    .map(([cidr, subnetDevices]) => {
      subnetDevices.sort((a, b) => parseIpv4(a.ip) - parseIpv4(b.ip));

      const gatewayScores = new Map<string, number>();
      for (const device of subnetDevices) {
        gatewayScores.set(device.id, getGatewayScore(device, (incoming.get(device.id) ?? []).length));
      }

      const edgeCandidates = subnetDevices
        .filter(isEdgeDevice)
        .sort((a, b) => {
          const scoreDiff = (gatewayScores.get(b.id) ?? 0) - (gatewayScores.get(a.id) ?? 0);
          return scoreDiff !== 0 ? scoreDiff : parseIpv4(a.ip) - parseIpv4(b.ip);
        });

      const primaryEdge = edgeCandidates[0];
      const internetNodeId = `${cidr}:internet`;
      const inferredEdgeNodeId = `${cidr}:uplink`;
      const fallbackEdgeId = primaryEdge?.id ?? inferredEdgeNodeId;
      const networkDevices = subnetDevices.filter((device) => isNetworkDevice(device) && device.id !== primaryEdge?.id);
      const infrastructureDevices = subnetDevices.filter((device) => isInfrastructureDevice(device));
      const endpointDevices = subnetDevices.filter(
        (device) => !isNetworkDevice(device) && !isInfrastructureDevice(device),
      );

      const nodes: TopologyStageNode[] = [
        {
          id: internetNodeId,
          kind: "virtual",
          column: "internet",
          label: "Internet",
          subtitle: "WAN / upstream",
          meta: primaryEdge ? "Primary uplink detected" : "No explicit gateway detected",
          childCount: 0,
          incomingDependencyCount: 0,
          outgoingDependencyCount: 0,
        },
      ];

      if (primaryEdge) {
        nodes.push({
          id: primaryEdge.id,
          kind: "device",
          column: "edge",
          label: primaryEdge.name,
          subtitle: `${primaryEdge.ip} · ${formatDeviceType(primaryEdge.type)}`,
          meta: primaryEdge.vendor ?? primaryEdge.hostname ?? `${primaryEdge.services.length} service${primaryEdge.services.length === 1 ? "" : "s"}`,
          device: primaryEdge,
          gatewayScore: gatewayScores.get(primaryEdge.id),
          childCount: 0,
          incomingDependencyCount: (incoming.get(primaryEdge.id) ?? []).length,
          outgoingDependencyCount: (outgoing.get(primaryEdge.id) ?? []).length,
          parentId: internetNodeId,
          parentLabel: "Internet",
          parentReason: "Primary subnet uplink",
        });
      } else {
        nodes.push({
          id: inferredEdgeNodeId,
          kind: "virtual",
          column: "edge",
          label: "Unknown Uplink",
          subtitle: cidr,
          meta: "Subnet grouped without a detected router or firewall",
          childCount: 0,
          incomingDependencyCount: 0,
          outgoingDependencyCount: 0,
          parentId: internetNodeId,
          parentLabel: "Internet",
          parentReason: "Fallback uplink",
        });
      }

      const links: TopologyLink[] = [
        {
          id: `${internetNodeId}->${fallbackEdgeId}`,
          from: internetNodeId,
          to: fallbackEdgeId,
          reason: primaryEdge ? "Primary subnet uplink" : "Fallback inferred uplink",
        },
      ];

      const networkParentCandidates = [primaryEdge?.id, ...networkDevices.map((device) => device.id)].filter(
        (value): value is string => Boolean(value),
      );

      const attachDevices = (
        group: Device[],
        column: TopologyColumn,
      ) => {
        for (const device of group) {
          const preferredParent = pickBestParentId(
            device.id,
            outgoing,
            networkParentCandidates.filter((candidate) => candidate !== device.id),
            gatewayScores,
          );

          const parentId = preferredParent.parentId ?? fallbackEdgeId;
          const parentLabel =
            parentId === internetNodeId
              ? "Internet"
              : parentId === inferredEdgeNodeId
                ? "Unknown Uplink"
                : devicesById.get(parentId)?.name;

          nodes.push({
            id: device.id,
            kind: "device",
            column,
            label: device.name,
            subtitle: `${device.ip} · ${formatDeviceType(device.type)}`,
            meta: device.vendor ?? device.hostname ?? `${device.services.length} service${device.services.length === 1 ? "" : "s"}`,
            device,
            gatewayScore: gatewayScores.get(device.id),
            childCount: 0,
            incomingDependencyCount: (incoming.get(device.id) ?? []).length,
            outgoingDependencyCount: (outgoing.get(device.id) ?? []).length,
            parentId,
            parentLabel,
            parentReason: preferredParent.reason ?? (parentId === fallbackEdgeId ? "Subnet uplink path" : undefined),
          });

          links.push({
            id: `${parentId}->${device.id}`,
            from: parentId,
            to: device.id,
            reason: preferredParent.reason ?? "Subnet path",
          });
        }
      };

      attachDevices(
        networkDevices.sort((a, b) => {
          const scoreDiff = (gatewayScores.get(b.id) ?? 0) - (gatewayScores.get(a.id) ?? 0);
          return scoreDiff !== 0 ? scoreDiff : parseIpv4(a.ip) - parseIpv4(b.ip);
        }),
        "network",
      );
      attachDevices(infrastructureDevices, "infrastructure");
      attachDevices(endpointDevices, "endpoints");

      const childCounts = new Map<string, number>();
      for (const link of links) {
        childCounts.set(link.from, (childCounts.get(link.from) ?? 0) + 1);
      }

      for (const node of nodes) {
        node.childCount = childCounts.get(node.id) ?? 0;
      }

      return {
        id: cidr,
        cidr,
        inference: primaryEdge
          ? `Hierarchy inferred from ${primaryEdge.name} (${primaryEdge.ip}) using device role, address, and dependency signals.`
          : "No router or firewall was detected for this subnet, so Steward grouped devices under a fallback uplink.",
        nodes,
        links,
        primaryEdgeId: primaryEdge?.id,
        counts: {
          devices: subnetDevices.length,
          edge: primaryEdge ? 1 : 0,
          network: networkDevices.length,
          infrastructure: infrastructureDevices.length,
          endpoints: endpointDevices.length,
        },
      };
    });
}

function layoutSection(section: TopologySection) {
  const nodesByColumn = new Map<TopologyColumn, TopologyStageNode[]>();
  for (const column of COLUMN_ORDER) {
    nodesByColumn.set(column, []);
  }

  for (const node of section.nodes) {
    nodesByColumn.get(node.column)?.push(node);
  }

  for (const column of COLUMN_ORDER) {
    const columnNodes = nodesByColumn.get(column) ?? [];
    columnNodes.sort((a, b) => {
      if (a.column !== b.column) return 0;
      if (a.kind !== b.kind) return a.kind === "virtual" ? -1 : 1;
      if (a.parentLabel !== b.parentLabel) return (a.parentLabel ?? "").localeCompare(b.parentLabel ?? "");
      if (a.childCount !== b.childCount) return b.childCount - a.childCount;
      return a.label.localeCompare(b.label);
    });
  }

  const maxCount = Math.max(...COLUMN_ORDER.map((column) => (nodesByColumn.get(column) ?? []).length), 1);
  const bodyHeight = maxCount * DEVICE_CARD_HEIGHT + (maxCount - 1) * ROW_GAP;
  const width =
    STAGE_PADDING_X * 2
    + DEVICE_CARD_WIDTH * COLUMN_ORDER.length
    + COLUMN_GAP * (COLUMN_ORDER.length - 1);
  const height = STAGE_PADDING_TOP + bodyHeight + STAGE_PADDING_BOTTOM;

  const positionedNodes: PositionedTopologyNode[] = [];
  for (const [index, column] of COLUMN_ORDER.entries()) {
    const columnNodes = nodesByColumn.get(column) ?? [];
    const columnX = STAGE_PADDING_X + index * (DEVICE_CARD_WIDTH + COLUMN_GAP);
    const columnHeight =
      columnNodes.length * DEVICE_CARD_HEIGHT
      + Math.max(0, columnNodes.length - 1) * ROW_GAP;
    const startY = STAGE_PADDING_TOP;

    columnNodes.forEach((node, nodeIndex) => {
      positionedNodes.push({
        ...node,
        x: columnX,
        y: startY + nodeIndex * (DEVICE_CARD_HEIGHT + ROW_GAP),
        width: DEVICE_CARD_WIDTH,
        height: DEVICE_CARD_HEIGHT,
      });
    });
  }

  return { width, height, positionedNodes };
}

function TopologyCanvas({
  section,
  hoveredNodeId,
  selectedNodeId,
  onHoverNode,
  onSelectNode,
}: {
  section: TopologySection;
  hoveredNodeId: string | null;
  selectedNodeId: string | null;
  onHoverNode: (nodeId: string | null) => void;
  onSelectNode: (node: TopologyStageNode) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const layout = useMemo(() => layoutSection(section), [section]);
  const nodeMap = useMemo(
    () => new Map(layout.positionedNodes.map((node) => [node.id, node])),
    [layout.positionedNodes],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => setZoom((value) => Math.max(0.8, value - 0.1))}
        >
          <ZoomOut className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => setZoom(1)}
        >
          <Maximize2 className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}
        >
          <ZoomIn className="size-4" />
        </Button>
      </div>

      <div className="max-h-[72vh] overflow-auto rounded-xl border border-border/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(241,245,249,0.92))] dark:bg-[linear-gradient(180deg,rgba(15,23,42,0.5),rgba(15,23,42,0.24))]">
        <div
          className="relative min-w-fit"
          style={{ width: layout.width * zoom, height: layout.height * zoom }}
        >
          <div
            className="absolute left-0 top-0"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
            }}
          >
            {COLUMN_ORDER.map((column, index) => (
              <div
                key={column}
                className="absolute top-4 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
                style={{
                  left: STAGE_PADDING_X + index * (DEVICE_CARD_WIDTH + COLUMN_GAP),
                  width: DEVICE_CARD_WIDTH,
                }}
              >
                {COLUMN_LABELS[column]}
              </div>
            ))}

            <svg className="absolute inset-0" width={layout.width} height={layout.height}>
              {section.links.map((link) => {
                const from = nodeMap.get(link.from);
                const to = nodeMap.get(link.to);
                if (!from || !to) return null;

                const isHighlighted =
                  hoveredNodeId === link.from
                  || hoveredNodeId === link.to
                  || selectedNodeId === link.from
                  || selectedNodeId === link.to;

                const startX = from.x + from.width;
                const startY = from.y + from.height / 2;
                const endX = to.x;
                const endY = to.y + to.height / 2;
                const controlX = startX + (endX - startX) / 2;

                return (
                  <path
                    key={link.id}
                    d={`M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`}
                    fill="none"
                    stroke={isHighlighted ? "hsl(var(--primary))" : "hsl(var(--border))"}
                    strokeOpacity={isHighlighted ? 0.92 : 0.55}
                    strokeWidth={isHighlighted ? 2.2 : 1.3}
                    strokeDasharray={link.from.endsWith(":internet") ? "0" : "0"}
                  />
                );
              })}
            </svg>

            {layout.positionedNodes.map((node) => {
              const Icon = getNodeIcon(node);
              const accentClasses = getNodeAccentClasses(node);
              const isInteractive = node.kind === "device";
              const isSelected = selectedNodeId === node.id;
              const isHovered = hoveredNodeId === node.id;

              return (
                <button
                  key={node.id}
                  type="button"
                  className={cn(
                    "absolute rounded-xl border border-border/80 bg-card/94 px-4 py-3 text-left shadow-[0_8px_24px_rgba(2,6,23,0.18)] transition-[border-color,box-shadow,transform]",
                    isInteractive ? "cursor-pointer hover:-translate-y-0.5 hover:border-primary/40" : "cursor-default",
                    isSelected || isHovered
                      ? "border-primary/55 shadow-[0_12px_34px_rgba(14,165,233,0.18)]"
                      : "",
                  )}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: node.width,
                    height: node.height,
                  }}
                  onMouseEnter={() => onHoverNode(node.id)}
                  onMouseLeave={() => onHoverNode(null)}
                  onClick={() => {
                    if (isInteractive) {
                      onSelectNode(node);
                    }
                  }}
                >
                  <div className="flex h-full items-start gap-3">
                    <div
                      className={cn(
                        "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg ring-1",
                        accentClasses,
                      )}
                    >
                      <Icon className="size-4.5" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">
                            {node.label}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {node.subtitle}
                          </p>
                        </div>
                        <span
                          className={cn(
                            "mt-1 inline-flex size-2 rounded-full",
                            statusDotClass(node.device?.status),
                          )}
                        />
                      </div>

                      <div className="mt-2 flex items-end justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-[11px] leading-4 text-muted-foreground">
                          {node.meta}
                        </p>
                        {node.childCount > 0 && (
                          <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                            {node.childCount} downlink{node.childCount === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TopologyPage() {
  const router = useRouter();
  const { devices, graphEdges, loading } = useSteward();
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<TopologyStageNode | null>(null);

  const sections = useMemo(() => buildTopologySections(devices, graphEdges), [devices, graphEdges]);

  const handleOpenDevice = useCallback(() => {
    if (!selectedNode?.device) return;
    router.push(`/devices/${selectedNode.device.id}`);
    setSelectedNode(null);
  }, [router, selectedNode]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-[560px] w-full rounded-xl" />
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <section className="space-y-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <Network className="size-5 text-muted-foreground" />
              <h1 className="text-xl font-semibold tracking-tight steward-heading-font md:text-2xl">
                Network Topology
              </h1>
              <Badge variant="outline" className="tabular-nums">
                {devices.length}
              </Badge>
            </div>
            <p className="max-w-4xl text-sm text-muted-foreground">
              Steward now infers a usable hierarchy from discovered gateways, subnet membership, and dependency signals
              so the map reads like a network path instead of a generic graph.
            </p>
          </div>
        </section>

        {sections.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-3 py-20">
              <Network className="size-12 text-muted-foreground/40" />
              <div className="space-y-1 text-center">
                <p className="text-sm font-medium text-muted-foreground">
                  No topology data available
                </p>
                <p className="text-xs text-muted-foreground/70">
                  Run a scanner cycle to discover devices and build the network graph.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="min-h-0 space-y-4 overflow-auto pr-1">
            {sections.map((section) => (
              <Card key={section.id} interactive={false} className="overflow-hidden border-border/80 bg-card/88">
                <CardContent className="space-y-4 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-foreground">{section.cidr}</h2>
                        {section.primaryEdgeId ? (
                          <Badge variant="secondary">Gateway inferred</Badge>
                        ) : (
                          <Badge variant="outline">Fallback uplink</Badge>
                        )}
                      </div>
                      <p className="max-w-3xl text-xs text-muted-foreground">
                        {section.inference}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="tabular-nums">
                        {section.counts.devices} devices
                      </Badge>
                      <Badge variant="outline" className="tabular-nums">
                        {section.counts.network} network
                      </Badge>
                      <Badge variant="outline" className="tabular-nums">
                        {section.counts.infrastructure} infrastructure
                      </Badge>
                      <Badge variant="outline" className="tabular-nums">
                        {section.counts.endpoints} endpoints
                      </Badge>
                    </div>
                  </div>

                  <TopologyCanvas
                    section={section}
                    hoveredNodeId={hoveredNodeId}
                    selectedNodeId={selectedNode?.id ?? null}
                    onHoverNode={setHoveredNodeId}
                    onSelectNode={setSelectedNode}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={Boolean(selectedNode?.device)} onOpenChange={(open) => {
        if (!open) setSelectedNode(null);
      }}>
        <DialogContent className="sm:max-w-2xl">
          {selectedNode?.device && (
            <>
              <DialogHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle>{selectedNode.device.name}</DialogTitle>
                  <Badge variant={statusBadgeVariant(selectedNode.device.status)} className="capitalize">
                    {selectedNode.device.status}
                  </Badge>
                  <Badge variant="outline">{formatDeviceType(selectedNode.device.type)}</Badge>
                </div>
                <DialogDescription>
                  {selectedNode.device.ip}
                  {selectedNode.device.hostname ? ` · ${selectedNode.device.hostname}` : ""}
                  {selectedNode.parentLabel ? ` · uplink via ${selectedNode.parentLabel}` : ""}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-3">
                  <div className="rounded-lg border border-border/80 bg-background/50 p-3">
                    <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Identity
                    </p>
                    <div className="mt-2 space-y-1.5 text-sm">
                      <p><span className="text-muted-foreground">Vendor:</span> {selectedNode.device.vendor ?? "Unknown"}</p>
                      <p><span className="text-muted-foreground">MAC:</span> {selectedNode.device.mac ?? "Unknown"}</p>
                      <p><span className="text-muted-foreground">Role:</span> {selectedNode.device.role ?? "Unspecified"}</p>
                      <p><span className="text-muted-foreground">Autonomy:</span> Tier {selectedNode.device.autonomyTier}</p>
                      <p><span className="text-muted-foreground">Last seen:</span> {formatLastSeen(selectedNode.device.lastSeenAt)}</p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/80 bg-background/50 p-3">
                    <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Relationships
                    </p>
                    <div className="mt-2 space-y-1.5 text-sm">
                      <p><span className="text-muted-foreground">Parent:</span> {selectedNode.parentLabel ?? "Unknown uplink"}</p>
                      <p><span className="text-muted-foreground">Downlinks:</span> {selectedNode.childCount}</p>
                      <p><span className="text-muted-foreground">Incoming dependencies:</span> {selectedNode.incomingDependencyCount}</p>
                      <p><span className="text-muted-foreground">Outgoing dependencies:</span> {selectedNode.outgoingDependencyCount}</p>
                      <p><span className="text-muted-foreground">Path reason:</span> {selectedNode.parentReason ?? "Subnet grouping"}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="rounded-lg border border-border/80 bg-background/50 p-3">
                    <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Protocols
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selectedNode.device.protocols.length > 0 ? (
                        selectedNode.device.protocols.map((protocol) => (
                          <Badge key={protocol} variant="outline" className="capitalize">
                            {protocol}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-sm text-muted-foreground">No management protocols identified.</span>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/80 bg-background/50 p-3">
                    <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Observed Services
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selectedNode.device.services.length > 0 ? (
                        selectedNode.device.services.slice(0, 10).map((service) => (
                          <Badge
                            key={`${service.transport}-${service.port}`}
                            variant="outline"
                            className="font-mono text-[11px]"
                          >
                            {service.name}:{service.port}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-sm text-muted-foreground">No service fingerprint data yet.</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <DialogFooter showCloseButton>
                <Button onClick={handleOpenDevice}>Open Device</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
