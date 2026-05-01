import type { LoadError } from "../module/loader.ts";
import type { ResolverError } from "../module/resolver.ts";

// ---------------------------------------------------------------------------
// Snippet rendering helpers
// ---------------------------------------------------------------------------

const TAB_WIDTH = 8;

function expandTabs(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\t") {
      const spaces = TAB_WIDTH - (out.length % TAB_WIDTH);
      out += " ".repeat(spaces);
    } else {
      out += ch;
    }
  }
  return out;
}

function renderSnippet(source: string, line: number, column: number): string {
  const lines = source.split("\n");
  const lineIdx = line - 1; // 1-based → 0-based
  if (lineIdx < 0 || lineIdx >= lines.length) return "";

  const rawLine = lines[lineIdx] ?? "";
  // Expand tabs so the caret aligns with the displayed column position.
  const displayLine = expandTabs(rawLine);
  const caretPrefix = expandTabs(rawLine.slice(0, Math.max(0, column - 1)));

  const lineLabel = String(line);
  const gutterWidth = lineLabel.length + 1;
  const gutter = " ".repeat(gutterWidth);

  return [
    `  ${lineLabel} | ${displayLine}`,
    `  ${gutter}  ${caretPrefix}^^^`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public renderers
// ---------------------------------------------------------------------------

/**
 * Render a LoadError with an optional source snippet.
 *
 * With location:
 *   file.weave:4:3: error: Undefined name 'foo'
 *     4 | unknownFn
 *         ^^^
 *
 * Without location:
 *   file.weave: error: Ambiguous import: ...
 */
export function renderLoadError(err: LoadError, source: string | undefined): string {
  const { line, col } = err.span
    ? { line: err.span.start.line, col: err.span.start.column }
    : { line: undefined, col: undefined };

  const header = line !== undefined && col !== undefined
    ? `${err.filePath}:${line}:${col}: error: ${err.message}`
    : `${err.filePath}: error: ${err.message}`;

  if (!source || line === undefined || col === undefined) return header;

  const snippet = renderSnippet(source, line, col);
  return snippet ? `${header}\n${snippet}` : header;
}

/**
 * Render a ResolverError. Parse errors include a snippet from the given source
 * map; not-found and cycle errors have no source location.
 */
export function renderResolverError(
  err: ResolverError,
  sources: ReadonlyMap<string, string>,
): string {
  if (err.tag === "not-found") {
    return `${err.importedBy}: error: cannot find imported module '${err.filePath}'`;
  }
  if (err.tag === "cycle") {
    return `error: import cycle detected: ${err.cycle.join(" -> ")}`;
  }
  // parse-error
  const { line, column } = err.span.start;
  const header = `${err.filePath}:${line}:${column}: error: ${err.message}`;
  const source = sources.get(err.filePath);
  if (!source) return header;

  const snippet = renderSnippet(source, line, column);
  return snippet ? `${header}\n${snippet}` : header;
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

export type JsonError = {
  code:    string;
  phase:   string;
  file:    string;
  span?:   { start: { line: number; column: number }; end: { line: number; column: number } };
  message: string;
};

export type JsonOutput =
  | { ok: true }
  | { ok: false; errors: JsonError[] };

export function loadErrorToJson(err: LoadError): JsonError {
  return {
    code:    err.code,
    phase:   err.phase,
    file:    err.filePath,
    span:    err.span
      ? { start: err.span.start, end: err.span.end }
      : undefined,
    message: err.message,
  };
}

export function resolverErrorToJson(err: ResolverError): JsonError {
  if (err.tag === "not-found") {
    return { code: "E_MODULE_NOT_FOUND", phase: "resolve", file: err.importedBy, message: `cannot find imported module '${err.filePath}'` };
  }
  if (err.tag === "cycle") {
    return { code: "E_IMPORT_CYCLE", phase: "resolve", file: err.cycle[0] ?? "", message: `import cycle detected: ${err.cycle.join(" -> ")}` };
  }
  // parse-error
  return {
    code:    "E_PARSE",
    phase:   "parse",
    file:    err.filePath,
    span:    { start: err.span.start, end: err.span.end },
    message: err.message,
  };
}
