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
import type { Type, ConcreteEffect } from "../../../src/types/type.ts";
import type { SourceNodeId, SourceSpan } from "../../../src/surface/id.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID    = "@@source";
const SINK_ID      = "@@sink";
const NODE_W       = 140;
const BOUNDARY_W   = 36;
const PORT_SPACING = 18;
const MIN_H        = 36;
const PAD_H        = 20;

export const CONTAINER_PAD      = 12;
export const CONTAINER_HEADER_H = 22;

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
  ty:     Type;
};

export type RenderedNode = {
  id:         string;
  label:      string;
  kind:       string;
  effect:     ConcreteEffect;
  x:          number;
  y:          number;
  width:      number;
  height:     number;
  inPorts:    RenderedPort[];
  outPorts:   RenderedPort[];
  span?:      SourceSpan;
  sourceIds:  SourceNodeId[];
  expandable: boolean;
  expanded:   boolean;
};

export type RenderedEdge = {
  fromPortId: PortId;
  toPortId:   PortId;
};

export type ExpansionInfo =
  | { kind: "ref"; graph: Graph; defName: string };

export type SubLayout =
  | { kind: "ref"; layout: RenderedLayout; label: string };

export type RenderedLayout = {
  nodes:       RenderedNode[];
  edges:       RenderedEdge[];
  outPortPos:  Map<PortId, PortPos>;
  inPortPos:   Map<PortId, PortPos>;
  portTypeMap: Map<PortId, Type>;    // portId → type, for wire tooltip lookup
  width:       number;
  height:      number;
  subLayouts:  Map<string, SubLayout>;
};

// ---------------------------------------------------------------------------
// Port lists per node kind (includes type info from IR ports)
// ---------------------------------------------------------------------------

type PortEntry    = { portId: PortId; label?: string; ty: Type };
type NodePortList = { inPorts: PortEntry[]; outPorts: PortEntry[] };

function getNodePorts(node: Node): NodePortList {
  switch (node.kind) {
    case "dup":
      return {
        inPorts:  [{ portId: node.input.id, ty: node.input.ty }],
        outPorts: node.outputs.map((p, i) => ({ portId: p.id, label: String(i), ty: p.ty })),
      };
    case "tuple":
      return {
        inPorts:  node.inputs.map(inp => ({ portId: inp.port.id, label: inp.label, ty: inp.port.ty })),
        outPorts: [{ portId: node.output.id, ty: node.output.ty }],
      };
    case "const":
      return { inPorts: [], outPorts: [{ portId: node.output.id, ty: node.output.ty }] };
    default:
      return {
        inPorts:  [{ portId: node.input.id,  ty: node.input.ty  }],
        outPorts: [{ portId: node.output.id, ty: node.output.ty }],
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
// Port y-position within a node (centered around node.y)
// ---------------------------------------------------------------------------

function portY(nodeY: number, index: number, total: number): number {
  return nodeY - ((total - 1) * PORT_SPACING) / 2 + index * PORT_SPACING;
}

// ---------------------------------------------------------------------------
// Main layout function
// ---------------------------------------------------------------------------

export function layoutGraph(
  graph:          Graph,
  spanMap?:       Map<SourceNodeId, SourceSpan>,
  expanded?:      Map<string, ExpansionInfo>,
  availableDefs?: Set<string>,
): RenderedLayout {
  // ── Collect all port → owner-node mappings ──────────────────────────────
  const outPorts = new Map<PortId, string>();
  const inPorts  = new Map<PortId, string>();

  outPorts.set(graph.inPort.id,  SOURCE_ID);
  inPorts.set(graph.outPort.id,  SINK_ID);

  const allPorts = new Map<string, NodePortList>();
  allPorts.set(SOURCE_ID, { inPorts: [], outPorts: [{ portId: graph.inPort.id,  ty: graph.inPort.ty  }] });
  allPorts.set(SINK_ID,   { inPorts: [{ portId: graph.outPort.id, ty: graph.outPort.ty }], outPorts: [] });

  for (const node of graph.nodes) {
    const ports = getNodePorts(node);
    allPorts.set(node.id, ports);
    for (const p of ports.outPorts) outPorts.set(p.portId, node.id);
    for (const p of ports.inPorts)  inPorts.set(p.portId,  node.id);
  }

  // ── Pre-compute sub-layouts for expanded nodes ───────────────────────────

  const subLayouts    = new Map<string, SubLayout>();
  const containerDims = new Map<string, { w: number; h: number }>();

  for (const [nodeId, info] of (expanded ?? [])) {
    if (info.kind === "ref") {
      const sub = layoutGraph(info.graph, spanMap);  // no nested expansion
      subLayouts.set(nodeId, { kind: "ref", layout: sub, label: `ref: ${info.defName}` });
      containerDims.set(nodeId, {
        w: sub.width  + CONTAINER_PAD * 2,
        h: sub.height + CONTAINER_HEADER_H + CONTAINER_PAD * 2,
      });
    }
  }

  // ── Build Dagre graph ────────────────────────────────────────────────────

  const g = new graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 80, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  g.setNode(SOURCE_ID, { width: BOUNDARY_W, height: MIN_H });
  g.setNode(SINK_ID,   { width: BOUNDARY_W, height: MIN_H });

  for (const node of graph.nodes) {
    const container = containerDims.get(node.id);
    if (container) {
      g.setNode(node.id, { width: container.w, height: container.h });
    } else {
      const ports = allPorts.get(node.id)!;
      const h = Math.max(MIN_H, Math.max(ports.inPorts.length, ports.outPorts.length) * PORT_SPACING + PAD_H);
      g.setNode(node.id, { width: NODE_W, height: h });
    }
  }

  // ── Collect all edges (implicit + explicit) ──────────────────────────────

  const renderedEdges: RenderedEdge[] = [];
  const addedEdgePairs = new Set<string>();

  function addEdge(fromNodeId: string, toNodeId: string, fromPortId: PortId, toPortId: PortId, edgeName: string) {
    const key = `${fromNodeId}→${toNodeId}:${fromPortId}→${toPortId}`;
    if (addedEdgePairs.has(key)) return;
    addedEdgePairs.add(key);
    g.setEdge(fromNodeId, toNodeId, {}, edgeName);
    renderedEdges.push({ fromPortId, toPortId });
  }

  for (const [portId, fromNodeId] of outPorts) {
    const toNodeId = inPorts.get(portId);
    if (toNodeId !== undefined && toNodeId !== fromNodeId) {
      addEdge(fromNodeId, toNodeId, portId, portId, `shared-${portId}`);
    }
  }

  for (let i = 0; i < graph.wires.length; i++) {
    const wire       = graph.wires[i]!;
    const fromNodeId = outPorts.get(wire.from);
    const toNodeId   = inPorts.get(wire.to);
    if (fromNodeId !== undefined && toNodeId !== undefined) {
      addEdge(fromNodeId, toNodeId, wire.from, wire.to, `wire-${i}`);
    }
  }

  // ── Source-order layout hints ────────────────────────────────────────────
  // Use Dagre's `constraints` option ({left, right} pairs) to enforce
  // within-rank ordering without touching the graph or rank assignment.
  // For dup (fan-out) nodes: order successors by port index.
  // For tuple (fan-in) nodes: order predecessors by field order.

  const succOfOutPort = new Map<PortId, string>();
  const predOfInPort  = new Map<PortId, string>();

  for (const [portId, fromId] of outPorts) {
    const toId = inPorts.get(portId);
    if (toId !== undefined && toId !== fromId) {
      succOfOutPort.set(portId, toId);
      predOfInPort.set(portId, fromId);
    }
  }
  for (const wire of graph.wires) {
    const fromId = outPorts.get(wire.from);
    const toId   = inPorts.get(wire.to);
    if (fromId !== undefined && toId !== undefined) {
      succOfOutPort.set(wire.from, toId);
      predOfInPort.set(wire.to, fromId);
    }
  }

  const constraints: { left: string; right: string }[] = [];
  for (const node of graph.nodes) {
    const ports = allPorts.get(node.id)!;

    if (node.kind === "dup") {
      const succs = ports.outPorts
        .map(p => succOfOutPort.get(p.portId))
        .filter((id): id is string => id !== undefined);
      for (let i = 0; i < succs.length - 1; i++) {
        const a = succs[i]!, b = succs[i + 1]!;
        if (a !== b) constraints.push({ left: a, right: b });
      }
    }

    if (node.kind === "tuple") {
      const preds = ports.inPorts
        .map(p => predOfInPort.get(p.portId))
        .filter((id): id is string => id !== undefined);
      for (let i = 0; i < preds.length - 1; i++) {
        const a = preds[i]!, b = preds[i + 1]!;
        if (a !== b) constraints.push({ left: a, right: b });
      }
    }
  }

  // ── Run Dagre layout ─────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dagreLayout as any)(g, constraints.length ? { constraints } : {});

  const graphMeta = g.graph() as { width?: number; height?: number };

  // ── Extract positioned nodes + compute port positions ────────────────────

  const renderedNodes: RenderedNode[] = [];
  const outPortPos    = new Map<PortId, PortPos>();
  const inPortPos     = new Map<PortId, PortPos>();
  const portTypeMap   = new Map<PortId, Type>();

  for (const nodeId of g.nodes()) {
    const n     = g.node(nodeId) as { x: number; y: number; width: number; height: number };
    const ports = allPorts.get(nodeId)!;

    const inPortsR: RenderedPort[] = ports.inPorts.map((p, i) => {
      inPortPos.set(p.portId, { x: n.x - n.width / 2, y: portY(n.y, i, ports.inPorts.length) });
      portTypeMap.set(p.portId, p.ty);
      return { portId: p.portId, side: "in", index: i, total: ports.inPorts.length, label: p.label, ty: p.ty };
    });

    const outPortsR: RenderedPort[] = ports.outPorts.map((p, i) => {
      outPortPos.set(p.portId, { x: n.x + n.width / 2, y: portY(n.y, i, ports.outPorts.length) });
      portTypeMap.set(p.portId, p.ty);
      return { portId: p.portId, side: "out", index: i, total: ports.outPorts.length, label: p.label, ty: p.ty };
    });

    const irNode  = graph.nodes.find(nd => nd.id === nodeId);
    const isSource = nodeId === SOURCE_ID;
    const isSink   = nodeId === SINK_ID;

    const span = (() => {
      for (const p of (irNode?.provenance ?? [])) {
        const s = (spanMap && spanMap.get(p.sourceId)) ?? p.span;
        if (s) return s;
      }
      return undefined;
    })();

    const isExpandable = !isSource && !isSink && irNode?.kind === "ref"
      && (availableDefs?.has(irNode.defId) ?? false);
    renderedNodes.push({
      id:         nodeId,
      label:      isSource ? "in" : isSink ? "out" : nodeLabel(irNode!),
      kind:       isSource ? "source" : isSink ? "sink" : (irNode?.kind ?? "unknown"),
      effect:     isSource || isSink ? "pure" : (irNode?.effect ?? "pure"),
      x:          n.x,
      y:          n.y,
      width:      n.width,
      height:     n.height,
      inPorts:    inPortsR,
      outPorts:   outPortsR,
      span,
      sourceIds:  (irNode?.provenance ?? []).map(p => p.sourceId),
      expandable: isExpandable,
      expanded:   isExpandable && (expanded?.has(nodeId) ?? false),
    });
  }

  return {
    nodes: renderedNodes,
    edges: renderedEdges,
    outPortPos,
    inPortPos,
    portTypeMap,
    width:      graphMeta.width  ?? 400,
    height:     graphMeta.height ?? 300,
    subLayouts,
  };
}
