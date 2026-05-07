import { checkModule, type ModuleExports } from "../typechecker/check.ts";
import type { DefInfo, CtorInfo, TypeDeclInfo, TypeDeclEnv, Omega } from "../typechecker/env.ts";
import type { TypedModule, TypedTypeDecl } from "../typechecker/typed-ast.ts";
import { buildSpanMap } from "../surface/span-map.ts";
import type { ModuleGraph } from "./resolver.ts";
import type { ErrorCode } from "../typechecker/errors.ts";
import type { SourceSpan } from "../surface/id.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadError = {
  code:     ErrorCode;
  phase:    "resolve" | "typecheck" | "elaborate";
  filePath: string;
  message:  string;
  span?:    SourceSpan;
};

export type LoadResult =
  | { ok: true;  modules: Map<string, TypedModule> }
  | { ok: false; errors: LoadError[] };

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

/** Returns file paths in dependency-first order (leaves first, entry last). */
function topoSort(graph: ModuleGraph, entryPath: string): string[] {
  const order:   string[]    = [];
  const visited: Set<string> = new Set();

  function visit(filePath: string): void {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    const node = graph.get(filePath);
    if (!node) return;
    for (const dep of node.depPaths) visit(dep);
    order.push(filePath);
  }

  visit(entryPath);
  return order;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * Extract the symbols a module exports so they can be seeded into importers.
 *
 * Defs are seeded under both their bare name ("foo") for unqualified access
 * and their qualified name ("Foo.Bar.foo") for future qualified access (Step 8).
 * The DefInfo.name is always the qualified name so elaborator refs are stable.
 *
 * Ctors and typeDecls are seeded under bare names only (surface syntax is unqualified).
 * Omega entries are already qualified.
 */
function extractExports(modPath: string[], typedMod: TypedModule): ModuleExports {
  const defs:      Map<string, DefInfo>  = new Map();
  const ctors:     Map<string, CtorInfo> = new Map();
  const typeDecls: TypeDeclEnv           = new Map();
  const omega:     Omega                 = new Map();

  const prefix = modPath.join(".");

  for (const [name, def] of typedMod.typedDefs) {
    const qualName = prefix ? `${prefix}.${name}` : name;
    const info: DefInfo = {
      name:     qualName,
      params:   def.params,
      morphTy:  def.morphTy,
      body:     def.surfaceBody,
      sourceId: def.sourceId,
    };
    // Bare name — for unqualified references in importing modules
    defs.set(name, info);
    // Qualified name — for future qualified-access resolution (Step 8)
    if (prefix) defs.set(qualName, info);
  }

  for (const [name, td] of typedMod.typeDecls) {
    const info = typedDeclToInfo(td);
    typeDecls.set(name, info);
    if (info.body.tag === "Variant") {
      for (const ctor of info.body.ctors) ctors.set(ctor.ctorName, ctor);
    }
  }

  for (const [key, entry] of typedMod.omega) omega.set(key, entry);

  return { defs, ctors, typeDecls, omega };
}

function typedDeclToInfo(td: TypedTypeDecl): TypeDeclInfo {
  if (td.body.tag === "Record") {
    return {
      name: td.name, params: td.params,
      body: { tag: "Record", fields: td.body.fields },
      isRecursive: td.isRecursive, sourceId: td.sourceId,
    };
  }
  const ctors: CtorInfo[] = td.body.ctors.map((c) => ({
    ctorName:  c.name,
    adtName:   td.name,
    adtParams: td.params,
    payloadTy: c.payloadTy,
  }));
  return {
    name: td.name, params: td.params,
    body: { tag: "Variant", ctors },
    isRecursive: td.isRecursive, sourceId: td.sourceId,
  };
}

// ---------------------------------------------------------------------------
// Merge exports from multiple modules
// ---------------------------------------------------------------------------

/**
 * Merge exported envs from multiple modules into a single seed for an importer.
 * Qualified names (containing ".") are assumed globally unique and are merged silently.
 * Bare-name conflicts for defs, ctors, and typeDecls are reported as errors;
 * the first-seen binding wins (the conflicting import is dropped).
 */
function mergeExports(
  allExports: ModuleExports[],
  errors:     LoadError[],
  filePath:   string,
): ModuleExports {
  const defs:      Map<string, DefInfo>  = new Map();
  const ctors:     Map<string, CtorInfo> = new Map();
  const typeDecls: TypeDeclEnv           = new Map();
  const omega:     Omega                 = new Map();

  for (const exp of allExports) {
    for (const [k, v] of exp.defs) {
      if (!k.includes(".") && defs.has(k)) {
        errors.push({ code: "E_AMBIGUOUS_IMPORT", phase: "resolve", filePath, message: `Ambiguous import: name '${k}' is exported by multiple modules` });
      } else {
        defs.set(k, v);
      }
    }
    for (const [k, v] of exp.ctors) {
      if (ctors.has(k)) {
        errors.push({ code: "E_AMBIGUOUS_IMPORT", phase: "resolve", filePath, message: `Ambiguous import: constructor '${k}' is exported by multiple modules` });
      } else {
        ctors.set(k, v);
      }
    }
    for (const [k, v] of exp.typeDecls) {
      if (typeDecls.has(k)) {
        errors.push({ code: "E_AMBIGUOUS_IMPORT", phase: "resolve", filePath, message: `Ambiguous import: type '${k}' is exported by multiple modules` });
      } else {
        typeDecls.set(k, v);
      }
    }
    for (const [k, v] of exp.omega) omega.set(k, v);
  }

  return { defs, ctors, typeDecls, omega };
}

// ---------------------------------------------------------------------------
// Check all modules in topological order
// ---------------------------------------------------------------------------

/**
 * Typecheck every module in the graph, starting from leaves.
 * Each module is checked with its direct imports' exports seeded into its env.
 * Returns a map from absolute file path to TypedModule.
 */
/** entryFile must be an absolute path (caller is responsible for resolving). */
export function checkAll(graph: ModuleGraph, entryFile: string): LoadResult {
  const absEntry = entryFile;
  const order    = topoSort(graph, absEntry);

  const checked: Map<string, TypedModule> = new Map();
  const errors:  LoadError[]              = [];

  for (const filePath of order) {
    const node = graph.get(filePath);
    if (!node) continue;

    const importErrors: LoadError[] = [];
    const seeds = mergeExports(
      node.depPaths.flatMap((dep) => {
        const depTyped = checked.get(dep);
        const depNode  = graph.get(dep);
        if (!depTyped || !depNode) return [];
        return [extractExports(depNode.mod.path, depTyped)];
      }),
      importErrors,
      filePath,
    );
    errors.push(...importErrors);

    const spanMap = buildSpanMap(node.mod);
    const result  = checkModule(node.mod, seeds);

    if (!result.ok) {
      for (const err of result.errors) {
        errors.push({
          code:    err.code,
          phase:   "typecheck",
          filePath,
          message: err.message,
          span:    err.span ?? spanMap.get(err.sourceId),
        });
      }
    } else {
      checked.set(filePath, result.value);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, modules: checked };
}
