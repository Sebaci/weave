import type { SourceNodeId, SourceSpan } from "../surface/id.ts";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type ErrorCode =
  // Parse phase
  | "E_PARSE"
  // Resolve phase
  | "E_MODULE_NOT_FOUND"
  | "E_IMPORT_CYCLE"
  // Typecheck — scope
  | "E_UNDEFINED_NAME"
  | "E_UNKNOWN_TYPE"
  | "E_UNKNOWN_TYPE_VAR"
  | "E_UNKNOWN_CTOR"
  | "E_UNKNOWN_EFFECT"
  | "E_UNKNOWN_DEF"
  | "E_UNKNOWN_FIELD"
  | "E_AMBIGUOUS_IMPORT"
  // Typecheck — type mismatches
  | "E_TYPE_MISMATCH"
  | "E_BRANCH_TYPE_MISMATCH"
  | "E_NORM_DOMAIN_MISMATCH"
  | "E_EFFECT_MISMATCH"
  | "E_TYPE_ARITY"
  // Typecheck — structure
  | "E_ARROW_IN_PAYLOAD"
  | "E_EMPTY_PIPELINE"
  | "E_NOT_VARIANT"
  | "E_NOT_RECORD"
  | "E_NOT_RECURSIVE_ADT"
  | "E_MISSING_BRANCH"
  | "E_UNKNOWN_BRANCH"
  | "E_NO_BRANCHES"
  | "E_FIELD_COLLISION"
  | "E_BUILD_AMBIENT_REF"
  // Typecheck — declarations
  | "E_INVALID_EFFECT_LEVEL"
  | "E_INVALID_EFFECT_VAR"
  | "E_INVALID_PARAM_TYPE"
  // Typecheck — let
  | "E_LET_INVALID_SCOPE"
  | "E_LET_DUPLICATE_USE"
  // Typecheck — schema
  | "E_NOT_SCHEMA"
  | "E_SCHEMA_MISSING_ARG"
  | "E_SCHEMA_UNKNOWN_ARG"
  | "E_SCHEMA_CYCLE"
  // Elaboration
  | "E_ELABORATION"
  // Internal (should never occur in normal use)
  | "E_INTERNAL";

// ---------------------------------------------------------------------------
// Core error type
// ---------------------------------------------------------------------------

export type TypeError = {
  code:     ErrorCode;
  message:  string;
  sourceId: SourceNodeId;
  span?:    SourceSpan;
};

export type TypeResult<T> =
  | { ok: true;  value: T }
  | { ok: false; errors: TypeError[] };

export function ok<T>(value: T): TypeResult<T> {
  return { ok: true, value };
}

export function fail<T>(errors: TypeError[]): TypeResult<T> {
  return { ok: false, errors };
}

export function typeError<T>(message: string, sourceId: SourceNodeId, code: ErrorCode, span?: SourceSpan): TypeResult<T> {
  return fail([{ code, message, sourceId, span }]);
}

/** Sequence: run f, then g on its result. Short-circuits on first failure. */
export function mapResult<A, B>(r: TypeResult<A>, f: (a: A) => TypeResult<B>): TypeResult<B> {
  if (!r.ok) return r;
  return f(r.value);
}

/** Collect results, accumulating all errors before failing. */
export function collectResults<T>(results: TypeResult<T>[]): TypeResult<T[]> {
  const values: T[] = [];
  const errors: TypeError[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(...r.errors);
  }
  if (errors.length > 0) return fail(errors);
  return ok(values);
}
