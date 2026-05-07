/**
 * Node.js compiler entry point.
 *
 * Extends the core compiler API (compiler.ts) with filesystem-based
 * module resolution. CLI, LSP, and other Node.js consumers should
 * import from here. Browser / in-memory consumers use compiler.ts.
 */

export * from "./compiler.ts";

export { buildModuleGraph } from "./module/resolver.ts";
export type { ResolveResult, ResolverError } from "./module/resolver.ts";
