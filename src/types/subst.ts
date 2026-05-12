/**
 * Substitution operations on Type.
 *
 * Substitution maps (Subst, EffSubst) and their application (applySubst,
 * applyEffSubst) live here so the elaborator can use them without reaching
 * into the typechecker layer.
 *
 * Four structural traversals, each with a specific caller:
 *   substTyVar  — typechecker (unification)
 *   substAdt    — elaborator (CataNode Pi[A/μF] substitution)
 *   substRowVar — elaborator (over, let live-set row expansion)
 *   substEffVar — typechecker (schema instantiation)
 *
 * All are capture-avoiding structural traversals.
 */

import type { ConcreteEffect, EffectLevel, RowField, Type } from "./type.ts";
import { typeEq } from "./check.ts";

// ---------------------------------------------------------------------------
// substTyVar — replace a type variable with a concrete type
// ---------------------------------------------------------------------------

/**
 * Substitute type variable `varName` with `replacement` throughout `ty`.
 * Used by the typechecker during unification and schema instantiation.
 */
export function substTyVar(ty: Type, varName: string, replacement: Type): Type {
  switch (ty.tag) {
    case "Unit":
    case "Int":
    case "Float":
    case "Bool":
    case "Text":
      return ty;

    case "TyVar":
      return ty.name === varName ? replacement : ty;

    case "Record": {
      const fields = ty.fields.map((f) => substFieldTyVar(f, varName, replacement));
      // If the rest variable matches varName and the replacement is a Record,
      // expand it: append the replacement's fields and propagate its rest.
      // This makes substTyVar correctly handle row-variable bindings stored in
      // the same Subst map (produced by unifyRows).
      if (ty.rest === varName && replacement.tag === "Record") {
        return { tag: "Record", fields: [...fields, ...replacement.fields], rest: replacement.rest };
      }
      return { tag: "Record", fields, rest: ty.rest };
    }

    case "Named":
      return {
        tag: "Named",
        name: ty.name,
        args: ty.args.map((t) => substTyVar(t, varName, replacement)),
      };

    case "Arrow":
      return {
        tag: "Arrow",
        from: substTyVar(ty.from, varName, replacement),
        to: substTyVar(ty.to, varName, replacement),
        eff: ty.eff,  // EffVar names are distinct from TyVar names; no collision
      };
  }
}

function substFieldTyVar(f: RowField, varName: string, replacement: Type): RowField {
  return { name: f.name, ty: substTyVar(f.ty, varName, replacement) };
}

// ---------------------------------------------------------------------------
// substAdt — replace all structural occurrences of an ADT type with carrier
// ---------------------------------------------------------------------------

/**
 * Replace every structural occurrence of `adtTy` within `ty` with `carrier`.
 *
 * This implements the base-functor substitution Pi[A/μF] required by the
 * catamorphism typing rule. Matching is by structural equality (typeEq).
 * Substitution is applied at every depth including inside Named args and
 * Record fields — this is required for nested recursive types like
 * `List (Tree a)` where `Tree a` appears inside a type application.
 *
 * Only occurrences exactly equal to `adtTy` are replaced. Other type
 * constructors, type parameters, and base types are unaffected.
 */
export function substAdt(ty: Type, adtTy: Type, carrier: Type): Type {
  // Check for a match before recursing — this handles all nesting depths.
  if (typeEq(ty, adtTy)) return carrier;

  switch (ty.tag) {
    case "Unit":
    case "Int":
    case "Float":
    case "Bool":
    case "Text":
    case "TyVar":
      return ty;

    case "Record":
      return {
        tag: "Record",
        fields: ty.fields.map((f) => substFieldAdt(f, adtTy, carrier)),
        rest: ty.rest,
      };

    case "Named":
      return {
        tag: "Named",
        name: ty.name,
        args: ty.args.map((t) => substAdt(t, adtTy, carrier)),
      };

    case "Arrow":
      return {
        tag: "Arrow",
        from: substAdt(ty.from, adtTy, carrier),
        to: substAdt(ty.to, adtTy, carrier),
        eff: ty.eff,
      };
  }
}

function substFieldAdt(f: RowField, adtTy: Type, carrier: Type): RowField {
  return { name: f.name, ty: substAdt(f.ty, adtTy, carrier) };
}

// ---------------------------------------------------------------------------
// substRowVar — expand a row variable to a concrete field list
// ---------------------------------------------------------------------------

/**
 * Replace row variable `varName` in `ty` with `fields`.
 *
 * A row variable appears only as `Record.rest`. When expanded, the new fields
 * are appended after the record's existing fields, producing a closed (or
 * less-open) record. Duplicate field names are not checked here; the
 * typechecker ensures well-formedness before elaboration.
 */
export function substRowVar(ty: Type, varName: string, fields: RowField[]): Type {
  switch (ty.tag) {
    case "Unit":
    case "Int":
    case "Float":
    case "Bool":
    case "Text":
    case "TyVar":
      return ty;

    case "Record": {
      const expandedFields = ty.fields.map((f) => substFieldRowVar(f, varName, fields));
      if (ty.rest === varName) {
        // Expand: append the substituted fields, close the record
        return { tag: "Record", fields: [...expandedFields, ...fields], rest: null };
      }
      return { tag: "Record", fields: expandedFields, rest: ty.rest };
    }

    case "Named":
      return {
        tag: "Named",
        name: ty.name,
        args: ty.args.map((t) => substRowVar(t, varName, fields)),
      };

    case "Arrow":
      return {
        tag: "Arrow",
        from: substRowVar(ty.from, varName, fields),
        to: substRowVar(ty.to, varName, fields),
        eff: ty.eff,
      };
  }
}

function substFieldRowVar(f: RowField, varName: string, fields: RowField[]): RowField {
  return { name: f.name, ty: substRowVar(f.ty, varName, fields) };
}

// ---------------------------------------------------------------------------
// substEffVar — replace an effect variable with a concrete effect level
// ---------------------------------------------------------------------------

/**
 * Replace effect variable `varName` with `eff` throughout all arrow types
 * in `ty`. Effect variables appear only in the `eff` annotation of Arrow types.
 * Used by the typechecker when instantiating higher-order def signatures.
 */
export function substEffVar(ty: Type, varName: string, eff: ConcreteEffect): Type {
  switch (ty.tag) {
    case "Unit":
    case "Int":
    case "Float":
    case "Bool":
    case "Text":
    case "TyVar":
      return ty;

    case "Record":
      return {
        tag: "Record",
        fields: ty.fields.map((f) => substFieldEffVar(f, varName, eff)),
        rest: ty.rest,
      };

    case "Named":
      return {
        tag: "Named",
        name: ty.name,
        args: ty.args.map((t) => substEffVar(t, varName, eff)),
      };

    case "Arrow": {
      const newEff = resolveEffVar(ty.eff, varName, eff);
      return {
        tag: "Arrow",
        from: substEffVar(ty.from, varName, eff),
        to: substEffVar(ty.to, varName, eff),
        eff: newEff,
      };
    }
  }
}

function resolveEffVar(level: EffectLevel, varName: string, replacement: ConcreteEffect): EffectLevel {
  if (typeof level === "string") return level;
  return level.name === varName ? replacement : level;
}

function substFieldEffVar(f: RowField, varName: string, eff: ConcreteEffect): RowField {
  return { name: f.name, ty: substEffVar(f.ty, varName, eff) };
}

// ---------------------------------------------------------------------------
// Subst / EffSubst — substitution maps and application
// ---------------------------------------------------------------------------

/** Type variable substitution map: varName → concrete (or partially resolved) Type. */
export type Subst = Map<string, Type>;

/** Effect variable substitution map: varName → ConcreteEffect. */
export type EffSubst = Map<string, ConcreteEffect>;

export const emptySubst: Subst = new Map();
export const emptyEffSubst: EffSubst = new Map();

/**
 * Apply a substitution to a type, fully resolving all type variables it mentions.
 * Chains through the substitution map: if a → b and b → Int, resolves a → Int.
 */
export function applySubst(ty: Type, subst: Subst, effSubst: EffSubst = emptyEffSubst): Type {
  let result = ty;
  for (const [varName, replacement] of subst) {
    result = substTyVar(result, varName, replacement);
  }
  for (const [varName, eff] of effSubst) {
    result = substEffVar(result, varName, eff);
  }
  return result;
}

/** Apply an effect substitution to an EffectLevel. */
export function applyEffSubst(eff: EffectLevel, effSubst: EffSubst): EffectLevel {
  if (typeof eff === "string") return eff;
  return effSubst.get(eff.name) ?? eff;
}
