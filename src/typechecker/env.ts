/**
 * Typechecker environments:
 *   Omega      — effect operation signatures
 *   GlobalEnv  — globally defined morphisms and constructors
 *   TypeDeclEnv — type declaration info (for ADT lookup and recursion detection)
 *   LocalEnv   — Γ_local: names introduced by { fields } >>> and let
 *   CheckEnv   — all of the above bundled for passing through check functions
 */

import type { ConcreteEffect, Type } from "../types/type.ts";
import type { Expr } from "../surface/ast.ts";
import type { SourceNodeId } from "../surface/id.ts";
import type { MorphTy, Omega } from "./typed-ast.ts";

export type { Omega };

// ---------------------------------------------------------------------------
// Global def environment
// ---------------------------------------------------------------------------

export type DefInfo = {
  name:     string;
  params:   DefParamInfo[];
  morphTy:  MorphTy;          // may contain TyVars for polymorphic defs
  body:     Expr;             // surface body, needed by elaborator for schema instantiation
  sourceId: SourceNodeId;
};

export type DefParamInfo = {
  name:    string;
  morphTy: MorphTy;           // may contain TyVars
};

// ---------------------------------------------------------------------------
// Constructor environment
// ---------------------------------------------------------------------------

export type CtorInfo = {
  ctorName:   string;
  adtName:    string;
  adtParams:  string[];       // type variable names declared on the ADT
  payloadTy:  Type | null;    // null = nullary; may contain TyVars matching adtParams
};

// ---------------------------------------------------------------------------
// Type declaration environment
// ---------------------------------------------------------------------------

export type TypeDeclInfo = {
  name:        string;
  params:      string[];
  body:        TypeDeclBody;
  isRecursive: boolean;       // true if any constructor payload references this ADT
  sourceId:    SourceNodeId;
};

export type TypeDeclBody =
  | { tag: "Record";  fields: { name: string; ty: Type }[] }
  | { tag: "Variant"; ctors: CtorInfo[] };

// ---------------------------------------------------------------------------
// Local environment — Γ_local
// ---------------------------------------------------------------------------

/**
 * Maps locally bound names to their value types.
 * All entries have the same implicit domain (the current morphism input type R).
 * Semantically each entry is a pure projection `.name : R -> nameType`.
 */
export type LocalEnv = ReadonlyMap<string, Type>;

export const emptyLocal: LocalEnv = new Map();

export function extendLocal(env: LocalEnv, name: string, ty: Type): LocalEnv {
  const m = new Map(env);
  m.set(name, ty);
  return m;
}

export function extendLocalMany(env: LocalEnv, entries: { name: string; ty: Type }[]): LocalEnv {
  const m = new Map(env);
  for (const { name, ty } of entries) m.set(name, ty);
  return m;
}

// ---------------------------------------------------------------------------
// Bundled check environment
// ---------------------------------------------------------------------------

export type GlobalEnv = {
  defs:  Map<string, DefInfo>;
  ctors: Map<string, CtorInfo>;   // keyed by constructor name (uppercase)
};

export type TypeDeclEnv = Map<string, TypeDeclInfo>;

export type CheckEnv = {
  omega:     Omega;
  globals:   GlobalEnv;
  typeDecls: TypeDeclEnv;
  locals:    LocalEnv;
  /** The concrete type of the current morphism input (the domain of the in-progress morphism). */
  inputTy:   Type;
};

export function withLocals(env: CheckEnv, locals: LocalEnv, inputTy: Type): CheckEnv {
  return { ...env, locals, inputTy };
}

export function withFreshLocals(env: CheckEnv, inputTy: Type): CheckEnv {
  return { ...env, locals: emptyLocal, inputTy };
}
