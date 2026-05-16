import { basicSetup } from "codemirror";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField } from "@codemirror/state";
import { weaveLang } from "./weave-lang.ts";
import { layoutGraph } from "./graph/layout.ts";
import type { RenderedLayout, RenderedNode, RenderedPort } from "./graph/layout.ts";
import { renderGraphSVG } from "./graph/render.ts";
import { buildMemoryModuleGraph, checkAll, elaborateAll } from "../../src/compiler.ts";
import type { ModuleGraph } from "../../src/compiler.ts";
import { serializeGraph } from "../../src/ir/serialize.ts";
import { resetElabCounters } from "../../src/elaborator/index.ts";
import type { Position, SourceNodeId, SourceSpan } from "../../src/surface/id.ts";
import type { ElaboratedModule } from "../../src/ir/ir.ts";
import type { Type } from "../../src/types/type.ts";
import type { Text } from "@codemirror/state";

// ---------------------------------------------------------------------------
// Build a SourceNodeId → SourceSpan map by recursively walking all AST nodes
// that carry a NodeMeta.  Used to resolve provenance spans in the graph panel.
// ---------------------------------------------------------------------------

function collectSpanMap(graph: ModuleGraph): Map<SourceNodeId, SourceSpan> {
  const m = new Map<SourceNodeId, SourceSpan>();
  function walk(obj: unknown): void {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { for (const item of obj) walk(item); return; }
    const o = obj as Record<string, unknown>;
    const meta = o["meta"];
    if (meta && typeof meta === "object") {
      const { id, span } = meta as { id?: unknown; span?: unknown };
      if (typeof id === "string" && span) m.set(id, span as SourceSpan);
    }
    for (const v of Object.values(o)) walk(v);
  }
  for (const { mod } of graph.values()) walk(mod);
  return m;
}

// ---------------------------------------------------------------------------
// Provenance highlight — CM6 state field
// ---------------------------------------------------------------------------

const setHighlight  = StateEffect.define<{ from: number; to: number } | null>();
const provenanceMark = Decoration.mark({ class: "cm-provenance-hl" });

const provenanceField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setHighlight)) {
        if (e.value === null) return Decoration.none;
        const { from, to } = e.value;
        return Decoration.set([provenanceMark.range(from, to)]);
      }
    }
    return deco.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const diagContent = document.getElementById("diagnostics-content")!;
const irJson      = document.getElementById("ir-json")!;
const graphSvgEl  = document.getElementById("graph-svg")!;
const defSelect   = document.getElementById("def-select") as HTMLSelectElement;

// ---------------------------------------------------------------------------
// Position conversion: Weave spans (1-based line, 1-based col) → CM offset
// ---------------------------------------------------------------------------

function posToOffset(doc: Text, pos: Position): number {
  try {
    const line = doc.line(pos.line);        // 1-based
    return line.from + (pos.column - 1);    // column is 1-based
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// IR panel state
// ---------------------------------------------------------------------------

let currentElabMod: ElaboratedModule | null = null;
let currentSpanMap: Map<SourceNodeId, SourceSpan> = new Map();
let currentLayout:  RenderedLayout | null = null;

function refreshIRPanel(): void {
  if (!currentElabMod) { irJson.textContent = ""; return; }
  const defName = defSelect.value;
  if (!defName) { irJson.textContent = ""; return; }
  const graph = currentElabMod.defs.get(defName);
  if (!graph)  { irJson.textContent = ""; return; }
  irJson.textContent = JSON.stringify(serializeGraph(defName, graph), null, 2);
}

function refreshGraphPanel(): void {
  if (!currentElabMod) { graphSvgEl.innerHTML = ""; currentLayout = null; return; }
  const defName = defSelect.value;
  if (!defName) { graphSvgEl.innerHTML = ""; currentLayout = null; return; }
  const graph = currentElabMod.defs.get(defName);
  if (!graph)  { graphSvgEl.innerHTML = ""; currentLayout = null; return; }
  currentLayout = layoutGraph(graph, currentSpanMap);
  graphSvgEl.innerHTML = renderGraphSVG(currentLayout);
}

defSelect.addEventListener("change", () => { refreshIRPanel(); refreshGraphPanel(); });

// ---------------------------------------------------------------------------
// Graph tooltip — custom HTML overlay, 200ms delay, immediate hide
// ---------------------------------------------------------------------------

const NODE_DESCRIPTIONS: Record<string, string> = {
  source: "The value entering this definition from the caller",
  sink:   "The value produced by this definition, returned to the caller",
  dup:    "Copies the input so it can flow into multiple branches",
  drop:   "Discards the input value, producing Unit",
  const:  "Introduces a constant value, ignoring its Unit input",
  ref:    "Applies a named definition as a morphism",
  tuple:  "Combines multiple labeled values into a record",
  proj:   "Extracts one named field from a record",
  ctor:   "Wraps a value in a variant constructor tag",
  case:   "Dispatches on a variant type, selecting the matching branch",
  cata:   "Eliminates a recursive type by folding each constructor case",
  effect: "Performs an external effectful operation",
};

function formatType(ty: Type): string {
  switch (ty.tag) {
    case "Unit":   return "()";
    case "Int":    return "Int";
    case "Float":  return "Float";
    case "Bool":   return "Bool";
    case "Text":   return "Text";
    case "TyVar":  return ty.name;
    case "Record": {
      if (ty.fields.length === 0) return "{}";
      const fs = ty.fields.map(f => `${f.name}: ${formatType(f.ty)}`).join(", ");
      return `{ ${fs} }`;
    }
    case "Named":
      return ty.args.length === 0
        ? ty.name
        : `${ty.name} ${ty.args.map(a => formatType(a)).join(" ")}`;
    case "Arrow":
      return `${formatType(ty.from)} → ${formatType(ty.to)}`;
  }
}

function formatMorphism(node: RenderedNode): string {
  const ins  = node.inPorts.map(p => formatType(p.ty));
  const outs = node.outPorts.map(p => formatType(p.ty));
  const inStr  = ins.length  === 0 ? "()" : ins.length  === 1 ? ins[0]!  : ins.join(" × ");
  const outStr = outs.length === 0 ? "()" : outs.length === 1 ? outs[0]! : outs.join(" × ");
  return `${inStr} → ${outStr}`;
}

function formatSpan(span: SourceSpan): string {
  const { start, end } = span;
  if (start.line === end.line) {
    return `line ${start.line}, col ${start.column}–${end.column}`;
  }
  return `lines ${start.line}–${end.line}`;
}

function buildNodeTooltip(node: RenderedNode): string {
  const effectClass = `tt-effect-${node.effect}`;
  const desc  = NODE_DESCRIPTIONS[node.kind] ?? "";

  // Source/sink are synthetic boundary markers — they don't perform an operation.
  // Show the carried type directly rather than a misleading morphism like "() → Text".
  let morphLine: string;
  if (node.kind === "source") {
    const ty = node.outPorts[0]?.ty;
    morphLine = `<div class="tt-morph"><span class="tt-morph-label">carries: </span>${escHtml(ty ? formatType(ty) : "?")}</div>`;
  } else if (node.kind === "sink") {
    const ty = node.inPorts[0]?.ty;
    morphLine = `<div class="tt-morph"><span class="tt-morph-label">carries: </span>${escHtml(ty ? formatType(ty) : "?")}</div>`;
  } else {
    morphLine = `<div class="tt-morph"><span class="tt-morph-label">type: </span>${escHtml(formatMorphism(node))}</div>`;
  }

  const spanStr = node.span
    ? `<div class="tt-source">source: ${formatSpan(node.span)}</div>`
    : "";
  return `
    <div class="tt-header">
      <span class="tt-label">${escHtml(node.label)}</span>
      <span class="tt-effect ${effectClass}">${node.effect}</span>
    </div>
    ${desc ? `<div class="tt-desc">${escHtml(desc)}</div>` : ""}
    ${morphLine}
    ${spanStr}
  `.trim();
}

function buildPortTooltip(port: RenderedPort): string {
  const side  = port.side === "in" ? "input" : "output";
  const label = port.label ? ` <em>${escHtml(port.label)}</em>` : "";
  return `
    <div class="tt-header">
      <span class="tt-label">${side} port${label}</span>
    </div>
    <div class="tt-morph">${escHtml(formatType(port.ty))}</div>
  `.trim();
}

function buildWireTooltip(fromPortId: string, toPortId: string, layout: RenderedLayout): string {
  const ty = layout.portTypeMap.get(fromPortId);
  const tyStr = ty ? formatType(ty) : "?";
  return `
    <div class="tt-header">
      <span class="tt-label">wire</span>
    </div>
    <div class="tt-desc">Connects an output port to an input port</div>
    <div class="tt-morph">${escHtml(tyStr)}</div>
  `.trim();
}

const tooltipEl = document.createElement("div");
tooltipEl.id = "graph-tooltip";
tooltipEl.setAttribute("aria-hidden", "true");
document.body.appendChild(tooltipEl);

let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
let hoveredId: string | null = null;

function positionTooltip(x: number, y: number): void {
  const tw = tooltipEl.offsetWidth;
  const th = tooltipEl.offsetHeight;
  let left = x + 16;
  let top  = y + 16;
  if (left + tw > window.innerWidth  - 8) left = x - tw - 12;
  if (top  + th > window.innerHeight - 8) top  = y - th - 12;
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top  = `${top}px`;
}

function scheduleTooltip(html: string, x: number, y: number): void {
  if (tooltipTimer !== null) clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(() => {
    tooltipTimer = null;
    tooltipEl.innerHTML = html;
    tooltipEl.classList.add("visible");
    positionTooltip(x, y);
  }, 200);
}

function hideTooltip(): void {
  if (tooltipTimer !== null) { clearTimeout(tooltipTimer); tooltipTimer = null; }
  tooltipEl.classList.remove("visible");
  hoveredId = null;
}

graphSvgEl.addEventListener("pointermove", (e) => {
  const target = e.target as Element;
  const layout = currentLayout;
  if (!layout) { hideTooltip(); return; }

  let id: string;
  let html: string;

  // Port circles are inside g.node but should take priority
  if (target.matches("circle[data-port-id]")) {
    const portId   = target.getAttribute("data-port-id")!;
    const portSide = target.getAttribute("data-port-side") as "in" | "out";
    id = `port:${portId}`;
    const node = layout.nodes.find(n =>
      n.inPorts.some(p => p.portId === portId) || n.outPorts.some(p => p.portId === portId)
    );
    const port = node
      ? [...node.inPorts, ...node.outPorts].find(p => p.portId === portId && p.side === portSide)
      : undefined;
    html = port ? buildPortTooltip(port) : "";
  } else {
    const nodeEl = target.closest("g.node");
    if (nodeEl) {
      const nodeId = nodeEl.getAttribute("data-id")!;
      id = `node:${nodeId}`;
      const node = layout.nodes.find(n => n.id === nodeId);
      html = node ? buildNodeTooltip(node) : "";
    } else {
      // Wires: the hit-area path carries data-from / data-to
      const from = target.getAttribute("data-from");
      const to   = target.getAttribute("data-to");
      if (from && to) {
        id   = `wire:${from}→${to}`;
        html = buildWireTooltip(from, to, layout);
      } else {
        hideTooltip();
        return;
      }
    }
  }

  if (id === hoveredId) {
    if (tooltipEl.classList.contains("visible")) positionTooltip(e.clientX, e.clientY);
    return;
  }

  hoveredId = id;
  if (html) scheduleTooltip(html, e.clientX, e.clientY);
  else hideTooltip();
});

graphSvgEl.addEventListener("pointerleave", hideTooltip);

// ---------------------------------------------------------------------------
// Graph → editor provenance hover
// ---------------------------------------------------------------------------

function clearProvenance(): void {
  view.dispatch({ effects: setHighlight.of(null) });
}

function highlightSpan(span: SourceSpan): void {
  const doc  = view.state.doc;
  const from = posToOffset(doc, span.start);
  const to   = posToOffset(doc, span.end);
  if (from >= to) return;
  view.dispatch({ effects: setHighlight.of({ from, to }) });
}

graphSvgEl.addEventListener("mouseover", (e) => {
  const g = (e.target as Element).closest("g.node");
  if (!g) return;
  const raw = g.getAttribute("data-span");
  if (!raw) return;
  try { highlightSpan(JSON.parse(raw) as SourceSpan); } catch { /* ignore */ }
});

graphSvgEl.addEventListener("mouseout", (e) => {
  const g = (e.target as Element).closest("g.node");
  if (!g) return;
  clearProvenance();
});

function updateDefSelector(names: string[]): void {
  const prev = defSelect.value;
  defSelect.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    defSelect.appendChild(opt);
  }
  // Restore selection if still valid, else pick first
  defSelect.value = names.includes(prev) ? prev : (names[0] ?? "");
  defSelect.disabled = names.length === 0;
}

// ---------------------------------------------------------------------------
// Diagnostics panel
// ---------------------------------------------------------------------------

function renderDiagnostics(diags: Diagnostic[], source: string): void {
  if (diags.length === 0) {
    diagContent.innerHTML = `<span class="ok-msg">No errors.</span>`;
    return;
  }
  const lines = source.split("\n");
  diagContent.innerHTML = diags
    .map((d) => {
      // Recover approximate line/col from character offset
      const before = source.slice(0, d.from);
      const line   = (before.match(/\n/g) ?? []).length + 1;
      const col    = before.length - before.lastIndexOf("\n");
      const loc    = `${line}:${col}`;
      return `<div class="diag-item"><span class="diag-loc">${loc}</span>${escHtml(d.message)}</div>`;
    })
    .join("");
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Compile — runs as CM6 linter source (delay: 300 ms)
// ---------------------------------------------------------------------------

const weaveLinter = linter(
  async (view): Promise<Diagnostic[]> => {
    const source = view.state.doc.toString();
    const doc    = view.state.doc;
    const diags: Diagnostic[] = [];

    resetElabCounters();

    // Phase 1: resolve
    const files = new Map([["/entry.weave", source]]);
    const gr    = buildMemoryModuleGraph(files, "/entry.weave");

    if (!gr.ok) {
      for (const err of gr.errors) {
        if (err.tag === "parse-error") {
          const from = posToOffset(doc, err.span.start);
          const to   = Math.max(from + 1, posToOffset(doc, err.span.end));
          diags.push({ from, to, severity: "error", message: err.message });
        }
      }
      renderDiagnostics(diags, source);
      currentElabMod = null;
      updateDefSelector([]);
      refreshIRPanel();
      return diags;
    }

    // Phase 2: typecheck
    const lr = checkAll(gr.graph, "/entry.weave");

    if (!lr.ok) {
      for (const err of lr.errors) {
        if (err.span) {
          const from = posToOffset(doc, err.span.start);
          const to   = Math.max(from + 1, posToOffset(doc, err.span.end));
          diags.push({ from, to, severity: "error", message: err.message });
        } else {
          // No span — show in panel only
          diags.push({ from: 0, to: 0, severity: "error", message: err.message });
        }
      }
      renderDiagnostics(diags, source);
      currentElabMod = null;
      updateDefSelector([]);
      refreshIRPanel();
      return diags.filter((d) => d.from !== d.to || d.from > 0); // omit spanless from inline
    }

    // Phase 3: elaborate
    const er = elaborateAll(lr.modules);

    if (!er.ok) {
      for (const err of er.errors) {
        if (err.span) {
          const from = posToOffset(doc, err.span.start);
          const to   = Math.max(from + 1, posToOffset(doc, err.span.end));
          diags.push({ from, to, severity: "error", message: err.message });
        }
      }
      renderDiagnostics(diags, source);
      currentElabMod = null;
      updateDefSelector([]);
      refreshIRPanel();
      return diags;
    }

    // Success
    currentElabMod = er.value;
    currentSpanMap = collectSpanMap(gr.graph);
    const defNames = [...er.value.defs.keys()];
    updateDefSelector(defNames);
    refreshIRPanel();
    refreshGraphPanel();
    renderDiagnostics([], source);
    return [];
  },
  { delay: 300 },
);

// ---------------------------------------------------------------------------
// Editor setup
// ---------------------------------------------------------------------------

const INITIAL_SOURCE = `def exclaim : Text -> Text ! pure =
  id <> "!"
`;

const view = new EditorView({
  doc:        INITIAL_SOURCE,
  extensions: [basicSetup, weaveLang, lintGutter(), weaveLinter, provenanceField],
  parent:     document.getElementById("editor")!,
});
