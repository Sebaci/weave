/**
 * Core compiler API — no Node.js dependencies.
 *
 * Safe to import in browser and pure in-memory contexts.
 * For Node.js consumers that need filesystem module resolution,
 * use compiler-host.ts instead.
 */

// ---------------------------------------------------------------------------
// Phase 1 — Parse
// ---------------------------------------------------------------------------

export { parseModule } from "./parser/index.ts";
export type { ParseResult, ParseError } from "./parser/index.ts";

// ---------------------------------------------------------------------------
// Phase 2 — Typecheck (graph supplied by caller)
// ---------------------------------------------------------------------------

export { checkAll } from "./module/loader.ts";
export type { LoadResult, LoadError } from "./module/loader.ts";

// ---------------------------------------------------------------------------
// Phase 3 — Elaborate
// ---------------------------------------------------------------------------

export { elaborateAll } from "./elaborator/index.ts";

// ---------------------------------------------------------------------------
// Phase 4 — Interpret
// ---------------------------------------------------------------------------

export { interpret, MissingEffectHandlerError } from "./interpreter/eval.ts";
export type { EffectHandlers } from "./interpreter/eval.ts";

// ---------------------------------------------------------------------------
// Shared types used across phases
// ---------------------------------------------------------------------------

export type { ModuleGraph, ModuleGraphNode } from "./module/resolver.ts";

// ---------------------------------------------------------------------------
// In-memory module resolution (browser-safe)
// ---------------------------------------------------------------------------

export { buildMemoryModuleGraph } from "./module/memory-resolver.ts";
export type { ElaboratedModule } from "./ir/ir.ts";
export type { TypedModule } from "./typechecker/typed-ast.ts";
export type { Value } from "./interpreter/value.ts";
