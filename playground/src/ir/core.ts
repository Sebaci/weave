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
 * Each leaf expression carries optional span and source-ID provenance so
 * the HTML output embeds data-span / data-sids attributes for provenance
 * highlighting in both the editor and the Core panel.
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
  | { tag: "lit";    value: LiteralValue; span?: SourceSpan; sourceIds?: SourceNodeId[] }
  | { tag: "ref";    name: string;        span?: SourceSpan; sourceIds?: SourceNodeId[] }
  | { tag: "proj";   field: string;       span?: SourceSpan; sourceIds?: SourceNodeId[] }
  | { tag: "ctor";   name: string;        span?: SourceSpan; sourceIds?: SourceNodeId[] }
  | { tag: "drop";                        span?: SourceSpan; sourceIds?: SourceNodeId[] }
  | { tag: "dup";                         span?: SourceSpan; sourceIds?: SourceNodeId[] }
  | { tag: "effect"; op: string;          span?: SourceSpan; sourceIds?: SourceNodeId[] }
  | { tag: "tensor"; branches: CoreExpr[] }
  | { tag: "case";   field?: string; branches: Array<{ ctor: string; expr: CoreExpr }>; span?: SourceSpan; sourceIds?: SourceNodeId[] }
  | { tag: "cata";   branches: Array<{ ctor: string; expr: CoreExpr }>; span?: SourceSpan; sourceIds?: SourceNodeId[] }
  | { tag: "pipe";   steps: CoreExpr[] };

// ---------------------------------------------------------------------------
// Graph maps — backward-only (wireFrom, nodeByOut)
// ---------------------------------------------------------------------------

interface GraphMaps {
  wireFrom:  Map<PortId, PortId>;
  nodeByOut: Map<PortId, Node>;
}

function buildMaps(graph: Graph): GraphMaps {
  const wireFrom  = new Map<PortId, PortId>();
  const nodeByOut = new Map<PortId, Node>();

  for (const w of graph.wires) wireFrom.set(w.to, w.from);
  for (const node of graph.nodes) {
    for (const pid of outputPorts(node)) nodeByOut.set(pid, node);
  }

  return { wireFrom, nodeByOut };
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
// Span / sourceId helpers
// ---------------------------------------------------------------------------

function nodeSpan(node: Node, spanMap: SpanMap): SourceSpan | undefined {
  for (const p of node.provenance) {
    if (p.span) return p.span;
    const s = spanMap.get(p.sourceId);
    if (s)     return s;
  }
  return undefined;
}

function nodeSourceIds(node: Node): SourceNodeId[] {
  return node.provenance.map(p => p.sourceId);
}

// ---------------------------------------------------------------------------
// Expression building — backward trace with optional boundary port
//
// `boundary`: when set, reaching this port returns { tag: "id" } instead of
// continuing the trace.  Used in fanout branch rendering so that each branch
// is traced backward from the tuple input, stopping at its dup output port.
// ---------------------------------------------------------------------------

function exprFromPort(
  portId:    PortId,
  graph:     Graph,
  maps:      GraphMaps,
  spanMap:   SpanMap,
  boundary?: PortId,
): CoreExpr {
  if (portId === graph.inPort.id)                     return { tag: "id" };
  if (boundary !== undefined && portId === boundary)  return { tag: "id" };

  const src = maps.wireFrom.get(portId);
  if (src !== undefined) return exprFromPort(src, graph, maps, spanMap, boundary);

  const node = maps.nodeByOut.get(portId);
  if (node) return exprFromNode(node, graph, maps, spanMap, boundary);

  return { tag: "id" };
}

function exprFromNode(
  node:      Node,
  graph:     Graph,
  maps:      GraphMaps,
  spanMap:   SpanMap,
  boundary?: PortId,
): CoreExpr {
  const span      = nodeSpan(node, spanMap);
  const sourceIds = nodeSourceIds(node);

  switch (node.kind) {
    case "const":
      return { tag: "lit", value: node.value, span, sourceIds };

    case "ref": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap, boundary);
      return mkPipe(input, { tag: "ref", name: shortRef(node.defId), span, sourceIds });
    }
    case "proj": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap, boundary);
      return mkPipe(input, { tag: "proj", field: node.field, span, sourceIds });
    }
    case "ctor": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap, boundary);
      return mkPipe(input, { tag: "ctor", name: node.ctorName, span, sourceIds });
    }
    case "drop": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap, boundary);
      return mkPipe(input, { tag: "drop", span, sourceIds });
    }
    case "effect": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap, boundary);
      return mkPipe(input, { tag: "effect", op: node.op, span, sourceIds });
    }
    case "dup": {
      const input = exprFromPort(node.input.id, graph, maps, spanMap, boundary);
      return mkPipe(input, { tag: "dup", span, sourceIds });
    }

    case "tuple":
      return exprFromTuple(node, graph, maps, spanMap, boundary);

    case "case": {
      const input    = exprFromPort(node.input.id, graph, maps, spanMap, boundary);
      const branches = node.branches.map(b => ({
        ctor: b.tag,
        expr: renderSubGraph(b.graph, spanMap),
      }));
      return mkPipe(input, { tag: "case", field: node.field, branches, span, sourceIds });
    }
    case "cata": {
      const input    = exprFromPort(node.input.id, graph, maps, spanMap, boundary);
      const branches = node.algebra.map(b => ({
        ctor: b.tag,
        expr: renderSubGraph(b.graph, spanMap),
      }));
      return mkPipe(input, { tag: "cata", branches, span, sourceIds });
    }
  }
}

// ---------------------------------------------------------------------------
// Tuple: dup >>> (b0 *** b1 *** …) or (b0 *** b1 *** …)
//
// When a dup is associated, each branch's stop port is determined by
// backward reachability from the tuple input, not by index assumption.
// ---------------------------------------------------------------------------

function exprFromTuple(
  node:      Extract<Node, { kind: "tuple" }>,
  graph:     Graph,
  maps:      GraphMaps,
  spanMap:   SpanMap,
  boundary?: PortId,
): CoreExpr {
  const dup = findAssociatedDup(node, graph);

  if (dup) {
    const dupOutputSet   = new Set(dup.outputs.map(o => o.id));
    const claimedDupOuts = new Set<PortId>();

    const branches = node.inputs.map(inp => {
      const stop = findDupBoundary(inp.port.id, dupOutputSet, maps, graph);
      if (stop !== undefined) {
        claimedDupOuts.add(stop);
        return exprFromPort(inp.port.id, graph, maps, spanMap, stop);
      }
      // No backward path to the dup.  Two cases:
      //   (a) Self-sourced RHS (ConstNode): liftUnit inserts a DropNode directly
      //       on the dup output.  Claim that output and render  drop >>> val.
      //   (b) liveFromLocals field (let): the port comes from ctx.locals and has
      //       no connection to this dup at all.  Do not claim any output; just
      //       trace the branch independently.
      // Distinguish by whether an unclaimed dup output has a direct DropNode.
      const unclaimedOut = dup.outputs.find(
        o => !claimedDupOuts.has(o.id) && findDirectDrop(o.id, graph, maps) !== undefined,
      );
      if (unclaimedOut !== undefined) {
        claimedDupOuts.add(unclaimedOut.id);
        const dropNode   = findDirectDrop(unclaimedOut.id, graph, maps)!;
        const dropSpan   = nodeSpan(dropNode, spanMap);
        const dropSrcIds = nodeSourceIds(dropNode);
        const val        = exprFromPort(inp.port.id, graph, maps, spanMap);
        return mkPipe({ tag: "drop", span: dropSpan, sourceIds: dropSrcIds }, val);
      }
      return exprFromPort(inp.port.id, graph, maps, spanMap);
    });

    const dupSpan      = nodeSpan(dup, spanMap);
    const dupSourceIds = nodeSourceIds(dup);
    const dupInput     = exprFromPort(dup.input.id, graph, maps, spanMap, boundary);
    return mkPipe(dupInput, { tag: "dup", span: dupSpan, sourceIds: dupSourceIds }, { tag: "tensor", branches });
  }

  // Build-like: each input traced independently with the outer boundary
  const branches = node.inputs.map(inp => exprFromPort(inp.port.id, graph, maps, spanMap, boundary));
  return { tag: "tensor", branches };
}

// Backward DFS from portId — returns the first port found in `boundaries`.
function findDupBoundary(
  portId:     PortId,
  boundaries: Set<PortId>,
  maps:       GraphMaps,
  graph:      Graph,
): PortId | undefined {
  const visited = new Set<PortId>();
  function dfs(pid: PortId): PortId | undefined {
    if (boundaries.has(pid))   return pid;
    if (pid === graph.inPort.id) return undefined;
    if (visited.has(pid))      return undefined;
    visited.add(pid);
    const src = maps.wireFrom.get(pid);
    if (src !== undefined) return dfs(src);
    const n = maps.nodeByOut.get(pid);
    if (!n) return undefined;
    for (const inp of inputPorts(n)) {
      const found = dfs(inp);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return dfs(portId);
}

// Find the DropNode whose input is directly wired from dupOutId (or shares
// the same port id).  Used for best-effort provenance on self-sourced branches.
function findDirectDrop(dupOutId: PortId, graph: Graph, maps: GraphMaps): Node | undefined {
  for (const node of graph.nodes) {
    if (node.kind !== "drop") continue;
    const src = maps.wireFrom.get(node.input.id) ?? node.input.id;
    if (src === dupOutId) return node;
  }
  return undefined;
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

function spanWrap(text: string, span: SourceSpan | undefined, sourceIds?: SourceNodeId[]): string {
  const hasSpan = span !== undefined;
  const hasIds  = sourceIds !== undefined && sourceIds.length > 0;
  if (!hasSpan && !hasIds) return esc(text);
  const spanAttr = hasSpan ? ` data-span="${esc(JSON.stringify(span))}"` : "";
  const sidsAttr = hasIds  ? ` data-sids="${esc(sourceIds.join(" "))}"` : "";
  return `<span class="cp"${spanAttr}${sidsAttr}>${esc(text)}</span>`;
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
      for (let i = 1; i < expr.steps.length; i++) {
        if (expr.steps[i - 1]!.tag === "dup" && expr.steps[i]!.tag === "tensor") return true;
      }
      return false;
    }
    case "tensor": return expr.branches.some(isBlock);
    default:       return false;
  }
}

function fmtInline(expr: CoreExpr): string {
  switch (expr.tag) {
    case "id":     return "id";
    case "lit":    return spanWrap(fmtLit(expr.value),       expr.span, expr.sourceIds);
    case "ref":    return spanWrap(expr.name,                 expr.span, expr.sourceIds);
    case "proj":   return spanWrap(`.${expr.field}`,          expr.span, expr.sourceIds);
    case "ctor":   return spanWrap(`.${expr.name}`,           expr.span, expr.sourceIds);
    case "drop":   return spanWrap("drop",                    expr.span, expr.sourceIds);
    case "dup":    return spanWrap("dup",                     expr.span, expr.sourceIds);
    case "effect": return spanWrap(`perform ${esc(expr.op)}`, expr.span, expr.sourceIds);
    case "pipe":   return expr.steps.map(s => fmtInlineStep(s, "pipe")).join(" >>> ");
    case "tensor": return fmtTensorInline(expr.branches);
    case "case": {
      const kw = expr.field ? `case .${esc(expr.field)}` : "case";
      const bs = expr.branches.map(b => `${esc(b.ctor)}: ${fmtInline(b.expr)}`).join(", ");
      return `${spanWrap(kw, expr.span, expr.sourceIds)} { ${bs} }`;
    }
    case "cata": {
      const bs = expr.branches.map(b => `${esc(b.ctor)}: ${fmtInline(b.expr)}`).join(", ");
      return `${spanWrap("cata", expr.span, expr.sourceIds)} { ${bs} }`;
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

function fmtAmpersand(branches: CoreExpr[]): string {
  if (branches.length === 1) return fmtInline(branches[0]!);
  const parts = branches.map(b => fmtInlineStep(b, "tensor"));
  return parts.join(" &amp;&amp;&amp; ");
}

function fmtExpr(expr: CoreExpr, indent: string): string {
  switch (expr.tag) {
    case "id":     return "id";
    case "lit":    return spanWrap(fmtLit(expr.value),       expr.span, expr.sourceIds);
    case "ref":    return spanWrap(expr.name,                 expr.span, expr.sourceIds);
    case "proj":   return spanWrap(`.${expr.field}`,          expr.span, expr.sourceIds);
    case "ctor":   return spanWrap(`.${expr.name}`,           expr.span, expr.sourceIds);
    case "drop":   return spanWrap("drop",                    expr.span, expr.sourceIds);
    case "dup":    return spanWrap("dup",                     expr.span, expr.sourceIds);
    case "effect": return spanWrap(`perform ${esc(expr.op)}`, expr.span, expr.sourceIds);

    case "pipe": {
      if (!isBlock(expr)) return fmtInline(expr);
      return expr.steps.map((s, i) => {
        const last = i === expr.steps.length - 1;
        const str  = fmtExprStep(s, indent, "pipe");
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
      const inner = indent + "  ";
      const parts = expr.branches.map(b => fmtExprStep(b, inner, "tensor"));
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
      return `${spanWrap(kw, expr.span, expr.sourceIds)} {\n${inner}${lines}\n${indent}}`;
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
      return `${spanWrap("cata", expr.span, expr.sourceIds)} {\n${inner}${lines}\n${indent}}`;
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
