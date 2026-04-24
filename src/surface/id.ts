/**
 * Stable surface AST node identity and source location.
 *
 * SourceNodeId is the durable anchor for all provenance references.
 * IDs are assigned once at parse time and never change. Source spans
 * are secondary — useful for editor features but not the primary key
 * (spans shift on edits; IDs do not).
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Opaque stable identifier assigned to every surface AST node at parse time. */
export type SourceNodeId = string;

export type Position = { line: number; column: number };
export type SourceSpan = { start: Position; end: Position };

/**
 * Every significant surface AST node carries a NodeMeta.
 * The `id` is the stable provenance anchor; `span` is for editor tooling.
 */
export type NodeMeta = { id: SourceNodeId; span: SourceSpan };

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _counter = 0;

/**
 * Allocate a fresh, stable SourceNodeId.
 * Called exactly once per surface AST node at construction time.
 * The counter is module-level state; reset between independent parse sessions
 * via resetIdCounter() if needed.
 */
export function freshId(): SourceNodeId {
  return `n_${++_counter}`;
}

/** Reset the ID counter. Use only between independent parse sessions. */
export function resetIdCounter(): void {
  _counter = 0;
}

// ---------------------------------------------------------------------------
// NodeMeta helpers
// ---------------------------------------------------------------------------

/** Construct a NodeMeta with a fresh ID and the given source span. */
export function mkMeta(span: SourceSpan): NodeMeta {
  return { id: freshId(), span };
}

/** A zero span for programmatically constructed nodes with no source location. */
export function dummySpan(): SourceSpan {
  return { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
}

/** Construct a NodeMeta with a fresh ID and a zero span. */
export function dummyMeta(): NodeMeta {
  return mkMeta(dummySpan());
}

/** Merge two spans into the enclosing span (from start of `a` to end of `b`). */
export function spanMerge(a: SourceSpan, b: SourceSpan): SourceSpan {
  return { start: a.start, end: b.end };
}
