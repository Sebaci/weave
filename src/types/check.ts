/**
 * Type utilities: structural equality, concreteness test, effect join.
 */

import type { ConcreteEffect, EffectLevel, RowField, Type } from "./type.ts";

// ---------------------------------------------------------------------------
// Structural equality
// ---------------------------------------------------------------------------

/**
 * Structural equality on types.
 * Used by substAdt to identify occurrences of the ADT being folded.
 */
export function typeEq(a: Type, b: Type): boolean {
  if (a.tag !== b.tag) return false;

  switch (a.tag) {
    case "Unit":
    case "Int":
    case "Float":
    case "Bool":
    case "Text":
      return true;

    case "TyVar":
      return a.name === (b as Extract<Type, { tag: "TyVar" }>).name;

    case "Record": {
      const br = b as Extract<Type, { tag: "Record" }>;
      return (
        a.rest === br.rest &&
        a.fields.length === br.fields.length &&
        a.fields.every((f, i) => rowFieldEq(f, br.fields[i]!))
      );
    }

    case "Named": {
      const bn = b as Extract<Type, { tag: "Named" }>;
      return (
        a.name === bn.name &&
        a.args.length === bn.args.length &&
        a.args.every((t, i) => typeEq(t, bn.args[i]!))
      );
    }

    case "Arrow": {
      const ba = b as Extract<Type, { tag: "Arrow" }>;
      return (
        typeEq(a.from, ba.from) &&
        typeEq(a.to, ba.to) &&
        effectLevelEq(a.eff, ba.eff)
      );
    }
  }
}

function rowFieldEq(a: RowField, b: RowField): boolean {
  return a.name === b.name && typeEq(a.ty, b.ty);
}

function effectLevelEq(a: EffectLevel, b: EffectLevel): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "object" && typeof b === "object") return a.name === b.name;
  return false;
}

// ---------------------------------------------------------------------------
// Concreteness — IR boundary check
// ---------------------------------------------------------------------------

/**
 * Returns true iff the type contains no TyVar, no open Record (rest !== null),
 * and no EffVar in any arrow type.
 *
 * All Port.ty values in the IR must satisfy isConcrete.
 */
export function isConcrete(ty: Type): boolean {
  switch (ty.tag) {
    case "Unit":
    case "Int":
    case "Float":
    case "Bool":
    case "Text":
      return true;

    case "TyVar":
      return false;

    case "Record":
      return (
        ty.rest === null &&
        ty.fields.every((f) => isConcrete(f.ty))
      );

    case "Named":
      return ty.args.every(isConcrete);

    case "Arrow":
      return (
        typeof ty.eff === "string" &&  // EffVar is an object
        isConcrete(ty.from) &&
        isConcrete(ty.to)
      );
  }
}

// ---------------------------------------------------------------------------
// Effect join
// ---------------------------------------------------------------------------

const EFFECT_RANK: Record<ConcreteEffect, number> = {
  "pure": 0,
  "parallel-safe": 1,
  "sequential": 2,
};

const EFFECT_FROM_RANK: ConcreteEffect[] = ["pure", "parallel-safe", "sequential"];

/** Join on ConcreteEffect: pure ⊑ parallel-safe ⊑ sequential. */
export function effectJoin(a: ConcreteEffect, b: ConcreteEffect): ConcreteEffect {
  return EFFECT_FROM_RANK[Math.max(EFFECT_RANK[a], EFFECT_RANK[b])]!;
}

/**
 * Join on EffectLevel. Concrete levels join normally.
 * If either side is an EffVar, returns the other (treating EffVar as a
 * lower bound at join time); if both are EffVars and equal, returns the var.
 * The typechecker is responsible for resolving EffVars before elaboration.
 */
export function effectLevelJoin(a: EffectLevel, b: EffectLevel): EffectLevel {
  if (typeof a === "string" && typeof b === "string") {
    return effectJoin(a, b);
  }
  if (typeof a === "string") return a === "sequential" ? a : b;
  if (typeof b === "string") return b === "sequential" ? b : a;
  // Both EffVar — return either if equal, else "sequential" as conservative bound
  return a.name === b.name ? a : "sequential";
}
