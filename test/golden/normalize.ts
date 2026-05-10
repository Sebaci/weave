/**
 * IR normalizer for golden snapshot tests.
 *
 * Replaces globally incrementing graph/node/port IDs with stable positional
 * labels (node[0], port[0], …) scoped per graph so that snapshots remain
 * meaningful even if elaboration-counter start values change across tests.
 *
 * Each nested branch/algebra graph gets its own fresh label scope.
 */

import type { ElaboratedModule, Graph, Node, Port, Wire } from "../../src/ir/ir.ts";
import { showType } from "../../src/typechecker/index.ts";

// ---------------------------------------------------------------------------
// Label context — one per graph scope
// ---------------------------------------------------------------------------

interface Ctx {
  portMap:   Map<string, string>;
  nodeMap:   Map<string, string>;
  portCount: number;
  nodeCount: number;
}

function mkCtx(): Ctx {
  return { portMap: new Map(), nodeMap: new Map(), portCount: 0, nodeCount: 0 };
}

function allocPort(ctx: Ctx, id: string, hint?: string): void {
  if (!ctx.portMap.has(id)) ctx.portMap.set(id, hint ?? `port[${ctx.portCount++}]`);
}

function allocNode(ctx: Ctx, id: string): void {
  if (!ctx.nodeMap.has(id)) ctx.nodeMap.set(id, `node[${ctx.nodeCount++}]`);
}

function getPort(ctx: Ctx, id: string): string {
  return ctx.portMap.get(id) ?? `?port(${id})`;
}

function getNode(ctx: Ctx, id: string): string {
  return ctx.nodeMap.get(id) ?? `?node(${id})`;
}

// ---------------------------------------------------------------------------
// Pre-pass: assign labels in stable traversal order
// ---------------------------------------------------------------------------

function preassign(ctx: Ctx, graph: Graph): void {
  // in/out ports of the graph get fixed labels
  allocPort(ctx, graph.inPort.id, "in");
  allocPort(ctx, graph.outPort.id, "out");

  for (const node of graph.nodes) {
    allocNode(ctx, node.id);
    preassignPorts(ctx, node);
  }
}

function preassignPorts(ctx: Ctx, node: Node): void {
  switch (node.kind) {
    case "const":
      allocPort(ctx, node.output.id);
      break;
    case "dup":
      allocPort(ctx, node.input.id);
      for (const o of node.outputs) allocPort(ctx, o.id);
      break;
    case "drop":
    case "proj":
    case "ctor":
    case "effect":
    case "ref":
      allocPort(ctx, node.input.id);
      allocPort(ctx, node.output.id);
      break;
    case "tuple":
      for (const inp of node.inputs) allocPort(ctx, inp.port.id);
      allocPort(ctx, node.output.id);
      break;
    case "case":
    case "cata":
      allocPort(ctx, node.input.id);
      allocPort(ctx, node.output.id);
      break;
  }
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function normPort(ctx: Ctx, port: Port): { label: string; ty: string } {
  return { label: getPort(ctx, port.id), ty: showType(port.ty) };
}

function renderWire(ctx: Ctx, wire: Wire): { from: string; to: string } {
  return { from: getPort(ctx, wire.from), to: getPort(ctx, wire.to) };
}

function renderNode(ctx: Ctx, node: Node): object {
  const label = getNode(ctx, node.id);
  const provenance = node.provenance.length > 0;

  switch (node.kind) {
    case "const":
      return { label, kind: "const", effect: node.effect, value: node.value,
               output: normPort(ctx, node.output), provenance };

    case "dup":
      return { label, kind: "dup", effect: node.effect,
               input: normPort(ctx, node.input),
               outputs: node.outputs.map((o) => normPort(ctx, o)),
               provenance };

    case "drop":
      return { label, kind: "drop", effect: node.effect,
               input: normPort(ctx, node.input),
               output: normPort(ctx, node.output),
               provenance };

    case "proj":
      return { label, kind: "proj", effect: node.effect, field: node.field,
               input: normPort(ctx, node.input),
               output: normPort(ctx, node.output),
               provenance };

    case "tuple":
      return { label, kind: "tuple", effect: node.effect,
               inputs: node.inputs.map((i) => ({ label: i.label, port: normPort(ctx, i.port) })),
               output: normPort(ctx, node.output),
               provenance };

    case "ctor":
      return { label, kind: "ctor", effect: node.effect,
               ctorName: node.ctorName, adtTy: showType(node.adtTy),
               input: normPort(ctx, node.input),
               output: normPort(ctx, node.output),
               provenance };

    case "ref":
      return { label, kind: "ref", effect: node.effect, defId: node.defId,
               input: normPort(ctx, node.input),
               output: normPort(ctx, node.output),
               provenance };

    case "effect":
      return { label, kind: "effect", effect: node.effect, op: node.op,
               input: normPort(ctx, node.input),
               output: normPort(ctx, node.output),
               provenance };

    case "case":
      return { label, kind: "case", effect: node.effect,
               variantTy: showType(node.variantTy),
               outTy: showType(node.outTy),
               field: node.field,
               contextTy: node.contextTy !== undefined ? showType(node.contextTy) : undefined,
               input: normPort(ctx, node.input),
               output: normPort(ctx, node.output),
               branches: node.branches.map((b) => ({
                 tag: b.tag,
                 rawPayloadTy: b.rawPayloadTy !== undefined ? showType(b.rawPayloadTy) : undefined,
                 graph: normalizeGraph(b.graph),
               })),
               provenance };

    case "cata":
      return { label, kind: "cata", effect: node.effect,
               adtTy: showType(node.adtTy),
               carrierTy: showType(node.carrierTy),
               input: normPort(ctx, node.input),
               output: normPort(ctx, node.output),
               algebra: node.algebra.map((b) => ({
                 tag: b.tag,
                 rawPayloadTy: showType(b.rawPayloadTy),
                 graph: normalizeGraph(b.graph),
               })),
               provenance };
  }
}

// ---------------------------------------------------------------------------
// Public: normalize a single graph (fresh scope)
// ---------------------------------------------------------------------------

export function normalizeGraph(graph: Graph): object {
  const ctx = mkCtx();
  preassign(ctx, graph);
  return {
    effect:     graph.effect,
    provenance: graph.provenance.length > 0,
    inPort:     normPort(ctx, graph.inPort),
    outPort:    normPort(ctx, graph.outPort),
    nodes:      graph.nodes.map((n) => renderNode(ctx, n)),
    wires:      graph.wires.map((w) => renderWire(ctx, w)),
  };
}

// ---------------------------------------------------------------------------
// Public: normalize all monomorphic defs in an elaborated module
// ---------------------------------------------------------------------------

export function normalizeModule(m: ElaboratedModule): Record<string, object> {
  const out: Record<string, object> = {};
  for (const [name, graph] of m.defs) out[name] = normalizeGraph(graph);
  return out;
}
