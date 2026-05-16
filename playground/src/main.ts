import { basicSetup } from "codemirror";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField } from "@codemirror/state";
import { weaveLang } from "./weave-lang.ts";
import { layoutGraph } from "./graph/layout.ts";
import { renderGraphSVG } from "./graph/render.ts";
import { buildMemoryModuleGraph, checkAll, elaborateAll } from "../../src/compiler.ts";
import type { ModuleGraph } from "../../src/compiler.ts";
import { serializeGraph } from "../../src/ir/serialize.ts";
import { resetElabCounters } from "../../src/elaborator/index.ts";
import type { Position, SourceNodeId, SourceSpan } from "../../src/surface/id.ts";
import type { ElaboratedModule } from "../../src/ir/ir.ts";
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

function refreshIRPanel(): void {
  if (!currentElabMod) { irJson.textContent = ""; return; }
  const defName = defSelect.value;
  if (!defName) { irJson.textContent = ""; return; }
  const graph = currentElabMod.defs.get(defName);
  if (!graph)  { irJson.textContent = ""; return; }
  irJson.textContent = JSON.stringify(serializeGraph(defName, graph), null, 2);
}

function refreshGraphPanel(): void {
  if (!currentElabMod) { graphSvgEl.innerHTML = ""; return; }
  const defName = defSelect.value;
  if (!defName) { graphSvgEl.innerHTML = ""; return; }
  const graph = currentElabMod.defs.get(defName);
  if (!graph)  { graphSvgEl.innerHTML = ""; return; }
  graphSvgEl.innerHTML = renderGraphSVG(layoutGraph(graph, currentSpanMap));
}

defSelect.addEventListener("change", () => { refreshIRPanel(); refreshGraphPanel(); });

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
