/**
 * Core Type ADT for Weave v1.
 *
 * Types exist at two phases:
 *   - Typed AST: may contain TyVar, Record with rest !== null, EffVar in arrows
 *   - IR:        fully concrete — no TyVar, all Records closed, no EffVar
 *
 * Use `isConcrete` from check.ts to enforce the IR boundary.
 */

// ---------------------------------------------------------------------------
// Effect levels
// ---------------------------------------------------------------------------

/**
 * The three concrete effect levels, forming the lattice
 *   pure ⊑ parallel-safe ⊑ sequential
 * These are the only values that appear in IR-level arrow types.
 */
export type ConcreteEffect = "pure" | "parallel-safe" | "sequential";

/**
 * Effect annotation on arrow types. EffVar appears in higher-order def
 * signatures (typed AST only) and is instantiated away before elaboration.
 */
export type EffectLevel =
  | ConcreteEffect
  | { tag: "EffVar"; name: string };

// ---------------------------------------------------------------------------
// Row fields
// ---------------------------------------------------------------------------

/** A single named field in a record type, ordered by declaration/occurrence. */
export type RowField = { name: string; ty: Type };

// ---------------------------------------------------------------------------
// Type ADT
// ---------------------------------------------------------------------------

export type Type =
  // Base types (unit object and primitives)
  | { tag: "Unit" }
  | { tag: "Int" }
  | { tag: "Float" }
  | { tag: "Bool" }
  | { tag: "Text" }

  /**
   * Type variable — introduced by type declarations and higher-order defs,
   * resolved by the typechecker. Absent at IR level.
   */
  | { tag: "TyVar"; name: string }

  /**
   * Record type.
   *   rest === null  →  closed record (the only valid form at IR level)
   *   rest === "ρ"   →  row-polymorphic { f1: T1, ... | ρ } (typed AST only)
   *
   * Field order is significant: it is preserved from declaration/binding order
   * and used by the elaborator when enumerating passthrough fields for `over`
   * and `let`.
   */
  | { tag: "Record"; fields: RowField[]; rest: string | null }

  /**
   * Named ADT or type constructor applied to zero or more type arguments.
   *   List a   →  { tag: "Named"; name: "List"; args: [TyVar("a")] }
   *   List Int →  { tag: "Named"; name: "List"; args: [Int]        }
   *   Maybe    →  { tag: "Named"; name: "Maybe"; args: []          }  (unsaturated; typechecker enforces kinding)
   *
   * This representation unifies type constructor references and type
   * applications. Kinding checks are the typechecker's responsibility.
   */
  | { tag: "Named"; name: string; args: Type[] }

  /**
   * Arrow type with effect annotation.
   *   A -> B ! ε   →  { tag: "Arrow"; from: A; to: B; eff: ε }
   *
   * At IR level, `eff` must be a ConcreteEffect (not an EffVar).
   */
  | { tag: "Arrow"; from: Type; to: Type; eff: EffectLevel };

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

export const TUnit: Type = { tag: "Unit" };
export const TInt: Type = { tag: "Int" };
export const TFloat: Type = { tag: "Float" };
export const TBool: Type = { tag: "Bool" };
export const TText: Type = { tag: "Text" };

export function tyVar(name: string): Type {
  return { tag: "TyVar", name };
}

export function effVar(name: string): EffectLevel {
  return { tag: "EffVar", name };
}

export function record(fields: RowField[], rest: string | null = null): Type {
  return { tag: "Record", fields, rest };
}

export function field(name: string, ty: Type): RowField {
  return { name, ty };
}

export function named(name: string, ...args: Type[]): Type {
  return { tag: "Named", name, args };
}

export function arrow(from: Type, to: Type, eff: EffectLevel = "pure"): Type {
  return { tag: "Arrow", from, to, eff };
}
