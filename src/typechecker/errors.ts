import type { SourceNodeId, SourceSpan } from "../surface/id.ts";

export type TypeError = {
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

export function typeError<T>(message: string, sourceId: SourceNodeId, span?: SourceSpan): TypeResult<T> {
  return fail([{ message, sourceId, span }]);
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
