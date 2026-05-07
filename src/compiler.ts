/**
 * Public compiler API — single entry point for all consumers.
 *
 * Layers the four compiler phases behind stable named operations.
 * CLI, LSP, and future browser consumers should call these functions
 * rather than reaching into internal modules directly.
 */

// ---------------------------------------------------------------------------
// Phase 1 — Parse
// ---------------------------------------------------------------------------

export { parseModule } from "./parser/index.ts";
export type { ParseResult } from "./parser/index.ts";

// ---------------------------------------------------------------------------
// Phase 2 — Resolve + Typecheck
// ---------------------------------------------------------------------------

export { buildModuleGraph } from "./module/resolver.ts";
export { checkAll } from "./module/loader.ts";

export type { ModuleGraph, ModuleGraphNode, ResolveResult, ResolverError } from "./module/resolver.ts";
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

export type { ElaboratedModule } from "./ir/ir.ts";
export type { TypedModule } from "./typechecker/typed-ast.ts";
export type { Value } from "./interpreter/value.ts";
export type { ParseError } from "./parser/index.ts";
