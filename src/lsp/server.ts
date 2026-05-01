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

// URIs that have had diagnostics published in any prior run.
// Used to send empty arrays to files that leave the module graph,
// ensuring VS Code clears stale squiggles after an import is removed.
const publishedUris = new Set<string>();

function publish(
  byFile: Map<string, import("vscode-languageserver/node").Diagnostic[]>,
): void {
  // Convert file paths to URIs first so the staleness check and the send
  // use the same key space.
  const byUri = new Map(
    [...byFile].map(([file, diags]) => [uriOf(file), diags]),
  );

  // Clear diagnostics for any URI that is no longer in the current result.
  for (const uri of publishedUris) {
    if (!byUri.has(uri)) connection.sendDiagnostics({ uri, diagnostics: [] });
  }
  publishedUris.clear();

  for (const [uri, diags] of byUri) {
    connection.sendDiagnostics({ uri, diagnostics: diags });
    publishedUris.add(uri);
  }
}

function diagnoseFile(filePath: string): void {
  const graphResult = buildModuleGraph(filePath);

  if (!graphResult.ok) {
    // Seed every file that was successfully read with an empty list so that
    // diagnostics from a previous run are cleared when the error moves elsewhere.
    const byFile = new Map<string, import("vscode-languageserver/node").Diagnostic[]>();
    for (const absPath of graphResult.sources.keys()) byFile.set(absPath, []);

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

    publish(byFile);
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

  publish(byFile);
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
