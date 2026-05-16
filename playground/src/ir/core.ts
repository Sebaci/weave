/**
 * "Core" view: elaborated graph as categorical pipeline notation.
 *
 * Renders the IR graph using the fundamental categorical combinators:
 *   >>>   sequential composition
 *   dup   diagonal morphism  A → A ⊗ A
 *   ***   parallel product   (f *** g) : A⊗B → C⊗D
 *   drop  terminal morphism  A → I
 *   case  variant elimination
 *   cata  catamorphism
 *
 * When a dup >>> tensor pattern appears, an inline annotation shows the
 * equivalent derived combinator:  -- f &&& g
 *
 * Each leaf expression carries an optional SourceSpan so the HTML output
 * can embed data-span attributes for editor provenance highlighting.
 */

import type { Graph, Node, DupNode, LiteralValue, PortId } from "../../../src/ir/ir.ts";
import type { Type } from "../../../src/types/type.ts";
import type { SourceSpan, SourceNodeId } from "../../../src/surface/id.ts";

export type SpanMap = Map<SourceNodeId, SourceSpan>;

// ---------------------------------------------------------------------------
// Expression tree
// ---------------------------------------------------------------------------

type CoreExpr =
  | { tag: "id" }
  | { tag: "lit";    value: LiteralValue; span?: SourceSpan }
  | { tag: "ref";    name: string;        span?: SourceSpan }
  | { tag: "proj";   field: string;       span?: SourceSpan }
  | { tag: "ctor";   name: string;        span?: SourceSpan }
  | { tag: "drop";                        span?: SourceSpan }
  | { tag: "dup";                         span?: SourceSpan }
  | { tag: "effect"; op: string;          span?: SourceSpan }
  | { tag: "tensor"; branches: CoreExpr[] }
  | { tag: "case";   field?: string; branches: Array<{ ctor: string; expr: CoreExpr }>; span?: SourceSpan }
  | { tag: "cata";   branches: Array<{ ctor: string; expr: CoreExpr }>; span?: SourceSpan }
  | { tag: "pipe";   steps: CoreExpr[] };

// ---------------------------------------------------------------------------
// Graph maps
// ---------------------------------------------------------------------------

interface GraphMaps {
  wireFrom:  Map<PortId, PortId>;
  wireTo:    Map<PortId, PortId[]>;
  nodeByOut: Map<PortId, Node>;
  nodeByIn:  Map<PortId, Node>;
  dupByOut:  Map<PortId, DupNode>;
}

function buildMaps(graph: Graph): GraphMaps {
  const wireFrom  = new Map<PortId, PortId>();
  const wireTo    = new Map<PortId, PortId[]>();
  const nodeByOut = new Map<PortId, Node>();
  const nodeByIn  = new Map<PortId, Node>();
  const dupByOut  = new Map<PortId, DupNode>();

  for (const w of graph.wires) {
    wireFrom.set(w.to, w.from);
    const list = wireTo.get(w.from) ?? [];
    list.push(w.to);
    wireTo.set(w.from, list);
  }

  for (const node of graph.nodes) {
    for (const pid of outputPorts(node)) nodeByOut.set(pid, node);
    for (const pid of inputPorts(node))  nodeByIn.set(pid, node);
    if (node.kind === "dup") {
      for (const out of node.outputs) dupByOut.set(out.id, node);
    }
  }

  return { wireFrom, wireTo, nodeByOut, nodeByIn, dupByOut };
}

function outputPorts(node: Node): PortId[] {
  switch (node.kind) {
    case "const":  return [node.output.id];
    case "dup":    return node.outputs.map(o => o.id);
    case "drop":
    case "proj":
    case "ctor":
    case "effect":
    case "ref":
    case "tuple":
    case "case":
    case "cata":   return [node.output.id];
  }
}

function inputPorts(node: Node): PortId[] {
  switch (node.kind) {
    case "const":  return [];
    case "dup":    return [node.input.id];
    case "drop":
    case "proj":
    case "ctor":
    case "effect":
    case "ref":
    case "case":
    case "cata":   return [node.input.id];
    case "tuple":  return node.inputs.map(i => i.port.id);
  }
}

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

function nodeSpan(node: Node, spanMap: SpanMap): SourceSpan | undefined {
  for (const p of node.provenance) {
    if (p.span) return p.span;
    const s = spanMap.get(p.sourceId);
    if (s)     return s;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Expression building — backward trace
// ---------------------------------------------------------------------------

function exprFromPort(portId: PortId, graph: Graph, maps: GraphMaps, spanMap: SpanMap): CoreExpr {
  if (portId === graph.inPort.id) return { tag: "id" };

  const src = maps.wireFrom.get(portId);
  if (src !== undefined) return exprFromPort(src, graph, maps, spanMap);

  const node = maps.nodeByOut.get(portId);
  if (node) return exprFromNode(node, graph, maps, spanMap);

  return { tag: "id" };
}

function exprFromNode(node: Node, graph: Graph, maps: GraphMaps, spanMap: SpanMap): CoreExpr {
  const span = nodeSpan(node, spanMap);

  switch (node.kind) {
    case "const":
      return { tag: "lit", value: node.value, span };

    case "ref": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap);
      return mkPipe(input, { tag: "ref", name: shortRef(node.defId), span });
    }
    case "proj": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap);
      return mkPipe(input, { tag: "proj", field: node.field, span });
    }
    case "ctor": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap);
      return mkPipe(input, { tag: "ctor", name: node.ctorName, span });
    }
    case "drop": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap);
      return mkPipe(input, { tag: "drop", span });
    }
    case "effect": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap);
      return mkPipe(input, { tag: "effect", op: node.op, span });
    }
    case "dup": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap);
      return mkPipe(input, { tag: "dup", span });
    }

    case "tuple":
      return exprFromTuple(node, graph, maps, spanMap);

    case "case": {
      const input    = exprFromPort(node.input.id, graph, maps, spanMap);
      const branches = node.branches.map(b => ({
        ctor: b.tag,
        expr: renderSubGraph(b.graph, spanMap),
      }));
      return mkPipe(input, { tag: "case", field: node.field, branches, span });
    }
    case "cata": {
      const input    = exprFromPort(node.input.id, graph, maps, spanMap);
      const branches = node.algebra.map(b => ({
        ctor: b.tag,
        expr: renderSubGraph(b.graph, spanMap),
      }));
      return mkPipe(input, { tag: "cata", branches, span });
    }
  }
}

// ---------------------------------------------------------------------------
// Tuple: dup >>> (b0 *** b1 *** …) or (f0 *** f1 *** …)
// ---------------------------------------------------------------------------

function exprFromTuple(
  node: Extract<Node, { kind: "tuple" }>,
  graph: Graph,
  maps: GraphMaps,
  spanMap: SpanMap,
): CoreExpr {
  const dup = findAssociatedDup(node, graph);

  if (dup) {
    const branches = dup.outputs.map((out, i) => {
      const tupleIn = node.inputs[i]?.port.id ?? out.id;
      return branchExpr(out.id, tupleIn, maps, spanMap);
    });
    const dupSpan  = nodeSpan(dup, spanMap);
    const dupInput = exprFromPort(dup.input.id, graph, maps, spanMap);
    return mkPipe(dupInput, { tag: "dup", span: dupSpan }, { tag: "tensor", branches });
  }

  // Build-like: unit-sourced, no dup
  const branches = node.inputs.map(inp => exprFromPort(inp.port.id, graph, maps, spanMap));
  return { tag: "tensor", branches };
}

// ---------------------------------------------------------------------------
// Branch trace — forward walk from dup output to tuple input
// ---------------------------------------------------------------------------

function branchExpr(
  startPortId: PortId,
  endPortId:   PortId,
  maps:        GraphMaps,
  spanMap:     SpanMap,
): CoreExpr {
  if (startPortId === endPortId) return { tag: "id" };

  const dests = maps.wireTo.get(startPortId);
  if (dests && dests.length > 0) {
    const destPortId = dests[0]!;
    const node       = maps.nodeByIn.get(destPortId);
    if (node) {
      const outPortId = singleOutput(node);
      if (outPortId !== undefined) {
        const rest = branchExpr(outPortId, endPortId, maps, spanMap);
        const span = nodeSpan(node, spanMap);
        return mkPipe(nodeStep(node, span), rest);
      }
    }
  }

  return exprFromSourcePort(endPortId, maps, spanMap);
}

function exprFromSourcePort(portId: PortId, maps: GraphMaps, spanMap: SpanMap): CoreExpr {
  const src = maps.wireFrom.get(portId);
  if (src !== undefined) return exprFromSourcePort(src, maps, spanMap);

  const node = maps.nodeByOut.get(portId);
  if (!node) return { tag: "id" };
  if (node.kind === "const") {
    return { tag: "lit", value: node.value, span: nodeSpan(node, spanMap) };
  }
  return { tag: "id" };
}

function nodeStep(node: Node, span: SourceSpan | undefined): CoreExpr {
  switch (node.kind) {
    case "drop":   return { tag: "drop",   span };
    case "proj":   return { tag: "proj",   field: node.field,       span };
    case "ctor":   return { tag: "ctor",   name:  node.ctorName,    span };
    case "ref":    return { tag: "ref",    name:  shortRef(node.defId), span };
    case "effect": return { tag: "effect", op:    node.op,          span };
    case "const":  return { tag: "lit",    value: node.value,       span };
    default:       return { tag: "id" };
  }
}

function singleOutput(node: Node): PortId | undefined {
  switch (node.kind) {
    case "drop":
    case "proj":
    case "ctor":
    case "effect":
    case "ref":
    case "const":
    case "tuple":
    case "case":
    case "cata":  return node.output.id;
    case "dup":   return undefined;
  }
}

// ---------------------------------------------------------------------------
// Sub-graph rendering (case/cata branches)
// ---------------------------------------------------------------------------

function renderSubGraph(graph: Graph, spanMap: SpanMap): CoreExpr {
  const maps = buildMaps(graph);
  return exprFromPort(graph.outPort.id, graph, maps, spanMap);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findAssociatedDup(
  tuple: Extract<Node, { kind: "tuple" }>,
  graph: Graph,
): DupNode | undefined {
  const srcId = tuple.provenance[0]?.sourceId;
  if (srcId === undefined) return undefined;
  for (const node of graph.nodes) {
    if (
      node.kind === "dup" &&
      node.provenance.some(
        p => p.sourceId === srcId &&
             (p.role === "dup-for-fanout" || p.role === "dup-for-let" || p.role === "dup-for-over"),
      )
    ) return node;
  }
  return undefined;
}

function shortRef(defId: string): string {
  return defId.startsWith("builtin.") ? defId.slice("builtin.".length) : defId;
}

function mkPipe(a: CoreExpr, ...rest: CoreExpr[]): CoreExpr {
  const steps: CoreExpr[] = [];
  function push(e: CoreExpr): void {
    if (e.tag === "pipe") { for (const s of e.steps) push(s); return; }
    if (e.tag !== "id") steps.push(e);
  }
  push(a);
  for (const e of rest) push(e);
  if (steps.length === 0) return { tag: "id" };
  if (steps.length === 1) return steps[0]!;
  return { tag: "pipe", steps };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function spanWrap(text: string, span: SourceSpan | undefined): string {
  if (!span) return esc(text);
  const data = esc(JSON.stringify(span));
  return `<span class="cp" data-span="${data}">${esc(text)}</span>`;
}

// ---------------------------------------------------------------------------
// Type formatter (plain — used only in the def header)
// ---------------------------------------------------------------------------

function fmtTy(ty: Type): string {
  switch (ty.tag) {
    case "Unit":   return "()";
    case "Int":    return "Int";
    case "Float":  return "Float";
    case "Bool":   return "Bool";
    case "Text":   return "Text";
    case "TyVar":  return ty.name;
    case "Record": {
      if (ty.fields.length === 0) return "{}";
      const fs = ty.fields.map(f => `${f.name}: ${fmtTy(f.ty)}`).join(", ");
      return `{ ${fs} }`;
    }
    case "Named":
      return ty.args.length === 0 ? ty.name
           : `(${ty.name} ${ty.args.map(fmtTy).join(" ")})`;
    case "Arrow":
      return `${fmtTy(ty.from)} → ${fmtTy(ty.to)}`;
  }
}

function fmtLit(v: LiteralValue): string {
  switch (v.tag) {
    case "int":   return String(v.value);
    case "float": return String(v.value);
    case "bool":  return v.value ? "true" : "false";
    case "text":  return JSON.stringify(v.value);
    case "unit":  return "()";
  }
}

// ---------------------------------------------------------------------------
// Formatter — produces HTML
// ---------------------------------------------------------------------------

function isBlock(expr: CoreExpr): boolean {
  switch (expr.tag) {
    case "case":
    case "cata":   return true;
    case "pipe": {
      if (expr.steps.some(isBlock)) return true;
      // Force multi-line when dup >>> tensor appears so the &&& annotation renders
      for (let i = 1; i < expr.steps.length; i++) {
        if (expr.steps[i - 1]!.tag === "dup" && expr.steps[i]!.tag === "tensor") return true;
      }
      return false;
    }
    case "tensor": return expr.branches.some(isBlock);
    default:       return false;
  }
}

// Inline (single-line) rendering — returns HTML.
function fmtInline(expr: CoreExpr): string {
  switch (expr.tag) {
    case "id":     return "id";
    case "lit":    return spanWrap(fmtLit(expr.value),    expr.span);
    case "ref":    return spanWrap(expr.name,              expr.span);
    case "proj":   return spanWrap(`.${expr.field}`,       expr.span);
    case "ctor":   return spanWrap(`.${expr.name}`,        expr.span);
    case "drop":   return spanWrap("drop",                 expr.span);
    case "dup":    return spanWrap("dup",                  expr.span);
    case "effect": return spanWrap(`perform ${esc(expr.op)}`, expr.span);
    case "pipe":   return expr.steps.map(s => fmtInlineStep(s, "pipe")).join(" >>> ");
    case "tensor": return fmtTensorInline(expr.branches);
    case "case": {
      const kw = expr.field ? `case .${esc(expr.field)}` : "case";
      const bs = expr.branches.map(b => `${esc(b.ctor)}: ${fmtInline(b.expr)}`).join(", ");
      return `${spanWrap(kw, expr.span)} { ${bs} }`;
    }
    case "cata": {
      const bs = expr.branches.map(b => `${esc(b.ctor)}: ${fmtInline(b.expr)}`).join(", ");
      return `${spanWrap("cata", expr.span)} { ${bs} }`;
    }
  }
}

function fmtInlineStep(expr: CoreExpr, ctx: "pipe" | "tensor"): string {
  if (ctx === "pipe"   && expr.tag === "tensor") return fmtTensorInline(expr.branches);
  if (ctx === "tensor" && expr.tag === "pipe")   return `(${fmtInline(expr)})`;
  return fmtInline(expr);
}

function fmtTensorInline(branches: CoreExpr[]): string {
  if (branches.length === 1) return fmtInline(branches[0]!);
  const parts = branches.map(b => fmtInlineStep(b, "tensor"));
  return `(${parts.join(" *** ")})`;
}

// &&& form: same branches but joined with &&&
function fmtAmpersand(branches: CoreExpr[]): string {
  if (branches.length === 1) return fmtInline(branches[0]!);
  const parts = branches.map(b => fmtInlineStep(b, "tensor"));
  return parts.join(" &amp;&amp;&amp; ");
}

// Multi-line renderer — indent is the indent of the current expression.
function fmtExpr(expr: CoreExpr, indent: string): string {
  switch (expr.tag) {
    case "id":     return "id";
    case "lit":    return spanWrap(fmtLit(expr.value),    expr.span);
    case "ref":    return spanWrap(expr.name,              expr.span);
    case "proj":   return spanWrap(`.${expr.field}`,       expr.span);
    case "ctor":   return spanWrap(`.${expr.name}`,        expr.span);
    case "drop":   return spanWrap("drop",                 expr.span);
    case "dup":    return spanWrap("dup",                  expr.span);
    case "effect": return spanWrap(`perform ${esc(expr.op)}`, expr.span);

    case "pipe": {
      if (!isBlock(expr)) return fmtInline(expr);
      return expr.steps.map((s, i) => {
        const last = i === expr.steps.length - 1;
        const str  = fmtExprStep(s, indent, "pipe");
        // &&& annotation: append to the tensor step that immediately follows dup
        if (!last && s.tag === "tensor" && i > 0 && expr.steps[i - 1]?.tag === "dup") {
          const amp = fmtAmpersand(s.branches);
          const alt = `<span class="core-alt">-- ${amp}</span>`;
          return `${str} >>>   ${alt}`;
        }
        return last ? str : `${str} >>>`;
      }).join(`\n${indent}`);
    }

    case "tensor": {
      if (!isBlock(expr)) return fmtTensorInline(expr.branches);
      const inner  = indent + "  ";
      const parts  = expr.branches.map(b => fmtExprStep(b, inner, "tensor"));
      return `(\n${inner}${parts.join(` ***\n${inner}`)}\n${indent})`;
    }

    case "case": {
      const kw    = expr.field ? `case .${esc(expr.field)}` : "case";
      const inner = indent + "  ";
      const lines = expr.branches
        .map(b => {
          const val = isBlock(b.expr)
            ? `\n${inner}  ` + fmtExpr(b.expr, inner + "  ")
            : fmtInline(b.expr);
          return `${esc(b.ctor)}: ${val}`;
        })
        .join(`,\n${inner}`);
      return `${spanWrap(kw, expr.span)} {\n${inner}${lines}\n${indent}}`;
    }

    case "cata": {
      const inner = indent + "  ";
      const lines = expr.branches
        .map(b => {
          const val = isBlock(b.expr)
            ? `\n${inner}  ` + fmtExpr(b.expr, inner + "  ")
            : fmtInline(b.expr);
          return `${esc(b.ctor)}: ${val}`;
        })
        .join(`,\n${inner}`);
      return `${spanWrap("cata", expr.span)} {\n${inner}${lines}\n${indent}}`;
    }
  }
}

function fmtExprStep(expr: CoreExpr, indent: string, ctx: "pipe" | "tensor"): string {
  if (ctx === "pipe"   && expr.tag === "tensor") return fmtExpr(expr, indent);
  if (ctx === "tensor" && expr.tag === "pipe")   return `(${fmtExpr(expr, indent)})`;
  return fmtExpr(expr, indent);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function formatGraphCore(
  defName:  string,
  graph:    Graph,
  spanMap:  SpanMap,
): string {
  const maps   = buildMaps(graph);
  const expr   = exprFromPort(graph.outPort.id, graph, maps, spanMap);
  const inTy   = esc(fmtTy(graph.inPort.ty));
  const outTy  = esc(fmtTy(graph.outPort.ty));
  const eff    = graph.effect === "pure" ? "" : `  ! ${graph.effect}`;
  const header = `def ${esc(defName)} : ${inTy} → ${outTy}${esc(eff)} =`;
  const body   = fmtExpr(expr, "  ");
  return `${header}\n  ${body}`;
}
