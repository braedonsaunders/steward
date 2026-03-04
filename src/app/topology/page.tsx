"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  Maximize2,
  Network,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useSteward } from "@/lib/hooks/use-steward";
import type {
  DeviceType,
  GraphEdge,
  GraphNode,
  GraphNodeType,
} from "@/lib/state/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Force-directed layout types
// ---------------------------------------------------------------------------

interface LayoutNode {
  id: string;
  type: GraphNodeType;
  label: string;
  x: number;
  y: number;
  connections: number;
  properties: Record<string, unknown>;
}

interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  type: string;
}

const NODE_TYPE_COLORS: Record<GraphNodeType, string> = {
  device: "#3b82f6",
  service: "#10b981",
  incident: "#ef4444",
  credential: "#8b5cf6",
  baseline: "#6b7280",
  site: "#f59e0b",
  user: "#06b6d4",
  policy: "#ec4899",
  playbook_run: "#f97316",
};

const NODE_TYPE_LABELS: Record<GraphNodeType, string> = {
  device: "Device",
  service: "Service",
  incident: "Incident",
  credential: "Credential",
  baseline: "Baseline",
  site: "Site",
  user: "User",
  policy: "Policy",
  playbook_run: "Playbook Run",
};

const NETWORK_EDGE_TYPES = new Set(["contains", "depends_on", "communicates_with"]);

function getDeviceType(node: GraphNode): DeviceType | null {
  const raw = node.properties.type;
  if (typeof raw !== "string") return null;
  return raw as DeviceType;
}

function isSiteNode(node: GraphNode): boolean {
  return node.type === "site" && !node.id.startsWith("subnet:");
}

function isNetworkNode(node: GraphNode): boolean {
  return node.type === "device" || isSiteNode(node);
}

function getHierarchyLevel(node: GraphNode): number {
  if (isSiteNode(node)) return 0;
  if (node.type !== "device") return 6;

  const type = getDeviceType(node);
  switch (type) {
    case "router":
    case "firewall":
      return 1;
    case "switch":
      return 2;
    case "access-point":
      return 3;
    case "server":
    case "nas":
    case "hypervisor":
    case "container-host":
      return 4;
    case "workstation":
    case "printer":
    case "camera":
    case "iot":
      return 5;
    default:
      return 4;
  }
}

function prepareTopologyData(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { filteredNodes: GraphNode[]; filteredEdges: GraphEdge[] } {
  const filteredNodes = nodes.filter(isNetworkNode);
  const nodeIds = new Set(filteredNodes.map((node) => node.id));

  const filteredEdges: GraphEdge[] = [];
  for (const edge of edges) {
    if (!NETWORK_EDGE_TYPES.has(edge.type)) continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;

    if (edge.type === "depends_on") {
      filteredEdges.push({ ...edge, from: edge.to, to: edge.from });
      continue;
    }

    filteredEdges.push(edge);
  }

  return { filteredNodes, filteredEdges };
}

function initializeHierarchicalLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
): { layoutNodes: LayoutNode[]; layoutEdges: LayoutEdge[] } {
  const connectionCount = new Map<string, number>();
  for (const edge of edges) {
    connectionCount.set(edge.from, (connectionCount.get(edge.from) ?? 0) + 1);
    connectionCount.set(edge.to, (connectionCount.get(edge.to) ?? 0) + 1);
  }

  const groups = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const level = getHierarchyLevel(node);
    const existing = groups.get(level) ?? [];
    existing.push(node);
    groups.set(level, existing);
  }

  const levels = Array.from(groups.keys()).sort((a, b) => a - b);
  const topPadding = 70;
  const bottomPadding = 70;
  const usableHeight = Math.max(1, height - topPadding - bottomPadding);
  const denominator = Math.max(1, levels.length - 1);

  const layoutNodes: LayoutNode[] = [];
  for (const [index, level] of levels.entries()) {
    const levelNodes = groups.get(level) ?? [];
    levelNodes.sort((a, b) => a.label.localeCompare(b.label));
    const y = topPadding + (usableHeight * index) / denominator;
    const horizontalPadding = 60;
    const usableWidth = Math.max(1, width - horizontalPadding * 2);

    for (let i = 0; i < levelNodes.length; i++) {
      const node = levelNodes[i];
      const x =
        levelNodes.length === 1
          ? width / 2
          : horizontalPadding + (usableWidth * i) / (levelNodes.length - 1);

      layoutNodes.push({
        id: node.id,
        type: node.type,
        label: node.label,
        x,
        y,
        connections: connectionCount.get(node.id) ?? 0,
        properties: node.properties,
      });
    }
  }

  const layoutEdges: LayoutEdge[] = edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    type: e.type,
  }));

  return { layoutNodes, layoutEdges };
}

function TopologyGraph({
  nodes,
  edges,
  onNodeClick,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (node: GraphNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const width = 900;
  const height = 600;

  const layout = useMemo(
    () => initializeHierarchicalLayout(nodes, edges, width, height),
    [nodes, edges],
  );

  const nodeMap = new Map<string, LayoutNode>();
  for (const n of layout.layoutNodes) {
    nodeMap.set(n.id, n);
  }

  const graphNodeMap = new Map<string, GraphNode>();
  for (const n of nodes) {
    graphNodeMap.set(n.id, n);
  }

  return (
    <div ref={containerRef} className="relative z-0 h-full min-h-[380px] overflow-hidden rounded-lg border bg-muted/20">
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => setZoom((z) => Math.min(z + 0.2, 3))}
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => setZoom((z) => Math.max(z - 0.2, 0.3))}
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => setZoom(1)}
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-full w-full"
        style={{
          transform: `scale(${zoom})`,
          transformOrigin: "center center",
          pointerEvents: "auto",
        }}
      >
        {/* Layer guides */}
        {["Site", "Edge", "Distribution", "Access", "Infrastructure", "Clients"].map((label, index, arr) => {
          const topPadding = 70;
          const bottomPadding = 70;
          const usableHeight = height - topPadding - bottomPadding;
          const y = topPadding + (usableHeight * index) / Math.max(1, arr.length - 1);
          return (
            <g key={label}>
              <line
                x1={20}
                y1={y}
                x2={width - 20}
                y2={y}
                stroke="hsl(var(--border))"
                strokeOpacity={0.35}
                strokeDasharray="4 6"
                strokeWidth={1}
              />
              <text
                x={24}
                y={y - 8}
                fill="hsl(var(--muted-foreground))"
                fontSize={10}
                fontWeight={500}
                className="pointer-events-none select-none"
              >
                {label}
              </text>
            </g>
          );
        })}

        {/* Edges */}
        {layout.layoutEdges.map((edge) => {
          const from = nodeMap.get(edge.from);
          const to = nodeMap.get(edge.to);
          if (!from || !to) return null;
          const isHighlighted =
            hoveredNode === edge.from || hoveredNode === edge.to;
          return (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={isHighlighted ? "hsl(var(--primary))" : "hsl(var(--border))"}
              strokeWidth={isHighlighted ? 2 : 1}
              strokeOpacity={isHighlighted ? 0.9 : 0.5}
            />
          );
        })}

        {/* Nodes */}
        {layout.layoutNodes.map((node) => {
          const radius = Math.max(8, Math.min(20, 6 + node.connections * 2));
          const fill = NODE_TYPE_COLORS[node.type] ?? "#6b7280";
          const isHovered = hoveredNode === node.id;
          return (
            <g
              key={node.id}
              className="cursor-pointer"
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
              onClick={() => {
                const gn = graphNodeMap.get(node.id);
                if (gn) onNodeClick(gn);
              }}
            >
              {/* Glow ring on hover */}
              {isHovered && (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={radius + 4}
                  fill="none"
                  stroke={fill}
                  strokeWidth={2}
                  strokeOpacity={0.4}
                />
              )}
              <circle
                cx={node.x}
                cy={node.y}
                r={radius}
                fill={fill}
                fillOpacity={isHovered ? 1 : 0.85}
                stroke={isHovered ? "hsl(var(--foreground))" : "none"}
                strokeWidth={isHovered ? 1.5 : 0}
              />
              {/* Label */}
              <text
                x={node.x}
                y={node.y + radius + 14}
                textAnchor="middle"
                fill="hsl(var(--foreground))"
                fontSize={11}
                fontWeight={isHovered ? 600 : 400}
                opacity={isHovered ? 1 : 0.7}
                className="pointer-events-none select-none"
              >
                {node.label.length > 18
                  ? node.label.slice(0, 16) + "..."
                  : node.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Hovered node tooltip */}
      {hoveredNode && (() => {
        const node = nodeMap.get(hoveredNode);
        if (!node) return null;
        return (
          <div className="absolute bottom-3 left-3 z-10 rounded-md border bg-background/95 p-3 shadow-lg backdrop-blur-sm">
            <p className="text-sm font-medium">{node.label}</p>
            <p className="text-xs text-muted-foreground capitalize">
              {NODE_TYPE_LABELS[node.type]} &middot; {node.connections} connection{node.connections !== 1 ? "s" : ""}
            </p>
          </div>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function Legend() {
  const types: [GraphNodeType, string][] = [
    ["site", NODE_TYPE_LABELS.site],
    ["device", NODE_TYPE_LABELS.device],
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {types.map(([type, label]) => (
        <div key={type} className="flex items-center gap-1.5">
          <div
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: NODE_TYPE_COLORS[type] }}
          />
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TopologyPage() {
  const router = useRouter();
  const { graphNodes, graphEdges, loading } = useSteward();

  const { filteredNodes, filteredEdges } = useMemo(
    () => prepareTopologyData(graphNodes, graphEdges),
    [graphNodes, graphEdges],
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      // Navigate to device detail if it's a device node
      if (node.type === "device") {
        router.push(`/devices/${node.id.replace(/^device:/, "")}`);
      } else if (node.type === "incident") {
        router.push(`/incidents/${node.id.replace(/^incident:/, "")}`);
      }
    },
    [router],
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-48" />
        </div>
        <Skeleton className="h-[500px] w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Network className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">
            Network Topology
          </h1>
          <div className="flex gap-2">
            <Badge variant="secondary" className="tabular-nums">
              {filteredNodes.length} nodes
            </Badge>
            <Badge variant="outline" className="tabular-nums">
              {filteredEdges.length} edges
            </Badge>
            {graphNodes.length > filteredNodes.length && (
              <Badge variant="outline" className="tabular-nums">
                {graphNodes.length - filteredNodes.length} hidden details
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Graph */}
      {filteredNodes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-20">
            <Network className="h-12 w-12 text-muted-foreground/40" />
            <div className="text-center space-y-1">
              <p className="text-sm font-medium text-muted-foreground">
                No topology data available
              </p>
              <p className="text-xs text-muted-foreground/70">
                Run an agent cycle to discover devices and build the network
                graph.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <TopologyGraph
              nodes={filteredNodes}
              edges={filteredEdges}
              onNodeClick={handleNodeClick}
            />
          </div>
          <Legend />
        </>
      )}
    </div>
  );
}
