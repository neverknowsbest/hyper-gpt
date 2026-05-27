import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { hierarchy, tree } from "d3-hierarchy";
import { getCanvas } from "../lib/api";
import type { Edge, Node } from "../../../shared/types";

const NODE_W = 220;
const NODE_H = 92;
const H_GAP = 40;
const V_GAP = 56;

interface NodeData extends Record<string, unknown> {
  title: string;
  citation: string | null;
  outboundCount: number;
  isActive: boolean;
  isSeed: boolean;
}

// Heuristic: does the node title look like it was auto-derived from the
// citation (e.g. spawn with no user prompt)? If so, don't render the title
// as a separate row — the citation already covers it.
function titleEquivalentToCitation(
  title: string,
  citation: string | null,
): boolean {
  if (!citation) return false;
  const clean = (s: string) => s.replace(/…$/u, "").trim();
  const t = clean(title);
  const c = clean(citation);
  if (!t) return true;
  return t === c || c.startsWith(t) || t.startsWith(c);
}

function CanvasNode({ data }: NodeProps<RFNode<NodeData>>) {
  const showTitle =
    data.title && !titleEquivalentToCitation(data.title, data.citation);

  return (
    <div
      style={{
        width: NODE_W,
        height: NODE_H,
        background: data.isActive
          ? "color-mix(in srgb, dodgerblue 18%, Canvas)"
          : "color-mix(in srgb, CanvasText 4%, Canvas)",
        border: data.isActive
          ? "1.5px solid dodgerblue"
          : "1px solid color-mix(in srgb, CanvasText 18%, Canvas)",
        borderRadius: 8,
        padding: "0.5rem 0.7rem",
        display: "grid",
        gridTemplateRows: "1fr auto",
        gap: 4,
        cursor: "pointer",
        font: "inherit",
        textAlign: "left",
        overflow: "hidden",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ visibility: "hidden" }}
      />
      <div
        style={{
          overflow: "hidden",
          display: "grid",
          gap: 2,
          alignContent: "start",
        }}
      >
        {data.isSeed && (
          <div
            style={{
              fontSize: "0.85rem",
              fontWeight: data.isActive ? 600 : 500,
              color: "CanvasText",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              lineHeight: 1.2,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "color-mix(in srgb, CanvasText 60%, Canvas)",
                marginRight: 6,
                verticalAlign: "middle",
              }}
              title="Seed"
            />
            {data.title}
          </div>
        )}
        {!data.isSeed && data.citation && (
          <div
            style={{
              fontSize: "0.85rem",
              fontWeight: data.isActive ? 600 : 500,
              color: "CanvasText",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              lineHeight: 1.2,
              fontStyle: "italic",
            }}
          >
            “{data.citation}”
          </div>
        )}
        {!data.isSeed && showTitle && (
          <div
            style={{
              fontSize: "0.75rem",
              color: "color-mix(in srgb, CanvasText 70%, Canvas)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 1,
              WebkitBoxOrient: "vertical",
              lineHeight: 1.2,
            }}
          >
            {data.title}
          </div>
        )}
      </div>
      <div
        style={{
          fontSize: "0.7rem",
          color: "color-mix(in srgb, CanvasText 55%, Canvas)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {data.outboundCount === 0
          ? "no tangents"
          : data.outboundCount === 1
            ? "1 tangent"
            : `${data.outboundCount} tangents`}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ visibility: "hidden" }}
      />
    </div>
  );
}

const nodeTypes = { canvas: CanvasNode };

interface HierarchyDatum {
  id: string;
}

function computeLayout(
  nodes: Node[],
  edges: Edge[],
  seedId: string,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  if (!nodeById.has(seedId)) return positions;

  const childMap = new Map<string, string[]>();
  for (const edge of edges) {
    const arr = childMap.get(edge.sourceNodeId) ?? [];
    arr.push(edge.targetNodeId);
    childMap.set(edge.sourceNodeId, arr);
  }

  const buildHierarchy = (id: string): HierarchyDatum & { children?: HierarchyDatum[] } => ({
    id,
    children: (childMap.get(id) ?? []).map(buildHierarchy),
  });

  const root = hierarchy<HierarchyDatum>(buildHierarchy(seedId));
  const layout = tree<HierarchyDatum>().nodeSize([NODE_W + H_GAP, NODE_H + V_GAP]);
  const laidOut = layout(root);

  laidOut.each((n) => {
    positions.set(n.data.id, { x: n.x, y: n.y });
  });

  return positions;
}

export function MapView({
  userId,
  canvasId,
  activeNodeId,
  onPickNode,
}: {
  userId: string;
  canvasId: string;
  activeNodeId: string | null;
  onPickNode: (nodeId: string) => void;
}) {
  const [data, setData] = useState<{
    nodes: Node[];
    edges: Edge[];
    seedId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    getCanvas(userId, canvasId)
      .then((res) => {
        setData({
          nodes: res.nodes,
          edges: res.edges,
          seedId: res.canvas.seedNodeId,
        });
      })
      .catch((e) => setError(String(e)));
  }, [userId, canvasId]);

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!data) return { rfNodes: [] as RFNode[], rfEdges: [] as RFEdge[] };

    const positions = computeLayout(data.nodes, data.edges, data.seedId);
    const outboundCounts = new Map<string, number>();
    const citationByTarget = new Map<string, string>();
    for (const e of data.edges) {
      outboundCounts.set(
        e.sourceNodeId,
        (outboundCounts.get(e.sourceNodeId) ?? 0) + 1,
      );
      citationByTarget.set(e.targetNodeId, e.citationText);
    }

    const rfNodes: RFNode<NodeData>[] = data.nodes.map((n) => {
      const pos = positions.get(n.id) ?? { x: 0, y: 0 };
      return {
        id: n.id,
        type: "canvas",
        position: { x: pos.x - NODE_W / 2, y: pos.y },
        // Explicit dimensions so React Flow (esp. the minimap) knows the
        // node's bounding box without waiting for DOM measurement.
        width: NODE_W,
        height: NODE_H,
        data: {
          title: n.title,
          citation: citationByTarget.get(n.id) ?? null,
          outboundCount: outboundCounts.get(n.id) ?? 0,
          isActive: n.id === activeNodeId,
          isSeed: n.id === data.seedId,
        },
        draggable: false,
        selectable: false,
      };
    });

    const rfEdges: RFEdge[] = data.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      type: "smoothstep",
      animated: false,
      style: {
        stroke: "color-mix(in srgb, CanvasText 30%, Canvas)",
        strokeWidth: 1.5,
      },
    }));

    return { rfNodes, rfEdges };
  }, [data, activeNodeId]);

  if (error) {
    return (
      <div style={{ padding: "1.5rem", color: "crimson" }}>{error}</div>
    );
  }
  if (!data) {
    return <div style={{ padding: "1.5rem", color: "#888" }}>Loading map…</div>;
  }

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_, node) => onPickNode(node.id)}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        {data.nodes.length >= 6 && (
          <MiniMap
            pannable
            zoomable
            bgColor="#1f2937"
            nodeColor={(node) => {
              const d = node.data as NodeData | undefined;
              if (d?.isActive) return "#60a5fa";
              return "#cbd5e1";
            }}
            nodeStrokeColor="#0f172a"
            nodeStrokeWidth={1}
            nodeBorderRadius={3}
            maskColor="rgba(0, 0, 0, 0.5)"
            maskStrokeColor="#60a5fa"
            maskStrokeWidth={2}
            style={{
              border: "1px solid #374151",
              borderRadius: 6,
            }}
          />
        )}
      </ReactFlow>
    </div>
  );
}
