import { parseModule } from "../parser/parse.ts";
import type { ModuleGraph, ResolveResult, ResolverError } from "./resolver.ts";

// ---------------------------------------------------------------------------
// Virtual path helpers — no Node.js deps
// ---------------------------------------------------------------------------

function virtualDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : filePath.slice(0, lastSlash);
}

/** Resolve import path segments against the fixed entry-directory root. */
function resolveVirtualPath(importPath: string[], root: string): string {
  const base = root === "/" ? "" : root;
  return `${base}/${importPath.join("/")}.weave`;
}

// ---------------------------------------------------------------------------
// In-memory module graph construction
// ---------------------------------------------------------------------------

/**
 * Build a ModuleGraph from an in-memory map of virtual path → source string.
 * No filesystem access — safe for browser and test contexts.
 *
 * Virtual paths are slash-separated (e.g. "/entry.weave", "/Lib/foo.weave").
 * All imports are resolved against the entry file's directory (the root), not
 * the importing file's directory — matching buildModuleGraph in resolver.ts,
 * where root = dirname(absEntry) is fixed for the entire traversal.
 */
export function buildMemoryModuleGraph(
  files:     Map<string, string>,
  entryPath: string,
): ResolveResult {
  const root   = virtualDir(entryPath); // fixed for all imports, mirrors resolver.ts
  const graph:   ModuleGraph         = new Map();
  const errors:  ResolverError[]     = [];
  const sources: Map<string, string> = new Map();

  const gray  = new Set<string>(); // on current DFS stack (cycle detection)
  const black = new Set<string>(); // fully visited

  function visit(filePath: string, importedBy: string | null): void {
    if (black.has(filePath)) return;

    if (gray.has(filePath)) {
      const stack = [...gray];
      const idx   = stack.indexOf(filePath);
      errors.push({ tag: "cycle", cycle: [...stack.slice(idx), filePath] });
      return;
    }

    const source = files.get(filePath);
    if (source === undefined) {
      errors.push({ tag: "not-found", filePath, importedBy: importedBy ?? filePath });
      black.add(filePath);
      return;
    }
    sources.set(filePath, source);

    const parseResult = parseModule(source);
    if (!parseResult.ok) {
      for (const err of parseResult.errors) {
        errors.push({ tag: "parse-error", filePath, message: err.message, span: err.span });
      }
      black.add(filePath);
      return;
    }

    const mod = parseResult.value;
    gray.add(filePath);

    const depPaths: string[] = [];
    for (const imp of mod.imports) {
      const depPath = resolveVirtualPath(imp.path, root);
      depPaths.push(depPath);
      visit(depPath, filePath);
    }

    gray.delete(filePath);
    black.add(filePath);
    graph.set(filePath, { filePath, source, mod, depPaths });
  }

  visit(entryPath, null);

  return errors.length > 0 ? { ok: false, errors, sources } : { ok: true, graph };
}
