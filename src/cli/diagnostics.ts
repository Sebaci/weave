import type { LoadError } from "../module/loader.ts";
import type { ResolverError } from "../module/resolver.ts";

// ---------------------------------------------------------------------------
// Source snippet rendering
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
  const header = err.line !== undefined && err.column !== undefined
    ? `${err.filePath}:${err.line}:${err.column}: error: ${err.message}`
    : `${err.filePath}: error: ${err.message}`;

  if (!source || err.line === undefined || err.column === undefined) {
    return header;
  }

  const lines = source.split("\n");
  const lineIdx = err.line - 1; // lines are 1-based
  if (lineIdx < 0 || lineIdx >= lines.length) return header;

  const srcLine = lines[lineIdx];
  const lineLabel = String(err.line);
  const gutterWidth = lineLabel.length + 1; // " 4 |" → width of "4 |" prefix
  const gutter = " ".repeat(gutterWidth);

  // Caret under the column; column is 1-based
  const caretOffset = " ".repeat(Math.max(0, err.column - 1));
  const caret = "^^^";

  return [
    header,
    `  ${lineLabel} | ${srcLine}`,
    `  ${gutter}  ${caretOffset}${caret}`,
  ].join("\n");
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
  const header = `${err.filePath}:${err.line}:${err.column}: error: ${err.message}`;
  const source = sources.get(err.filePath);
  if (!source) return header;

  const lines = source.split("\n");
  const lineIdx = err.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return header;

  const srcLine = lines[lineIdx];
  const lineLabel = String(err.line);
  const gutterWidth = lineLabel.length + 1;
  const gutter = " ".repeat(gutterWidth);
  const caretOffset = " ".repeat(Math.max(0, err.column - 1));

  return [
    header,
    `  ${lineLabel} | ${srcLine}`,
    `  ${gutter}  ${caretOffset}^^^`,
  ].join("\n");
}
