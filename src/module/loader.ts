import { resolve } from "node:path";
import { checkModule, type ModuleExports } from "../typechecker/check.ts";
import type { DefInfo, CtorInfo, TypeDeclInfo, TypeDeclEnv, Omega } from "../typechecker/env.ts";
import type { TypedModule, TypedTypeDecl } from "../typechecker/typed-ast.ts";
import { buildSpanMap } from "../surface/span-map.ts";
import type { ModuleGraph } from "./resolver.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadError = {
  filePath: string;
  message:  string;
  line?:    number;
  column?:  number;
};

export type LoadResult =
  | { ok: true;  modules: Map<string, TypedModule> }
  | { ok: false; errors: LoadError[] };

// ---------------------------------------------------------------------------
// Topological sort
// ---------------------------------------------------------------------------

/** Returns file paths in dependency-first order (leaves first, entry last). */
function topoSort(graph: ModuleGraph, entryPath: string): string[] {
  const order:   string[]      = [];
  const visited: Set<string>   = new Set();

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

/** Extract the symbols a module exports so they can be seeded into importers. */
function extractExports(modPath: string[], typedMod: TypedModule): ModuleExports {
  const defs:      Map<string, DefInfo>      = new Map();
  const ctors:     Map<string, CtorInfo>     = new Map();
  const typeDecls: TypeDeclEnv               = new Map();
  const omega:     Omega                     = new Map();

  const prefix = modPath.join(".");

  // Defs — registered under qualified name so importers reference them as Foo.Bar.name
  for (const [name, def] of typedMod.typedDefs) {
    const qualName = prefix ? `${prefix}.${name}` : name;
    defs.set(qualName, {
      name:     qualName,
      params:   def.params,   // TypedDefParam and DefParamInfo share the same shape
      morphTy:  def.morphTy,
      body:     def.surfaceBody,
      sourceId: def.sourceId,
    });
  }

  // Type decls and ctors — registered under bare name (constructors are unqualified in surface syntax)
  for (const [name, td] of typedMod.typeDecls) {
    const info = typedDeclToInfo(td);
    typeDecls.set(name, info);
    if (info.body.tag === "Variant") {
      for (const ctor of info.body.ctors) ctors.set(ctor.ctorName, ctor);
    }
  }

  // Omega — already keyed by qualified name
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

function mergeExports(exports: ModuleExports[]): ModuleExports {
  const defs:      Map<string, DefInfo>  = new Map();
  const ctors:     Map<string, CtorInfo> = new Map();
  const typeDecls: TypeDeclEnv           = new Map();
  const omega:     Omega                 = new Map();
  for (const exp of exports) {
    for (const [k, v] of exp.defs)      defs.set(k, v);
    for (const [k, v] of exp.ctors)     ctors.set(k, v);
    for (const [k, v] of exp.typeDecls) typeDecls.set(k, v);
    for (const [k, v] of exp.omega)     omega.set(k, v);
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
export function checkAll(graph: ModuleGraph, entryFile: string): LoadResult {
  const absEntry = resolve(entryFile);
  const order    = topoSort(graph, absEntry);

  const checked: Map<string, TypedModule> = new Map();
  const errors:  LoadError[]              = [];

  for (const filePath of order) {
    const node = graph.get(filePath);
    if (!node) continue;

    // Merge exported envs from all direct imports that have already been checked
    const seeds = mergeExports(
      node.depPaths.flatMap((dep) => {
        const depTyped = checked.get(dep);
        const depNode  = graph.get(dep);
        if (!depTyped || !depNode) return [];
        return [extractExports(depNode.mod.path, depTyped)];
      }),
    );

    const spanMap = buildSpanMap(node.mod);
    const result  = checkModule(node.mod, seeds);

    if (!result.ok) {
      for (const err of result.errors) {
        const span = err.span ?? spanMap.get(err.sourceId);
        errors.push({
          filePath,
          message: err.message,
          line:    span?.start.line,
          column:  span?.start.column,
        });
      }
    } else {
      checked.set(filePath, result.value);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, modules: checked };
}
