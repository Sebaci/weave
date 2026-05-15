import { basicSetup } from "codemirror";
import { EditorView }  from "@codemirror/view";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { weaveLang } from "./weave-lang.ts";
import { buildMemoryModuleGraph, checkAll, elaborateAll } from "../../src/compiler.ts";
import { serializeGraph } from "../../src/ir/serialize.ts";
import { resetElabCounters } from "../../src/elaborator/index.ts";
import type { Position } from "../../src/surface/id.ts";
import type { ElaboratedModule } from "../../src/ir/ir.ts";
import type { Text } from "@codemirror/state";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const diagContent = document.getElementById("diagnostics-content")!;
const irJson      = document.getElementById("ir-json")!;
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

function refreshIRPanel(): void {
  if (!currentElabMod) {
    irJson.textContent = "";
    return;
  }
  const defName = defSelect.value;
  if (!defName) { irJson.textContent = ""; return; }
  const graph = currentElabMod.defs.get(defName);
  if (!graph)  { irJson.textContent = ""; return; }
  irJson.textContent = JSON.stringify(serializeGraph(defName, graph), null, 2);
}

defSelect.addEventListener("change", refreshIRPanel);

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
    const defNames = [...er.value.defs.keys()];
    updateDefSelector(defNames);
    refreshIRPanel();
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
  extensions: [basicSetup, weaveLang, lintGutter(), weaveLinter],
  parent:     document.getElementById("editor")!,
});
