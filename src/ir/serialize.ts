/**
 * IR JSON serializer for `weave ir`.
 *
 * ID normalization strategy:
 *   - node/port IDs (p0, n0, …): per-graph scope — wires are graph-local
 *   - provenance sourceIds (s0, …): document-level scope — the same surface
 *     AST node must map to the same label everywhere in the exported document
 *     so playground/sidebar tooling can select all IR nodes from one source
 *     construct across nested branch and algebra graphs.
 *
 * Provenance spans and roles are kept intact: spans are the source-map used
 * by editor tooling; roles are human-readable and do not contain raw IDs.
 */

import type { Graph, Node, Port, Provenance, Wire } from "./ir.ts";

export type IrExport = {
  weave: "1";
  def:   string;
  graph: object;
};

export function serializeGraph(defName: string, graph: Graph): IrExport {
  const doc = mkDoc();
  return { weave: "1", def: defName, graph: emitGraph(doc, graph) };
}

// ---------------------------------------------------------------------------
// Document-level source scope (shared across all graphs in one export)
// ---------------------------------------------------------------------------

interface Doc {
  sourceMap:   Map<string, string>;
  sourceCount: number;
}

function mkDoc(): Doc {
  return { sourceMap: new Map(), sourceCount: 0 };
}

function assignSource(doc: Doc, id: string): void {
  if (!doc.sourceMap.has(id)) doc.sourceMap.set(id, `s${doc.sourceCount++}`);
}

function rs(doc: Doc, id: string): string {
  return doc.sourceMap.get(id) ?? id;
}

// ---------------------------------------------------------------------------
// Per-graph scope (fresh for each graph; wires only reference local ports)
// ---------------------------------------------------------------------------

interface Scope {
  portMap:   Map<string, string>;
  nodeMap:   Map<string, string>;
  portCount: number;
  nodeCount: number;
}

function mkScope(): Scope {
  return { portMap: new Map(), nodeMap: new Map(), portCount: 0, nodeCount: 0 };
}

function assignPort(sc: Scope, id: string): void {
  if (!sc.portMap.has(id)) sc.portMap.set(id, `p${sc.portCount++}`);
}

function assignNode(sc: Scope, id: string): void {
  if (!sc.nodeMap.has(id)) sc.nodeMap.set(id, `n${sc.nodeCount++}`);
}

function rp(sc: Scope, id: string): string {
  return sc.portMap.get(id) ?? id;
}

function rn(sc: Scope, id: string): string {
  return sc.nodeMap.get(id) ?? id;
}

// ---------------------------------------------------------------------------
// Pre-pass: assign labels in stable traversal order
// ---------------------------------------------------------------------------

function scanProvenance(doc: Doc, provenance: Provenance[]): void {
  for (const p of provenance) assignSource(doc, p.sourceId);
}

function scanGraph(doc: Doc, sc: Scope, graph: Graph): void {
  scanProvenance(doc, graph.provenance);
  assignPort(sc, graph.inPort.id);
  assignPort(sc, graph.outPort.id);
  for (const node of graph.nodes) {
    assignNode(sc, node.id);
    scanProvenance(doc, node.provenance);
    scanNodePorts(sc, node);
  }
}

function scanNodePorts(sc: Scope, node: Node): void {
  switch (node.kind) {
    case "const":
      assignPort(sc, node.output.id);
      break;
    case "dup":
      assignPort(sc, node.input.id);
      for (const o of node.outputs) assignPort(sc, o.id);
      break;
    case "drop":
    case "proj":
    case "ctor":
    case "effect":
    case "ref":
      assignPort(sc, node.input.id);
      assignPort(sc, node.output.id);
      break;
    case "tuple":
      for (const inp of node.inputs) assignPort(sc, inp.port.id);
      assignPort(sc, node.output.id);
      break;
    case "case":
    case "cata":
      assignPort(sc, node.input.id);
      assignPort(sc, node.output.id);
      // nested graphs get their own scope — not scanned here
      break;
  }
}

// ---------------------------------------------------------------------------
// Emit pass: build plain JSON-serializable objects
// ---------------------------------------------------------------------------

function emitProvenance(doc: Doc, provenance: Provenance[]): object[] {
  return provenance.map(p => ({
    sourceId: rs(doc, p.sourceId),
    ...(p.span !== undefined ? { span: p.span } : {}),
    ...(p.role !== undefined ? { role: p.role } : {}),
  }));
}

function emitPort(sc: Scope, p: Port): object {
  return { id: rp(sc, p.id), ty: p.ty };
}

function emitWire(sc: Scope, w: Wire): object {
  return { from: rp(sc, w.from), to: rp(sc, w.to) };
}

function emitNode(doc: Doc, sc: Scope, node: Node): object {
  const base = { kind: node.kind, id: rn(sc, node.id), effect: node.effect,
                 provenance: emitProvenance(doc, node.provenance) };
  switch (node.kind) {
    case "const":
      return { ...base, value: node.value, output: emitPort(sc, node.output) };
    case "dup":
      return { ...base, input: emitPort(sc, node.input), outputs: node.outputs.map(o => emitPort(sc, o)) };
    case "drop":
      return { ...base, input: emitPort(sc, node.input), output: emitPort(sc, node.output) };
    case "proj":
      return { ...base, field: node.field, input: emitPort(sc, node.input), output: emitPort(sc, node.output) };
    case "tuple":
      return { ...base,
        inputs: node.inputs.map(inp => ({ label: inp.label, port: emitPort(sc, inp.port) })),
        output: emitPort(sc, node.output),
      };
    case "ctor":
      return { ...base, ctorName: node.ctorName, adtTy: node.adtTy,
        input: emitPort(sc, node.input), output: emitPort(sc, node.output) };
    case "effect":
      return { ...base, op: node.op, input: emitPort(sc, node.input), output: emitPort(sc, node.output) };
    case "ref":
      return { ...base, defId: node.defId, input: emitPort(sc, node.input), output: emitPort(sc, node.output) };
    case "case":
      return { ...base,
        variantTy: node.variantTy, outTy: node.outTy,
        ...(node.field     !== undefined ? { field:     node.field     } : {}),
        ...(node.contextTy !== undefined ? { contextTy: node.contextTy } : {}),
        input:    emitPort(sc, node.input),
        output:   emitPort(sc, node.output),
        branches: node.branches.map(b => ({ tag: b.tag, rawPayloadTy: b.rawPayloadTy, graph: emitGraph(doc, b.graph) })),
      };
    case "cata":
      return { ...base, adtTy: node.adtTy, carrierTy: node.carrierTy,
        input:   emitPort(sc, node.input),
        output:  emitPort(sc, node.output),
        algebra: node.algebra.map(b => ({ tag: b.tag, rawPayloadTy: b.rawPayloadTy, graph: emitGraph(doc, b.graph) })),
      };
  }
}

function emitGraph(doc: Doc, graph: Graph): object {
  const sc = mkScope();
  scanGraph(doc, sc, graph);
  return {
    inPort:     emitPort(sc, graph.inPort),
    outPort:    emitPort(sc, graph.outPort),
    effect:     graph.effect,
    nodes:      graph.nodes.map(n => emitNode(doc, sc, n)),
    wires:      graph.wires.map(w => emitWire(sc, w)),
    provenance: emitProvenance(doc, graph.provenance),
  };
}
