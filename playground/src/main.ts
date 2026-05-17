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
import { formatGraphText } from "./ir/text.ts";
import { formatGraphCore } from "./ir/core.ts";
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
const irCore      = document.getElementById("ir-core")!;
const irJson      = document.getElementById("ir-json")!;
const irText      = document.getElementById("ir-text")!;
const graphSvgEl  = document.getElementById("graph-svg")!;
const defSelect   = document.getElementById("def-select") as HTMLSelectElement;
const fitBtn      = document.getElementById("graph-fit-btn") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// Pan/zoom state
// ---------------------------------------------------------------------------

let panX       = 0;
let panY       = 0;
let pzScale    = 1;
let dragging   = false;
let dragStartX = 0;
let dragStartY = 0;
let panStartX  = 0;
let panStartY  = 0;
let viewportEl: SVGGElement | null = null;

function applyTransform(): void {
  if (!viewportEl) return;
  viewportEl.setAttribute("transform", `translate(${panX}, ${panY}) scale(${pzScale})`);
}

function fitGraph(): void {
  if (!currentLayout || !viewportEl) return;
  const W = graphSvgEl.clientWidth;
  const H = graphSvgEl.clientHeight;
  if (W <= 0 || H <= 0) { requestAnimationFrame(() => fitGraph()); return; }
  const pad = 24;
  const s   = Math.min(W / (currentLayout.width + pad * 2), H / (currentLayout.height + pad * 2));
  panX    = (W - currentLayout.width  * s) / 2;
  panY    = (H - currentLayout.height * s) / 2;
  pzScale = Math.max(0.05, Math.min(20, s));
  applyTransform();
}

fitBtn.addEventListener("click", () => fitGraph());

// ---------------------------------------------------------------------------
// IR panel tab switching
// ---------------------------------------------------------------------------

type IrTab = "core" | "json" | "dump";
let activeIrTab: IrTab = "core";

function setIrTab(tab: IrTab): void {
  activeIrTab = tab;
  irCore.style.display = tab === "core" ? "" : "none";
  irJson.style.display = tab === "json" ? "" : "none";
  irText.style.display = tab === "dump" ? "" : "none";
  document.querySelectorAll<HTMLButtonElement>(".ir-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["tab"] === tab);
  });
}

document.querySelectorAll<HTMLButtonElement>(".ir-tab").forEach(btn => {
  btn.addEventListener("click", () => setIrTab(btn.dataset["tab"] as IrTab));
});

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
  if (!currentElabMod) { irCore.textContent = ""; irJson.textContent = ""; irText.textContent = ""; return; }
  const defName = defSelect.value;
  if (!defName) { irCore.textContent = ""; irJson.textContent = ""; irText.textContent = ""; return; }
  const graph = currentElabMod.defs.get(defName);
  if (!graph)  { irCore.textContent = ""; irJson.textContent = ""; irText.textContent = ""; return; }
  irCore.innerHTML   = formatGraphCore(defName, graph, currentSpanMap);
  irJson.textContent = JSON.stringify(serializeGraph(defName, graph), null, 2);
  irText.textContent = formatGraphText(defName, graph);
}

function refreshGraphPanel(): void {
  if (!currentElabMod) { graphSvgEl.innerHTML = ""; viewportEl = null; currentLayout = null; return; }
  const defName = defSelect.value;
  if (!defName) { graphSvgEl.innerHTML = ""; viewportEl = null; currentLayout = null; return; }
  const graph = currentElabMod.defs.get(defName);
  if (!graph)  { graphSvgEl.innerHTML = ""; viewportEl = null; currentLayout = null; return; }
  currentLayout = layoutGraph(graph, currentSpanMap);
  graphSvgEl.innerHTML = renderGraphSVG(currentLayout);
  viewportEl = graphSvgEl.querySelector<SVGGElement>("#graph-viewport");
  fitGraph();
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

graphSvgEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (!viewportEl) return;
  const rect     = graphSvgEl.getBoundingClientRect();
  const mx       = e.clientX - rect.left;
  const my       = e.clientY - rect.top;
  const factor   = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const newScale = Math.max(0.05, Math.min(20, pzScale * factor));
  panX   = mx - (mx - panX) * (newScale / pzScale);
  panY   = my - (my - panY) * (newScale / pzScale);
  pzScale = newScale;
  applyTransform();
}, { passive: false });

function endDrag(): void {
  if (!dragging) return;
  dragging = false;
  graphSvgEl.classList.remove("dragging");
}

graphSvgEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !viewportEl) return;
  hideTooltip();
  dragging   = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  panStartX  = panX;
  panStartY  = panY;
  graphSvgEl.setPointerCapture(e.pointerId);
  graphSvgEl.classList.add("dragging");
});

graphSvgEl.addEventListener("pointerup",         () => endDrag());
graphSvgEl.addEventListener("pointercancel",      () => endDrag());
graphSvgEl.addEventListener("lostpointercapture", () => endDrag());
window.addEventListener("blur",                   () => endDrag());

graphSvgEl.addEventListener("pointermove", (e) => {
  if (dragging) {
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyTransform();
    hideTooltip();
    return;
  }

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

graphSvgEl.addEventListener("pointerleave", () => { hideTooltip(); clearCoreHighlight(); clearProvenance(); });

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

function clearCoreHighlight(): void {
  irCore.querySelectorAll(".cp-active").forEach(el => el.classList.remove("cp-active"));
}

function highlightCoreToken(span: SourceSpan, sourceIds: string[]): void {
  clearCoreHighlight();
  if (activeIrTab !== "core") return;
  const useIds = sourceIds.length > 0;
  irCore.querySelectorAll<HTMLElement>(".cp").forEach(el => {
    if (useIds) {
      const raw = el.getAttribute("data-sids");
      if (raw && raw.split(" ").some(id => sourceIds.includes(id))) {
        el.classList.add("cp-active");
        return;
      }
    }
    // Fallback: span equality
    const rawSpan = el.getAttribute("data-span");
    if (rawSpan) {
      try {
        const s = JSON.parse(rawSpan) as SourceSpan;
        if (s.start.line   === span.start.line   &&
            s.start.column === span.start.column &&
            s.end.line     === span.end.line     &&
            s.end.column   === span.end.column) {
          el.classList.add("cp-active");
        }
      } catch { /* ignore */ }
    }
  });
}

graphSvgEl.addEventListener("mouseover", (e) => {
  const g = (e.target as Element).closest("g.node");
  if (!g) return;
  const rawSpan = g.getAttribute("data-span");
  if (!rawSpan) return;
  try {
    const span      = JSON.parse(rawSpan) as SourceSpan;
    const sourceIds = (g.getAttribute("data-sids") ?? "").split(" ").filter(s => s.length > 0);
    highlightSpan(span);
    highlightCoreToken(span, sourceIds);
  } catch { /* ignore */ }
});

graphSvgEl.addEventListener("mouseout", (e) => {
  const g = (e.target as Element).closest("g.node");
  if (!g) return;
  clearProvenance();
  clearCoreHighlight();
});

irCore.addEventListener("mouseover", (e) => {
  const target = (e.target as Element).closest("[data-span]");
  if (!target) { clearProvenance(); return; }
  const raw = target.getAttribute("data-span");
  if (raw) { try { highlightSpan(JSON.parse(raw) as SourceSpan); } catch { /* ignore */ } }
});

irCore.addEventListener("mouseleave", () => clearProvenance());

function updateDefSelector(names: string[]): void {
  const prev   = defSelect.value;
  const target = pendingDef ?? prev;
  pendingDef   = null;
  defSelect.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    defSelect.appendChild(opt);
  }
  defSelect.value    = names.includes(target) ? target : (names[0] ?? "");
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
// Share — encode/decode editor content in the URL hash
// ---------------------------------------------------------------------------

function encodeCode(code: string): string {
  const bytes  = new TextEncoder().encode(code);
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function decodeCode(encoded: string): string | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)!;
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function parseHash(): { code: string | null; def: string | null } {
  const hash   = window.location.hash;
  const prefix = "#code/";
  if (!hash.startsWith(prefix)) return { code: null, def: null };
  const rest   = hash.slice(prefix.length);
  const defIdx = rest.indexOf("&def=");
  if (defIdx === -1) return { code: decodeCode(rest), def: null };
  return {
    code: decodeCode(rest.slice(0, defIdx)),
    def:  decodeURIComponent(rest.slice(defIdx + 5)),
  };
}

// ---------------------------------------------------------------------------
// Editor setup
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE = `def exclaim : Text -> Text ! pure =
  id <> "!"
`;

const { code: urlCode, def: urlDef } = parseHash();
let pendingDef: string | null = urlDef;

const view = new EditorView({
  doc:        urlCode ?? DEFAULT_SOURCE,
  extensions: [basicSetup, weaveLang, lintGutter(), weaveLinter, provenanceField],
  parent:     document.getElementById("editor")!,
});

// ---------------------------------------------------------------------------
// Share button
// ---------------------------------------------------------------------------

const shareBtn = document.getElementById("share-btn") as HTMLButtonElement;

shareBtn.addEventListener("click", () => {
  const code    = view.state.doc.toString();
  const encoded = encodeCode(code);
  const defName = defSelect.value;
  const defPart = defName ? `&def=${encodeURIComponent(defName)}` : "";
  const hash    = `#code/${encoded}${defPart}`;
  const url     = `${window.location.origin}${window.location.pathname}${hash}`;
  window.history.replaceState(null, "", hash);
  navigator.clipboard.writeText(url).then(() => {
    shareBtn.textContent = "Copied!";
    shareBtn.classList.add("copied");
    setTimeout(() => {
      shareBtn.textContent = "Share";
      shareBtn.classList.remove("copied");
    }, 2000);
  }).catch(() => {
    // Clipboard API unavailable — URL is already in the address bar
    shareBtn.textContent = "Link updated";
    setTimeout(() => { shareBtn.textContent = "Share"; }, 2000);
  });
});
