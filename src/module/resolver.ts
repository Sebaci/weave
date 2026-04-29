import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { parseModule } from "../parser/parse.ts";
import type { Module } from "../surface/ast.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModuleGraphNode = {
  filePath: string;       // absolute path
  mod:      Module;       // parsed surface AST
  depPaths: string[];     // absolute paths of direct imports (in import order)
};

export type ModuleGraph = Map<string, ModuleGraphNode>; // keyed by absolute filePath

export type ResolverError =
  | { tag: "not-found";   filePath: string; importedBy: string }
  | { tag: "parse-error"; filePath: string; message: string; line: number; column: number }
  | { tag: "cycle";       cycle: string[] };

export type ResolveResult =
  | { ok: true;  graph: ModuleGraph }
  | { ok: false; errors: ResolverError[] };

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Maps an import path like ["Foo", "Bar"] to an absolute file path. */
export function resolvePath(importPath: string[], root: string): string {
  return resolve(join(root, ...importPath) + ".weave");
}

// ---------------------------------------------------------------------------
// Module graph construction
// ---------------------------------------------------------------------------

/**
 * Build a ModuleGraph rooted at entryFile.
 * Uses DFS with gray/black sets for cycle detection.
 * Each file is parsed at most once.
 */
export function buildModuleGraph(entryFile: string): ResolveResult {
  const absEntry = resolve(entryFile);
  const root     = dirname(absEntry);

  const graph: ModuleGraph      = new Map();
  const errors: ResolverError[] = [];

  // DFS state
  const gray  = new Set<string>(); // in-progress (on current DFS stack)
  const black = new Set<string>(); // fully visited

  function visit(filePath: string, importedBy: string | null): void {
    if (black.has(filePath)) return;

    if (gray.has(filePath)) {
      // Reconstruct cycle from gray set (order reflects discovery order)
      const stack = [...gray];
      const idx   = stack.indexOf(filePath);
      errors.push({ tag: "cycle", cycle: [...stack.slice(idx), filePath] });
      return;
    }

    // Read and parse
    let source: string;
    try {
      source = readFileSync(filePath, "utf-8");
    } catch {
      errors.push({
        tag:        "not-found",
        filePath,
        importedBy: importedBy ?? filePath,
      });
      black.add(filePath); // don't retry
      return;
    }

    const parseResult = parseModule(source);
    if (!parseResult.ok) {
      for (const err of parseResult.errors) {
        errors.push({
          tag:      "parse-error",
          filePath,
          message:  err.message,
          line:     err.span.start.line,
          column:   err.span.start.column,
        });
      }
      black.add(filePath);
      return;
    }

    const mod = parseResult.value;
    gray.add(filePath);

    // Resolve direct imports
    const depPaths: string[] = [];
    for (const imp of mod.imports) {
      const depPath = resolvePath(imp.path, root);
      depPaths.push(depPath);
      visit(depPath, filePath);
    }

    gray.delete(filePath);
    black.add(filePath);
    graph.set(filePath, { filePath, mod, depPaths });
  }

  visit(absEntry, null);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, graph };
}
