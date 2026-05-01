import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildModuleGraph } from "../module/resolver.ts";
import { checkAll } from "../module/loader.ts";
import type { SourceSpan } from "../surface/id.ts";

// vscode-languageserver is CJS; named ESM imports don't work in Node 25 ESM.
// Use createRequire so the CJS module is loaded via the require() path.
const _require = createRequire(import.meta.url);
type VLS  = typeof import("vscode-languageserver/node");
type VLST = typeof import("vscode-languageserver-textdocument");

const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  DiagnosticSeverity,
} = _require("vscode-languageserver/node") as VLS;

const { TextDocument } = _require("vscode-languageserver-textdocument") as VLST;

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents  = new TextDocuments(TextDocument);

connection.onInitialize(() => ({
  capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spanToRange(span: SourceSpan) {
  // Our spans are 1-based; LSP ranges are 0-based.
  // dummySpan() uses line:0/column:0 as "no location" — clamp to 0.
  const sl = Math.max(0, span.start.line   - 1);
  const sc = Math.max(0, span.start.column - 1);
  const el = Math.max(0, span.end.line     - 1);
  const ec = Math.max(0, span.end.column   - 1);
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

function uriOf(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

const ZERO_RANGE = {
  start: { line: 0, character: 0 },
  end:   { line: 0, character: 0 },
};

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

function diagnoseFile(filePath: string): void {
  const graphResult = buildModuleGraph(filePath);

  if (!graphResult.ok) {
    const byFile = new Map<string, import("vscode-languageserver/node").Diagnostic[]>();
    const addDiag = (file: string, diag: import("vscode-languageserver/node").Diagnostic) => {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(diag);
    };

    for (const err of graphResult.errors) {
      if (err.tag === "parse-error") {
        addDiag(err.filePath, {
          severity: DiagnosticSeverity.Error,
          range: spanToRange(err.span),
          message: err.message,
          source: "weave",
        });
      } else if (err.tag === "not-found") {
        addDiag(err.importedBy, {
          severity: DiagnosticSeverity.Error,
          range: ZERO_RANGE,
          message: `Cannot find imported module '${err.filePath}'`,
          source: "weave",
        });
      } else {
        // cycle — report on first file in cycle
        addDiag(err.cycle[0] ?? filePath, {
          severity: DiagnosticSeverity.Error,
          range: ZERO_RANGE,
          message: `Import cycle: ${err.cycle.join(" -> ")}`,
          source: "weave",
        });
      }
    }

    for (const [file, diags] of byFile) {
      connection.sendDiagnostics({ uri: uriOf(file), diagnostics: diags });
    }
    return;
  }

  // Initialise empty diagnostic lists for every file in the graph so that
  // cleared errors are removed when a module is fixed.
  const byFile = new Map<string, import("vscode-languageserver/node").Diagnostic[]>();
  for (const absPath of graphResult.graph.keys()) byFile.set(absPath, []);

  const loadResult = checkAll(graphResult.graph, filePath);

  if (!loadResult.ok) {
    for (const err of loadResult.errors) {
      if (!byFile.has(err.filePath)) byFile.set(err.filePath, []);
      byFile.get(err.filePath)!.push({
        severity: DiagnosticSeverity.Error,
        range: err.span ? spanToRange(err.span) : ZERO_RANGE,
        message: err.message,
        source: "weave",
        code: err.code,
      });
    }
  }

  for (const [file, diags] of byFile) {
    connection.sendDiagnostics({ uri: uriOf(file), diagnostics: diags });
  }
}

// ---------------------------------------------------------------------------
// Document events
// ---------------------------------------------------------------------------

documents.onDidOpen((event) => {
  diagnoseFile(fileURLToPath(event.document.uri));
});

documents.onDidSave((event) => {
  diagnoseFile(fileURLToPath(event.document.uri));
});

documents.listen(connection);
connection.listen();
