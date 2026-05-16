/**
 * IR Graph → Dagre layout → RenderedLayout.
 *
 * Two kinds of connections exist in the Weave IR:
 *
 *   1. Explicit wires: { from: portA, to: portB } with portA ≠ portB.
 *      These are the Wire[] entries on the graph.
 *
 *   2. Implicit (shared-port) wiring: node A's output port has the same ID
 *      as node B's input port.  Sequential composition is represented this
 *      way — there is no ComposeNode.  No Wire entry exists for them.
 *
 * We detect both kinds and add them as edges to the Dagre layout graph.
 * Dagre is used only for x/y positioning; the Weave IR is the source of truth.
 */
import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import type { Graph, Node, PortId } from "../../../src/ir/ir.ts";
import type { SourceNodeId, SourceSpan } from "../../../src/surface/id.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID   = "@@source";
const SINK_ID     = "@@sink";
const NODE_W      = 140;
const BOUNDARY_W  = 36;
const PORT_SPACING = 18;
const MIN_H       = 36;
const PAD_H       = 20;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PortPos = { x: number; y: number };

export type RenderedPort = {
  portId: PortId;
  side:   "in" | "out";
  index:  number;
  total:  number;
  label?: string;
};

export type RenderedNode = {
  id:       string;
  label:    string;
  kind:     string;
  tooltip:  string;
  x:        number;
  y:        number;
  width:    number;
  height:   number;
  inPorts:  RenderedPort[];
  outPorts: RenderedPort[];
  span?:    SourceSpan;
};

export type RenderedEdge = {
  fromPortId: PortId;   // look up in outPortPos
  toPortId:   PortId;   // look up in inPortPos
};

export type RenderedLayout = {
  nodes:      RenderedNode[];
  edges:      RenderedEdge[];
  outPortPos: Map<PortId, PortPos>;  // port → position on right edge of owner
  inPortPos:  Map<PortId, PortPos>;  // port → position on left edge of owner
  width:      number;
  height:     number;
};

// ---------------------------------------------------------------------------
// Port lists per node kind
// ---------------------------------------------------------------------------

type PortEntry   = { portId: PortId; label?: string };
type NodePortList = { inPorts: PortEntry[]; outPorts: PortEntry[] };

function getNodePorts(node: Node): NodePortList {
  switch (node.kind) {
    case "dup":
      return {
        inPorts:  [{ portId: node.input.id }],
        outPorts: node.outputs.map((p, i) => ({ portId: p.id, label: String(i) })),
      };
    case "tuple":
      return {
        inPorts:  node.inputs.map(inp => ({ portId: inp.port.id, label: inp.label })),
        outPorts: [{ portId: node.output.id }],
      };
    case "const":
      return { inPorts: [], outPorts: [{ portId: node.output.id }] };
    default:
      return {
        inPorts:  [{ portId: node.input.id }],
        outPorts: [{ portId: node.output.id }],
      };
  }
}

// ---------------------------------------------------------------------------
// Node label
// ---------------------------------------------------------------------------

function nodeLabel(node: Node): string {
  switch (node.kind) {
    case "ref":   return node.defId.split(".").pop() ?? node.defId;
    case "const": {
      const v = node.value;
      if (v.tag === "text") return `"${v.value.length > 12 ? v.value.slice(0, 12) + "…" : v.value}"`;
      if (v.tag === "unit") return "()";
      return String(v.value);
    }
    case "tuple":  return `{${node.inputs.map(i => i.label).join(", ")}}`;
    case "dup":    return `dup ×${node.outputs.length}`;
    case "proj":   return `.${node.field}`;
    case "drop":   return "drop";
    case "ctor":   return node.ctorName;
    case "case":   return node.field ? `case .${node.field}` : "case";
    case "cata":   return "fold";
    case "effect": return node.op;
  }
}

// ---------------------------------------------------------------------------
// Node tooltip (richer than label — shown on hover)
// ---------------------------------------------------------------------------

function nodeTooltip(node: Node): string {
  switch (node.kind) {
    case "ref":    return `ref: ${node.defId}`;
    case "const": {
      const v = node.value;
      if (v.tag === "text")  return `const: "${v.value}"`;
      if (v.tag === "unit")  return "const: ()";
      return `const: ${String(v.value)}`;
    }
    case "dup":    return `dup × ${node.outputs.length}`;
    case "proj":   return `.${node.field}`;
    case "ctor":   return `ctor: ${node.ctorName}`;
    case "effect": return `effect: ${node.op}`;
    case "tuple":  return `tuple {${node.inputs.map(i => i.label).join(", ")}}`;
    case "case":   return node.field ? `case .${node.field}` : "case";
    case "cata":   return "fold (catamorphism)";
    case "drop":   return "drop (discard input)";
  }
}

// ---------------------------------------------------------------------------
// Port y-position within a node (centered around node.y)
// ---------------------------------------------------------------------------

function portY(nodeY: number, index: number, total: number): number {
  return nodeY - ((total - 1) * PORT_SPACING) / 2 + index * PORT_SPACING;
}

// ---------------------------------------------------------------------------
// Main layout function
// ---------------------------------------------------------------------------

export function layoutGraph(graph: Graph, spanMap?: Map<SourceNodeId, SourceSpan>): RenderedLayout {
  // ── Collect all port → owner-node mappings ──────────────────────────────
  //
  // outPorts: portId → nodeId that produces this port as an output
  // inPorts:  portId → nodeId that consumes this port as an input
  //
  // When the same portId appears in both maps, the two nodes are
  // directly wired (implicit / shared-port connection).

  const outPorts = new Map<PortId, string>(); // portId → nodeId
  const inPorts  = new Map<PortId, string>(); // portId → nodeId

  outPorts.set(graph.inPort.id,  SOURCE_ID);
  inPorts.set(graph.outPort.id,  SINK_ID);

  // Per-node port lists (kept for position computation later)
  const allPorts = new Map<string, NodePortList>();
  allPorts.set(SOURCE_ID, { inPorts: [], outPorts: [{ portId: graph.inPort.id }] });
  allPorts.set(SINK_ID,   { inPorts: [{ portId: graph.outPort.id }], outPorts: [] });

  for (const node of graph.nodes) {
    const ports = getNodePorts(node);
    allPorts.set(node.id, ports);
    for (const p of ports.outPorts) outPorts.set(p.portId, node.id);
    for (const p of ports.inPorts)  inPorts.set(p.portId,  node.id);
  }

  // ── Build Dagre graph ────────────────────────────────────────────────────

  const g = new graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 80, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  g.setNode(SOURCE_ID, { width: BOUNDARY_W, height: MIN_H });
  g.setNode(SINK_ID,   { width: BOUNDARY_W, height: MIN_H });

  for (const node of graph.nodes) {
    const ports = allPorts.get(node.id)!;
    const h = Math.max(MIN_H, Math.max(ports.inPorts.length, ports.outPorts.length) * PORT_SPACING + PAD_H);
    g.setNode(node.id, { width: NODE_W, height: h });
  }

  // ── Collect all edges (implicit + explicit) ───────────────────────────────

  const renderedEdges: RenderedEdge[] = [];
  const addedEdgePairs = new Set<string>();

  function addEdge(fromNodeId: string, toNodeId: string, fromPortId: PortId, toPortId: PortId, edgeName: string) {
    const key = `${fromNodeId}→${toNodeId}:${fromPortId}→${toPortId}`;
    if (addedEdgePairs.has(key)) return;
    addedEdgePairs.add(key);
    g.setEdge(fromNodeId, toNodeId, {}, edgeName);
    renderedEdges.push({ fromPortId, toPortId });
  }

  // Implicit: shared port IDs (outPort of A == inPort of B)
  for (const [portId, fromNodeId] of outPorts) {
    const toNodeId = inPorts.get(portId);
    if (toNodeId !== undefined && toNodeId !== fromNodeId) {
      addEdge(fromNodeId, toNodeId, portId, portId, `shared-${portId}`);
    }
  }

  // Explicit wires
  for (let i = 0; i < graph.wires.length; i++) {
    const wire       = graph.wires[i]!;
    const fromNodeId = outPorts.get(wire.from);
    const toNodeId   = inPorts.get(wire.to);
    if (fromNodeId !== undefined && toNodeId !== undefined) {
      addEdge(fromNodeId, toNodeId, wire.from, wire.to, `wire-${i}`);
    }
  }

  // ── Run Dagre layout ─────────────────────────────────────────────────────

  dagreLayout(g);

  const graphMeta = g.graph() as { width?: number; height?: number };

  // ── Extract positioned nodes + compute port positions ────────────────────

  const renderedNodes: RenderedNode[] = [];
  const outPortPos    = new Map<PortId, PortPos>(); // right edge of owner
  const inPortPos     = new Map<PortId, PortPos>(); // left edge of owner

  for (const nodeId of g.nodes()) {
    const n     = g.node(nodeId) as { x: number; y: number; width: number; height: number };
    const ports = allPorts.get(nodeId)!;

    const inPortsR: RenderedPort[] = ports.inPorts.map((p, i) => {
      inPortPos.set(p.portId, { x: n.x - n.width / 2, y: portY(n.y, i, ports.inPorts.length) });
      return { portId: p.portId, side: "in", index: i, total: ports.inPorts.length, label: p.label };
    });

    const outPortsR: RenderedPort[] = ports.outPorts.map((p, i) => {
      outPortPos.set(p.portId, { x: n.x + n.width / 2, y: portY(n.y, i, ports.outPorts.length) });
      return { portId: p.portId, side: "out", index: i, total: ports.outPorts.length, label: p.label };
    });

    const irNode = graph.nodes.find(nd => nd.id === nodeId);
    const isSource = nodeId === SOURCE_ID;
    const isSink   = nodeId === SINK_ID;

    const span = (() => {
      for (const p of (irNode?.provenance ?? [])) {
        const s = (spanMap && spanMap.get(p.sourceId)) ?? p.span;
        if (s) return s;
      }
      return undefined;
    })();

    const tooltip = isSource ? "graph input port"
      : isSink   ? "graph output port"
      : nodeTooltip(irNode!);

    renderedNodes.push({
      id:       nodeId,
      label:    isSource ? "in" : isSink ? "out" : nodeLabel(irNode!),
      kind:     isSource ? "source" : isSink ? "sink" : (irNode?.kind ?? "unknown"),
      tooltip,
      x:        n.x,
      y:        n.y,
      width:    n.width,
      height:   n.height,
      inPorts:  inPortsR,
      outPorts: outPortsR,
      span,
    });
  }

  return {
    nodes: renderedNodes,
    edges: renderedEdges,
    outPortPos,
    inPortPos,
    width:  graphMeta.width  ?? 400,
    height: graphMeta.height ?? 300,
  };
}
