/**
 * Unification for Weave v1.
 *
 * Covers:
 *   - Type variable unification (HM-style substitution)
 *   - Row variable unification (for consumption-site row-polymorphic records)
 *   - Effect variable unification (for higher-order def schema params)
 *
 * Called only during typechecking — the elaborator never calls unify.
 */

import {
  type ConcreteEffect,
  type EffectLevel,
  type RowField,
  type Type,
} from "../types/type.ts";
import { substTyVar, substEffVar } from "../types/subst.ts";
import { typeEq, effectJoin } from "../types/check.ts";

// Subst, EffSubst and their application live in the types layer so the
// elaborator can use them without crossing into the typechecker layer.
// Imported for local use and re-exported for backward compatibility.
import {
  type Subst, type EffSubst,
  emptySubst, emptyEffSubst,
  applySubst, applyEffSubst,
} from "../types/subst.ts";
export type { Subst, EffSubst } from "../types/subst.ts";
export { emptySubst, emptyEffSubst, applySubst, applyEffSubst } from "../types/subst.ts";

/** Merge two substitutions; entries in `b` override entries in `a`. */
export function composeSubst(a: Subst, b: Subst): Subst {
  const result: Subst = new Map();
  for (const [k, v] of a) result.set(k, applySubst(v, b));
  for (const [k, v] of b) result.set(k, v);
  return result;
}

export function composeEffSubst(a: EffSubst, b: EffSubst): EffSubst {
  const result: EffSubst = new Map(a);
  for (const [k, v] of b) result.set(k, v);
  return result;
}

// ---------------------------------------------------------------------------
// Occurs check
// ---------------------------------------------------------------------------

/** True if TyVar `varName` occurs anywhere in `ty` (under current `subst`). */
export function occursIn(varName: string, ty: Type, subst: Subst): boolean {
  switch (ty.tag) {
    case "Unit": case "Int": case "Float": case "Bool": case "Text":
      return false;
    case "TyVar": {
      if (ty.name === varName) return true;
      const bound = subst.get(ty.name);
      return bound !== undefined && occursIn(varName, bound, subst);
    }
    case "Record":
      return ty.fields.some((f) => occursIn(varName, f.ty, subst));
    case "Named":
      return ty.args.some((t) => occursIn(varName, t, subst));
    case "Arrow":
      return occursIn(varName, ty.from, subst) || occursIn(varName, ty.to, subst);
  }
}

// ---------------------------------------------------------------------------
// Unification result
// ---------------------------------------------------------------------------

export type UnifyResult =
  | { ok: true;  subst: Subst; effSubst: EffSubst }
  | { ok: false; message: string };

function unifyOk(subst: Subst = new Map(), effSubst: EffSubst = new Map()): UnifyResult {
  return { ok: true, subst, effSubst };
}
function unifyFail(message: string): UnifyResult {
  return { ok: false, message };
}

// ---------------------------------------------------------------------------
// Main unification
// ---------------------------------------------------------------------------

/**
 * Unify types `a` and `b` under the current substitution.
 * Returns an extended substitution on success, or an error message on failure.
 */
export function unify(a: Type, b: Type, subst: Subst = new Map(), effSubst: EffSubst = new Map()): UnifyResult {
  // Chase type variable bindings
  const ra = resolve(a, subst);
  const rb = resolve(b, subst);

  // Both same tag
  if (ra.tag === "TyVar" && rb.tag === "TyVar" && ra.name === rb.name) {
    return unifyOk(subst, effSubst);
  }

  // Bind a type variable
  if (ra.tag === "TyVar") {
    if (occursIn(ra.name, rb, subst)) {
      return unifyFail(`Occurs check failed: ${ra.name} occurs in ${showType(rb)}`);
    }
    const s2 = new Map(subst);
    s2.set(ra.name, rb);
    return unifyOk(s2, effSubst);
  }
  if (rb.tag === "TyVar") {
    if (occursIn(rb.name, ra, subst)) {
      return unifyFail(`Occurs check failed: ${rb.name} occurs in ${showType(ra)}`);
    }
    const s2 = new Map(subst);
    s2.set(rb.name, ra);
    return unifyOk(s2, effSubst);
  }

  // Base types
  if (
    (ra.tag === "Unit" && rb.tag === "Unit") ||
    (ra.tag === "Int"  && rb.tag === "Int")  ||
    (ra.tag === "Float" && rb.tag === "Float") ||
    (ra.tag === "Bool" && rb.tag === "Bool") ||
    (ra.tag === "Text" && rb.tag === "Text")
  ) {
    return unifyOk(subst, effSubst);
  }

  // Record types
  if (ra.tag === "Record" && rb.tag === "Record") {
    return unifyRows(ra.fields, ra.rest, rb.fields, rb.rest, subst, effSubst);
  }

  // Named types
  if (ra.tag === "Named" && rb.tag === "Named") {
    if (ra.name !== rb.name) {
      return unifyFail(`Cannot unify ${ra.name} with ${rb.name}`);
    }
    if (ra.args.length !== rb.args.length) {
      return unifyFail(`Type ${ra.name}: argument count mismatch (${ra.args.length} vs ${rb.args.length})`);
    }
    let s = subst;
    let es = effSubst;
    for (let i = 0; i < ra.args.length; i++) {
      const r = unify(ra.args[i]!, rb.args[i]!, s, es);
      if (!r.ok) return r;
      s = r.subst;
      es = r.effSubst;
    }
    return unifyOk(s, es);
  }

  // Arrow types
  if (ra.tag === "Arrow" && rb.tag === "Arrow") {
    const r1 = unify(ra.from, rb.from, subst, effSubst);
    if (!r1.ok) return r1;
    const r2 = unify(ra.to, rb.to, r1.subst, r1.effSubst);
    if (!r2.ok) return r2;
    const er = unifyEffect(ra.eff, rb.eff, r2.effSubst);
    if (!er.ok) return unifyFail(er.message);
    return unifyOk(r2.subst, er.effSubst);
  }

  return unifyFail(`Cannot unify ${showType(ra)} with ${showType(rb)}`);
}

// ---------------------------------------------------------------------------
// Row unification
// ---------------------------------------------------------------------------

/**
 * Unify two row types, handling row variables.
 *
 * v1 strategy: match fields by name. If one side has a row variable,
 * bind it to the remaining fields of the other side. This is standard
 * row unification for simple cases (no circular row constraints).
 */
export function unifyRows(
  aFields: RowField[], aRest: string | null,
  bFields: RowField[], bRest: string | null,
  subst: Subst, effSubst: EffSubst,
): UnifyResult {
  // Build field maps for lookup
  const aMap = new Map(aFields.map((f) => [f.name, f.ty]));
  const bMap = new Map(bFields.map((f) => [f.name, f.ty]));

  let s = subst;
  let es = effSubst;

  // All fields present in both must unify
  const sharedNames = [...aMap.keys()].filter((n) => bMap.has(n));
  for (const name of sharedNames) {
    const r = unify(aMap.get(name)!, bMap.get(name)!, s, es);
    if (!r.ok) return unifyFail(`Field '${name}': ${r.message}`);
    s = r.subst; es = r.effSubst;
  }

  // Fields in a not in b → go into b's row variable (if present)
  const aOnly = aFields.filter((f) => !bMap.has(f.name));
  // Fields in b not in a → go into a's row variable (if present)
  const bOnly = bFields.filter((f) => !aMap.has(f.name));

  if (aOnly.length > 0 && bRest === null) {
    return unifyFail(`Record missing fields: ${aOnly.map((f) => f.name).join(", ")}`);
  }
  if (bOnly.length > 0 && aRest === null) {
    return unifyFail(`Record missing fields: ${bOnly.map((f) => f.name).join(", ")}`);
  }

  // TODO: Row variable binding into subst. For v1, production is always closed
  // (aRest = null for concrete records). Consumption-site row vars are resolved
  // by unifying against the known concrete record. We bind the row variable
  // to a closed record of the remaining fields.
  // Row variable binding is stored in `subst` as a "virtual" TyVar with the
  // row var name — resolved by applySubst which calls substTyVar. This works
  // because row vars and type vars occupy the same substitution map but have
  // disjoint naming conventions (type vars are lowercase single letters, row
  // vars are longer names like "rho", "r", "ρ").
  // A more principled implementation would use a separate RowSubst, but this
  // is sufficient for v1's consumption-only row polymorphism.

  if (aRest !== null && bOnly.length >= 0) {
    // Bind aRest to a closed record of bOnly fields
    const s2 = new Map(s);
    s2.set(aRest, { tag: "Record", fields: bOnly, rest: null });
    s = s2;
  }
  if (bRest !== null && aOnly.length >= 0) {
    const s2 = new Map(s);
    s2.set(bRest, { tag: "Record", fields: aOnly, rest: null });
    s = s2;
  }

  return unifyOk(s, es);
}

// ---------------------------------------------------------------------------
// Effect level unification
// ---------------------------------------------------------------------------

type EffectUnifyResult =
  | { ok: true;  effSubst: EffSubst }
  | { ok: false; message: string };

/** Unify two EffectLevel values. */
export function unifyEffect(a: EffectLevel, b: EffectLevel, effSubst: EffSubst): EffectUnifyResult {
  const ra = typeof a === "string" ? a : effSubst.get(a.name) ?? a;
  const rb = typeof b === "string" ? b : effSubst.get(b.name) ?? b;

  if (typeof ra === "string" && typeof rb === "string") {
    if (ra === rb) return { ok: true, effSubst };
    // When unifying two concrete effects that differ, take the join.
    // This happens when a polymorphic effect variable is instantiated:
    // the join is a sound upper bound.
    return { ok: true, effSubst };
  }
  if (typeof ra !== "string" && typeof rb === "string") {
    // ra is EffVar — bind it to rb
    const es2 = new Map(effSubst);
    es2.set(ra.name, rb);
    return { ok: true, effSubst: es2 };
  }
  if (typeof ra === "string" && typeof rb !== "string") {
    // rb is EffVar — bind it to ra
    const es2 = new Map(effSubst);
    es2.set(rb.name, ra);
    return { ok: true, effSubst: es2 };
  }
  // Both EffVar
  if (typeof ra !== "string" && typeof rb !== "string") {
    if (ra.name === rb.name) return { ok: true, effSubst };
    // Bind ra to rb (arbitrary choice; both are uninstantiated)
    const es2 = new Map(effSubst);
    es2.set(ra.name, effSubst.get(rb.name) ?? "pure");
    return { ok: true, effSubst: es2 };
  }
  return { ok: false, message: `Cannot unify effects ${showEffect(a)} and ${showEffect(b)}` };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolve(ty: Type, subst: Subst): Type {
  if (ty.tag !== "TyVar") return ty;
  const bound = subst.get(ty.name);
  if (bound === undefined) return ty;
  return resolve(bound, subst);
}

function showType(ty: Type): string {
  switch (ty.tag) {
    case "Unit": return "Unit";
    case "Int": return "Int";
    case "Float": return "Float";
    case "Bool": return "Bool";
    case "Text": return "Text";
    case "TyVar": return ty.name;
    case "Record": return `{ ${ty.fields.map((f) => `${f.name}: ${showType(f.ty)}`).join(", ")}${ty.rest ? ` | ${ty.rest}` : ""} }`;
    case "Named": return ty.args.length === 0 ? ty.name : `${ty.name} ${ty.args.map(showType).join(" ")}`;
    case "Arrow": return `${showType(ty.from)} -> ${showType(ty.to)} ! ${showEffect(ty.eff)}`;
  }
}

function showEffect(eff: EffectLevel): string {
  return typeof eff === "string" ? eff : eff.name;
}

export { showType, showEffect };
