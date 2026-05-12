/**
 * Main typechecking logic for Weave v1.
 *
 * Entry point: checkModule(mod) → TypeResult<TypedModule>
 *
 * Two-pass structure:
 *   Pass 1: collect all type decls, effect decls, def signatures → build CheckEnv
 *   Pass 2: check each def body against its signature → produce TypedDefs
 *
 * Unification is performed here. The elaborator receives a fully typed AST
 * and performs no inference.
 */

import {
  type Type, type ConcreteEffect, type EffectLevel, type RowField,
  TInt, TFloat, TBool, TUnit, TText,
  record, field, named, tyVar, arrow, effVar,
} from "../types/type.ts";
import { substTyVar, substEffVar, substAdt } from "../types/subst.ts";
import { isConcrete, typeEq, effectLevelJoin, effectJoin } from "../types/check.ts";

import type {
  Module, TopDecl, TypeDecl, DefDecl, EffectDecl, DefParam,
  SurfaceType, SurfaceEffect, SurfaceLiteral, SurfaceField,
  Expr, Step, Branch, Handler, FieldBinder, FanoutField,
  BuildField, SchemaArg,
} from "../surface/ast.ts";
import type { SourceNodeId } from "../surface/id.ts";

import {
  type CheckEnv, type GlobalEnv, type TypeDeclEnv, type TypeDeclInfo,
  type TypeDeclBody, type DefInfo, type DefParamInfo, type CtorInfo,
  type LocalEnv, type Omega,
  emptyLocal, extendLocal, extendLocalMany, withLocals, withFreshLocals,
} from "./env.ts";

import {
  type Subst, type EffSubst,
  emptySubst, emptyEffSubst,
  unify, unifyRows, unifyEffect, applySubst, applyEffSubst, composeSubst, composeEffSubst,
  showType, showEffect,
} from "./unify.ts";

import {
  type TypedModule, type TypedDef, type TypedExpr, type TypedStep, type TypedNode,
  type TypedBranch, type TypedHandler, type TypedBinder, type LiveVar,
  type TypedBuildField, type TypedFanoutField, type TypedTypeDecl, type TypedTypeDeclBody,
  type TypedField, type TypedCtorDecl,
  type MorphTy, type OmegaEntry,
} from "./typed-ast.ts";

import { lookupInfixOp, resolveBuiltinType, BUILTIN_OPS } from "./builtins.ts";
import { ok, fail, typeError, collectResults, mapResult, type TypeResult, type TypeError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Schema instantiation dependency analysis (for topological ordering)
// ---------------------------------------------------------------------------

/** Walk a surface expression and collect the names of local schemas that it
 *  directly instantiates. Only names present in moduleSchemaNames are returned. */
function collectSchemaDeps(expr: Expr, moduleSchemaNames: Set<string>): Set<string> {
  const result = new Set<string>();
  visitExpr(expr);
  return result;

  function visitExpr(e: Expr): void { for (const s of e.steps) visitStep(s); }

  function visitStep(s: Step): void {
    switch (s.tag) {
      case "SchemaInst":
        if (moduleSchemaNames.has(s.name)) result.add(s.name);
        for (const arg of s.args) visitExpr(arg.expr);
        break;
      case "Fanout":
        for (const f of s.fields) { if (f.tag === "Field") visitExpr(f.expr); }
        break;
      case "Build":
        for (const f of s.fields) visitExpr(f.expr);
        break;
      case "Case":
      case "Fold":
        for (const b of s.branches) visitExpr(b.handler.body);
        break;
      case "Over":  visitStep(s.transform); break;
      case "Let":   visitExpr(s.rhs); visitExpr(s.body); break;
      case "Infix": visitStep(s.left); visitStep(s.right); break;
      // Name, Ctor, Projection, Literal, Perform — no sub-expressions
    }
  }
}

/** Topologically sort schema defs so that if A instantiates B, B appears before A.
 *  Uses Kahn's algorithm. Returns sorted defs and any that form a cycle.
 *  Cyclic schemas must not be checked — the caller should emit E_SCHEMA_CYCLE errors. */
function topoSortSchemaDefs(
  schemaDefs: DefDecl[],
  moduleSchemaNames: Set<string>,
): { sorted: DefDecl[]; cyclic: DefDecl[] } {
  if (schemaDefs.length === 0) return { sorted: [], cyclic: [] };

  const byName     = new Map<string, DefDecl>(schemaDefs.map(d => [d.name, d]));
  const dependents = new Map<string, string[]>(schemaDefs.map(d => [d.name, []]));
  const inDegree   = new Map<string, number>(schemaDefs.map(d => [d.name, 0]));

  // Schemas that directly instantiate themselves are self-cycles; mark them
  // with a high inDegree so Kahn's excludes them from the sorted output.
  for (const d of schemaDefs) {
    const deps = collectSchemaDeps(d.body, moduleSchemaNames);
    if (deps.has(d.name)) inDegree.set(d.name, inDegree.get(d.name)! + 1);
    deps.delete(d.name);
    for (const dep of deps) {
      if (byName.has(dep)) {
        dependents.get(dep)!.push(d.name);
        inDegree.set(d.name, inDegree.get(d.name)! + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) { if (deg === 0) queue.push(name); }

  const sorted: DefDecl[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(byName.get(name)!);
    for (const dep of dependents.get(name)!) {
      const newDeg = inDegree.get(dep)! - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  // Any remaining nodes are part of a cycle.
  const seen   = new Set(sorted.map(d => d.name));
  const cyclic = schemaDefs.filter(d => !seen.has(d.name));
  return { sorted, cyclic };
}

// ---------------------------------------------------------------------------
// Module entry point
// ---------------------------------------------------------------------------

/**
 * Symbols exported from a checked module, ready to be seeded into importers.
 * Defs are keyed by qualified name (e.g. "Foo.Bar.myDef").
 * Ctors and typeDecls are keyed by bare name (e.g. "Just", "Maybe").
 * Omega entries are keyed by qualified name (e.g. "Http.get").
 */
export type ModuleExports = {
  defs:      Map<string, DefInfo>;
  ctors:     Map<string, CtorInfo>;
  typeDecls: TypeDeclEnv;
  omega:     Omega;
};

export function checkModule(mod: Module, seeds?: ModuleExports): TypeResult<TypedModule> {
  // Pass 1: build environments from declarations
  const pass1 = buildEnv(mod, seeds);
  if (!pass1.ok) return pass1;
  const { env, typedTypeDecls, omega } = pass1.value;

  // Pass 2: check def bodies.
  // Two sweeps: schema defs (higher-order defs with params) first, then
  // non-schema defs. This ensures every schema's intrinsicEff is populated
  // before any instantiation (including forward references within the module)
  // runs checkSchemaInst. Without this ordering, a non-schema def that
  // instantiates a later-defined schema would observe the "pure" placeholder.
  const defPrefix = mod.path.join(".");
  const defResults: TypeResult<TypedDef>[] = [];

  const propagateIntrinsicEff = (decl: DefDecl, r: TypeResult<TypedDef>): void => {
    if (!r.ok) return;
    const bareName = decl.name;
    const qualName = defPrefix ? `${defPrefix}.${bareName}` : bareName;
    for (const key of [bareName, qualName]) {
      const existing = env.globals.defs.get(key);
      if (existing) env.globals.defs.set(key, { ...existing, intrinsicEff: r.value.intrinsicEff });
    }
  };

  // Sweep 1: schema defs in topological order (dependencies before dependents).
  // This ensures every schema's intrinsicEff is fully populated before any schema
  // that instantiates it is checked — including schema-to-schema forward refs.
  // Schemas in a cycle are rejected outright (E_SCHEMA_CYCLE) rather than checked
  // with stale "pure" placeholders, which would produce unsound effect judgements.
  const allSchemaDefs = mod.decls
    .filter((d): d is { tag: "DefDecl"; decl: DefDecl } =>
      d.tag === "DefDecl" && d.decl.params.length > 0)
    .map(d => d.decl);
  const moduleSchemaNames = new Set(allSchemaDefs.map(d => d.name));
  const { sorted: sortedSchemaDefs, cyclic: cyclicSchemaDefs } =
    topoSortSchemaDefs(allSchemaDefs, moduleSchemaNames);

  for (const decl of sortedSchemaDefs) {
    const r = checkDef(decl, env);
    propagateIntrinsicEff(decl, r);
    defResults.push(r);
  }

  if (cyclicSchemaDefs.length > 0) {
    const cycleNames = cyclicSchemaDefs.map(d => d.name).join(", ");
    for (const decl of cyclicSchemaDefs) {
      defResults.push(typeError(
        `schema instantiation cycle involving: ${cycleNames}`,
        decl.meta.id,
        "E_SCHEMA_CYCLE",
      ));
    }
  }

  // Sweep 2: non-schema defs — all schema intrinsicEff values are now set.
  for (const topDecl of mod.decls) {
    if (topDecl.tag !== "DefDecl" || topDecl.decl.params.length > 0) continue;
    defResults.push(checkDef(topDecl.decl, env));
  }
  const defsResult = collectResults(defResults);
  if (!defsResult.ok) return defsResult;

  const typedDefs = new Map<string, TypedDef>();
  for (const def of defsResult.value) typedDefs.set(def.name, def);

  return ok({
    path: mod.path,
    typedDefs,
    typeDecls: typedTypeDecls,
    omega,
    sourceId: mod.meta.id,
  });
}

// ---------------------------------------------------------------------------
// Pass 1: build environments
// ---------------------------------------------------------------------------

type EnvBuildResult = {
  env:             CheckEnv;
  typedTypeDecls:  Map<string, TypedTypeDecl>;
  omega:           Omega;
};

function buildEnv(mod: Module, seeds?: ModuleExports): TypeResult<EnvBuildResult> {
  const errors: TypeError[] = [];
  const typeDecls: TypeDeclEnv              = new Map(seeds?.typeDecls);
  const typedTypeDecls                      = new Map<string, TypedTypeDecl>();
  const omega: Omega                        = new Map(seeds?.omega);
  const defs: Map<string, DefInfo>          = new Map(seeds?.defs);
  const ctors: Map<string, CtorInfo>        = new Map(seeds?.ctors);

  // --- Collect type declarations ---
  // Pre-scan: register stub entries so self-referential (and mutually
  // recursive) types can resolve their own name during body resolution.
  for (const topDecl of mod.decls) {
    if (topDecl.tag !== "TypeDecl") continue;
    const decl = topDecl.decl;
    typeDecls.set(decl.name, {
      name: decl.name, params: decl.params,
      body: { tag: "Variant", ctors: [] }, // stub body replaced below
      isRecursive: false, sourceId: decl.meta.id,
    });
  }
  // Full resolution: build each type decl with the stub-populated typeDecls map.
  for (const topDecl of mod.decls) {
    if (topDecl.tag !== "TypeDecl") continue;
    const decl = topDecl.decl;
    const r = buildTypeDecl(decl, typeDecls);
    if (!r.ok) { errors.push(...r.errors); continue; }
    const { info, typed } = r.value;
    typeDecls.set(decl.name, info);   // replace stub with real entry
    typedTypeDecls.set(decl.name, typed);
    // Register constructors
    if (info.body.tag === "Variant") {
      for (const ctor of info.body.ctors) {
        ctors.set(ctor.ctorName, ctor);
      }
    }
  }

  // --- Collect effect declarations → Ω ---
  for (const topDecl of mod.decls) {
    if (topDecl.tag !== "EffectDecl") continue;
    const decl = topDecl.decl;
    const qualName = [...mod.path, decl.name].join(".");
    // Resolve types (no type params in effect decls)
    const inputR = resolveSurfaceType(decl.inputTy, [], typeDecls);
    const outputR = resolveSurfaceType(decl.outputTy, [], typeDecls);
    if (!inputR.ok)  { errors.push(...inputR.errors); continue; }
    if (!outputR.ok) { errors.push(...outputR.errors); continue; }
    const eff = resolveConcreteEffect(decl.eff, decl.meta.id);
    if (!eff.ok) { errors.push(...eff.errors); continue; }
    if (eff.value === "pure") {
      errors.push({ code: "E_INVALID_EFFECT_LEVEL", message: "effect declaration must have a non-pure effect level", sourceId: decl.meta.id });
      continue;
    }
    omega.set(qualName, {
      qualifiedName: qualName,
      inputTy: inputR.value,
      outputTy: outputR.value,
      eff: eff.value,
      sourceId: decl.meta.id,
    });
    // Also register without module prefix for single-module programs
    omega.set(decl.name, {
      qualifiedName: qualName,
      inputTy: inputR.value,
      outputTy: outputR.value,
      eff: eff.value,
      sourceId: decl.meta.id,
    });
  }

  // --- Collect def signatures ---
  // Unannotated defs (ty === null) are intentionally excluded from the pre-scan
  // env. They cannot be referenced by other defs, preventing unsound recursion
  // through the Unit→Unit placeholder. They are still checked in pass 2.
  const defPrefix = mod.path.join(".");
  for (const topDecl of mod.decls) {
    if (topDecl.tag !== "DefDecl") continue;
    const decl = topDecl.decl;
    if (decl.ty === null) continue;
    const r = buildDefSignature(decl, typeDecls);
    if (!r.ok) { errors.push(...r.errors); continue; }
    const qualName = defPrefix ? `${defPrefix}.${decl.name}` : decl.name;
    const info: DefInfo = { ...r.value, name: qualName };
    defs.set(decl.name, info);
    if (defPrefix) defs.set(qualName, info);
  }

  if (errors.length > 0) return fail(errors);

  const globals: GlobalEnv = { defs, ctors };
  const env: CheckEnv = {
    omega,
    globals,
    typeDecls,
    locals:  emptyLocal,
    inputTy: { tag: "Unit" },
  };
  return ok({ env, typedTypeDecls, omega });
}

// ---------------------------------------------------------------------------
// Type declaration building
// ---------------------------------------------------------------------------

function buildTypeDecl(decl: TypeDecl, typeDecls: TypeDeclEnv): TypeResult<{ info: TypeDeclInfo; typed: TypedTypeDecl }> {
  if (decl.body.tag === "Record") {
    const fieldsR = collectResults(
      decl.body.fields.map((f) => mapResult(
        resolveSurfaceType(f.ty, decl.params, typeDecls),
        (ty) => ok<TypedField>({ name: f.name, ty }),
      )),
    );
    if (!fieldsR.ok) return fieldsR;
    const fields = fieldsR.value;
    const info: TypeDeclInfo = {
      name: decl.name, params: decl.params,
      body: { tag: "Record", fields },
      isRecursive: false,
      sourceId: decl.meta.id,
    };
    const typed: TypedTypeDecl = {
      name: decl.name, params: decl.params,
      body: { tag: "Record", fields },
      isRecursive: false,
      sourceId: decl.meta.id,
    };
    return ok({ info, typed });
  }

  // Variant
  const ctorResults: TypeResult<CtorInfo>[] = [];
  for (const ctor of decl.body.ctors) {
    if (ctor.payload === null) {
      ctorResults.push(ok<CtorInfo>({
        ctorName: ctor.name, adtName: decl.name,
        adtParams: decl.params, payloadTy: null,
      }));
    } else {
      const fieldsR = collectResults(
        ctor.payload.map((f) => mapResult(
          resolveSurfaceType(f.ty, decl.params, typeDecls),
          (ty) => ok<{ name: string; ty: Type }>({ name: f.name, ty }),
        )),
      );
      ctorResults.push(mapResult(fieldsR, (fields) => ok<CtorInfo>({
        ctorName: ctor.name, adtName: decl.name,
        adtParams: decl.params,
        payloadTy: { tag: "Record", fields, rest: null },
      })));
    }
  }
  const ctorsR = collectResults(ctorResults);
  if (!ctorsR.ok) return ctorsR;
  const ctors = ctorsR.value;

  // Detect recursion: any constructor payload references the ADT name
  const isRecursive = ctors.some((c) => c.payloadTy !== null && typeReferences(c.payloadTy, decl.name));

  const info: TypeDeclInfo = {
    name: decl.name, params: decl.params,
    body: { tag: "Variant", ctors },
    isRecursive,
    sourceId: decl.meta.id,
  };
  const typedCtors: TypedCtorDecl[] = ctors.map((c) => ({ name: c.ctorName, payloadTy: c.payloadTy }));
  const typed: TypedTypeDecl = {
    name: decl.name, params: decl.params,
    body: { tag: "Variant", ctors: typedCtors },
    isRecursive,
    sourceId: decl.meta.id,
  };
  return ok({ info, typed });
}

function typeReferences(ty: Type, name: string): boolean {
  switch (ty.tag) {
    case "Unit": case "Int": case "Float": case "Bool": case "Text": case "TyVar": return false;
    case "Record": return ty.fields.some((f) => typeReferences(f.ty, name));
    case "Named": return ty.name === name || ty.args.some((a) => typeReferences(a, name));
    case "Arrow": return typeReferences(ty.from, name) || typeReferences(ty.to, name);
  }
}

// ---------------------------------------------------------------------------
// Def signature building
// ---------------------------------------------------------------------------

function buildDefSignature(decl: DefDecl, typeDecls: TypeDeclEnv): TypeResult<DefInfo> {
  // Collect all type-variable names from params + signature
  const tyVarNames = collectTyVarNames(decl);

  // Resolve params
  const paramResults = decl.params.map((p) => buildDefParam(p, tyVarNames, typeDecls));
  const paramsR = collectResults(paramResults);
  if (!paramsR.ok) return paramsR;

  let morphTy: MorphTy;
  if (decl.ty === null) {
    // Unannotated def: placeholder morphTy for the pre-scan. checkDef replaces
    // this with the actual inferred morphTy once the body is checked.
    morphTy = { input: { tag: "Unit" }, output: { tag: "Unit" }, eff: "pure" };
  } else if (decl.ty.tag === "Arrow") {
    // Arrow type: input and output are explicit
    const tyR = resolveSurfaceType(decl.ty, tyVarNames, typeDecls);
    if (!tyR.ok) return tyR;
    const arrowTy = tyR.value;
    if (arrowTy.tag !== "Arrow") return typeError("Internal: expected Arrow", decl.meta.id, "E_INTERNAL");
    const concreteEff = resolveEffLevelFinal(arrowTy.eff, decl.meta.id);
    if (!concreteEff.ok) return concreteEff;
    morphTy = { input: arrowTy.from, output: arrowTy.to, eff: concreteEff.value };
  } else {
    // Unit-sourced def: ty is the output type; effect from outer annotation
    const tyR = resolveSurfaceType(decl.ty, tyVarNames, typeDecls);
    if (!tyR.ok) return tyR;
    const concreteEff = resolveConcreteEffect(decl.eff ?? "pure", decl.meta.id);
    if (!concreteEff.ok) return concreteEff;
    morphTy = { input: { tag: "Unit" }, output: tyR.value, eff: concreteEff.value };
  }

  return ok({
    name:        decl.name,
    params:      paramsR.value,
    morphTy,
    body:        decl.body,
    sourceId:    decl.meta.id,
    intrinsicEff: "pure",  // placeholder; updated after pass-2 checks schema defs
  });
}

function buildDefParam(p: DefParam, tyVarNames: string[], typeDecls: TypeDeclEnv): TypeResult<DefParamInfo> {
  if (p.ty.tag !== "Arrow") {
    return typeError(`Parameter '${p.name}' must have an arrow type`, p.meta.id, "E_INVALID_PARAM_TYPE");
  }
  const tyR = resolveSurfaceType(p.ty, tyVarNames, typeDecls);
  if (!tyR.ok) return tyR;
  const ty = tyR.value;
  if (ty.tag !== "Arrow") return typeError("Internal: expected Arrow", p.meta.id, "E_INTERNAL");
  const effR = resolveEffLevelFinal(ty.eff, p.meta.id);
  if (!effR.ok) return effR;
  return ok({
    name: p.name,
    morphTy: { input: ty.from, output: ty.to, eff: effR.value },
  });
}

/** Collect all type variable names referenced in a def declaration. */
function collectTyVarNames(decl: DefDecl): string[] {
  const names = new Set<string>();
  const visitST = (st: SurfaceType) => {
    switch (st.tag) {
      case "TyVar": names.add(st.name); break;
      case "Arrow": visitST(st.from); visitST(st.to); break;
      case "Named": st.args.forEach(visitST); break;
      case "Record": st.fields.forEach((f) => visitST(f.ty)); break;
      case "BaseType": break;
    }
    if (st.tag === "Arrow" && st.eff !== null && typeof st.eff !== "string") {
      // EffVar — not a type var, handled separately
    }
  };
  decl.params.forEach((p) => visitST(p.ty));
  if (decl.ty !== null) visitST(decl.ty);
  return [...names];
}

// ---------------------------------------------------------------------------
// Surface type resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a SurfaceType to a Type, given the in-scope type variable names
 * and the type declaration environment.
 */
function resolveSurfaceType(st: SurfaceType, tyVarNames: string[], typeDecls: TypeDeclEnv): TypeResult<Type> {
  switch (st.tag) {
    case "BaseType":
      return ok(resolveBaseType(st.base));
    case "TyVar":
      if (tyVarNames.includes(st.name)) return ok({ tag: "TyVar", name: st.name });
      return typeError(`Unknown type variable '${st.name}'`, st.meta.id, "E_UNKNOWN_TYPE_VAR");
    case "Named": {
      const builtin = resolveBuiltinType(st.name);
      if (builtin !== null) {
        if (st.args.length > 0) return typeError(`Builtin type ${st.name} takes no arguments`, st.meta.id, "E_TYPE_ARITY");
        return ok(builtin);
      }
      const argsR = collectResults(st.args.map((a) => resolveSurfaceType(a, tyVarNames, typeDecls)));
      if (!argsR.ok) return argsR;
      // Validate the type name exists
      if (!typeDecls.has(st.name)) {
        return typeError(`Unknown type '${st.name}'`, st.meta.id, "E_UNKNOWN_TYPE");
      }
      return ok({ tag: "Named", name: st.name, args: argsR.value });
    }
    case "Record": {
      const fieldsR = collectResults(
        st.fields.map((f) => mapResult(
          resolveSurfaceType(f.ty, tyVarNames, typeDecls),
          (ty) => ok<RowField>({ name: f.name, ty }),
        )),
      );
      if (!fieldsR.ok) return fieldsR;
      return ok({ tag: "Record", fields: fieldsR.value, rest: st.rest });
    }
    case "Arrow": {
      const fromR = resolveSurfaceType(st.from, tyVarNames, typeDecls);
      const toR   = resolveSurfaceType(st.to,   tyVarNames, typeDecls);
      if (!fromR.ok) return fromR;
      if (!toR.ok)   return toR;
      const eff: EffectLevel = st.eff === null ? "pure" : resolveSurfaceEffect(st.eff);
      return ok({ tag: "Arrow", from: fromR.value, to: toR.value, eff });
    }
  }
}

function resolveBaseType(base: "Int" | "Float" | "Bool" | "Text" | "Unit"): Type {
  switch (base) {
    case "Int":   return TInt;
    case "Float": return TFloat;
    case "Bool":  return TBool;
    case "Text":  return TText;
    case "Unit":  return TUnit;
  }
}

function resolveSurfaceEffect(eff: SurfaceEffect): EffectLevel {
  if (typeof eff === "string") return eff;
  return { tag: "EffVar", name: eff.name };
}

function resolveConcreteEffect(eff: SurfaceEffect, sourceId: SourceNodeId): TypeResult<ConcreteEffect> {
  if (typeof eff === "string") return ok(eff);
  return typeError(`Effect variable '${eff.name}' cannot appear here — expected a concrete effect`, sourceId, "E_INVALID_EFFECT_VAR");
}

function resolveEffLevelFinal(eff: EffectLevel, sourceId: SourceNodeId): TypeResult<ConcreteEffect> {
  if (typeof eff === "string") return ok(eff);
  // EffVar at this point means an effect variable in a def param or def signature
  // that was never resolved through unification. Silently defaulting to "pure" is
  // wrong: a param declared `f: a -> b ! ε` would be recorded as `f: a -> b ! pure`,
  // causing the schema's effect to be misreported and breaking the parallel-safe
  // semantic contract (spec §4.4). In v1, effect polymorphism on def params is not
  // supported — require a concrete effect annotation.
  return typeError(
    `effect variable '${eff.name}' is not supported in v1 — use a concrete effect ('pure', 'parallel-safe', or 'sequential')`,
    sourceId,
    "E_INVALID_EFFECT_VAR",
  );
}

// ---------------------------------------------------------------------------
// Pass 2: check def bodies
// ---------------------------------------------------------------------------

export function checkDef(decl: DefDecl, env: CheckEnv): TypeResult<TypedDef> {
  let defInfo = env.globals.defs.get(decl.name);
  if (decl.ty === null) {
    // Unannotated def: always build a fresh local signature rather than using
    // any env entry (which may be absent, or may be a seeded import that shares
    // the name and would corrupt the type check).
    const sigR = buildDefSignature(decl, env.typeDecls);
    if (!sigR.ok) return sigR;
    defInfo = sigR.value;
  } else if (!defInfo) {
    return typeError(`Internal: def '${decl.name}' not in environment`, decl.meta.id, "E_INTERNAL");
  }

  // For polymorphic defs, freshen type variables before checking
  // (prevents clashes between def-level vars and call-site vars)
  const { morphTy, params } = defInfo;

  // The body has input type = morphTy.input, and must produce output type = morphTy.output
  const bodyEnv = withFreshLocals(env, morphTy.input);

  // Bind higher-order param names into globals so they can be referenced in the body
  const bodyEnvWithParams = bindParamsAsGlobals(bodyEnv, params, decl.meta.id);

  const bodyR = checkExpr(decl.body, morphTy.input, bodyEnvWithParams);
  if (!bodyR.ok) return bodyR;

  const typedBody = bodyR.value;

  // Unannotated def: morphTy is fully inferred from the body; no declared type to check.
  if (decl.ty === null) {
    const paramNameSet0 = new Set(params.map((p) => p.name));
    return ok({
      name:        decl.name,
      params:      params.map((p) => ({ name: p.name, morphTy: p.morphTy })),
      morphTy:     { input: morphTy.input, output: typedBody.morphTy.output, eff: typedBody.morphTy.eff },
      body:        typedBody,
      surfaceBody: decl.body,
      sourceId:    decl.meta.id,
      intrinsicEff: computeBodyIntrinsicEffect(typedBody, paramNameSet0, env.globals.defs),
    });
  }

  // Check body output type matches declared output type
  const unifyR = unify(typedBody.morphTy.output, morphTy.output);
  if (!unifyR.ok) {
    return typeError(
      `Def '${decl.name}': body type ${showType(typedBody.morphTy.output)} does not match declared output type ${showType(morphTy.output)}: ${unifyR.message}`,
      decl.meta.id,
      "E_TYPE_MISMATCH",
    );
  }

  // Check effect level: body effect must not exceed declared effect
  const bodyEff = typedBody.morphTy.eff;
  const declEff = morphTy.eff;
  if (effectRank(bodyEff) > effectRank(declEff)) {
    return typeError(
      `Def '${decl.name}': body has effect '${bodyEff}' but declaration promises '${declEff}'`,
      decl.meta.id,
      "E_EFFECT_MISMATCH",
    );
  }

  // Apply the final output-unification substitution to the body before storing.
  // checkCaseOrFold creates fresh type variables (via freshenCtor/freshenDef) that
  // are only connected to the def's declared type variables (like `b`) through this
  // final unification. Without this step those fresh vars persist in the stored body
  // and cannot be resolved by elabSchemaInst's tySubst, which only maps declared
  // type variable names to concrete types.
  const finalBody = substTypedExpr(typedBody, unifyR.subst, unifyR.effSubst);

  // Compute the intrinsic body effect: the effect of the body with all schema-param
  // Ref nodes treated as pure. Used by checkSchemaInst to derive the precise
  // instantiated effect rather than inheriting the declaration's upper bound.
  const paramNameSet = new Set(params.map((p) => p.name));
  const intrinsicEff = computeBodyIntrinsicEffect(finalBody, paramNameSet, env.globals.defs);

  return ok({
    name:        decl.name,
    params:      params.map((p) => ({ name: p.name, morphTy: p.morphTy })),
    morphTy,
    body:        finalBody,
    surfaceBody: decl.body,
    sourceId:    decl.meta.id,
    intrinsicEff,
  });
}

/** Temporarily bind higher-order params as global defs so body expressions can reference them. */
function bindParamsAsGlobals(env: CheckEnv, params: DefParamInfo[], sourceId: SourceNodeId): CheckEnv {
  if (params.length === 0) return env;
  const newDefs = new Map(env.globals.defs);
  for (const p of params) {
    newDefs.set(p.name, {
      name:     p.name,
      params:   [],
      morphTy:  p.morphTy,
      // Dummy body — params are not elaborated as schema instantiations
      body: { tag: "Pipeline", steps: [{ tag: "Name", name: p.name, meta: { id: sourceId, span: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } } }], meta: { id: sourceId, span: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } } },
      sourceId,
      intrinsicEff: "pure",  // params can't be schema-instantiated, field unused
    });
  }
  return { ...env, globals: { ...env.globals, defs: newDefs } };
}

// ---------------------------------------------------------------------------
// Expression checking
// ---------------------------------------------------------------------------

/**
 * Check a pipeline expression. The input type flows left-to-right through steps.
 * Returns a TypedExpr whose morphTy spans the full pipeline.
 */
export function checkExpr(expr: Expr, inputTy: Type, env: CheckEnv): TypeResult<TypedExpr> {
  if (expr.steps.length === 0) {
    return typeError("Empty pipeline", expr.meta.id, "E_EMPTY_PIPELINE");
  }

  const typedSteps: TypedStep[] = [];
  let currentInput = inputTy;
  let overallEff: ConcreteEffect = "pure";

  // Note: substitutions produced inside individual steps (e.g. by checkCase or
  // checkSchemaInst) are not accumulated and threaded back through `currentInput`
  // across steps. This is safe in v1 because all pipeline types are fully
  // concrete — TyVars appear only in schema params which are resolved before
  // elaboration, never in inter-step types. A future polymorphic pipeline would
  // require checkStep to return a Subst and checkExpr to apply it to currentInput.
  for (const step of expr.steps) {
    if (step.tag === "Infix") {
      const r = handleInfix(step.op, step.left, step.right, currentInput, env, step.meta.id);
      if (!r.ok) return r;
      typedSteps.push(r.value.fanoutStep);
      typedSteps.push(r.value.refStep);
      currentInput = r.value.refStep.morphTy.output;
      overallEff = effectJoin(effectJoin(overallEff, r.value.fanoutStep.morphTy.eff), r.value.refStep.morphTy.eff);
    } else {
      const r = checkStep(step, currentInput, env);
      if (!r.ok) return r;
      typedSteps.push(r.value);
      currentInput = r.value.morphTy.output;
      overallEff = effectJoin(overallEff, r.value.morphTy.eff);
    }
  }

  return ok({
    steps:    typedSteps,
    morphTy:  { input: inputTy, output: currentInput, eff: overallEff },
    sourceId: expr.meta.id,
  });
}

/**
 * Check a single step. Returns a TypedStep with the morphism type of that step.
 */
export function checkStep(step: Step, inputTy: Type, env: CheckEnv): TypeResult<TypedStep> {
  switch (step.tag) {

    // --- Name (global ref or local ref) ---
    case "Name": {
      // Check local first
      const localTy = env.locals.get(step.name);
      if (localTy !== undefined) {
        // Local ref: projection from current input → localTy
        return ok(makeStep(
          { tag: "LocalRef", name: step.name },
          { input: inputTy, output: localTy, eff: "pure" },
          step.meta.id,
        ));
      }
      // Global ref
      const defInfo = env.globals.defs.get(step.name);
      if (!defInfo) {
        return typeError(`Undefined name '${step.name}'`, step.meta.id, "E_UNDEFINED_NAME");
      }
      // For a non-parameterised def, its morphTy must unify with the current context
      if (defInfo.params.length > 0) {
        return typeError(
          `'${step.name}' is a higher-order def and requires schema instantiation arguments`,
          step.meta.id,
          "E_NOT_SCHEMA",
        );
      }
      // Freshen type variables in the def's morphTy for this use site
      const { morphTy } = freshenDef(defInfo);
      // Unify input: the def's input must match the current inputTy
      const unifyR = unify(morphTy.input, inputTy);
      if (!unifyR.ok) {
        return typeError(
          `'${step.name}': expected input ${showType(morphTy.input)}, got ${showType(inputTy)}: ${unifyR.message}`,
          step.meta.id,
          "E_TYPE_MISMATCH",
        );
      }
      const resolvedOutput = applySubst(morphTy.output, unifyR.subst, unifyR.effSubst);
      const resolvedEff = resolveEffFinal(applyEffSubst(morphTy.eff, unifyR.effSubst));
      return ok(makeStep(
        { tag: "Ref", defId: defInfo.name },
        { input: inputTy, output: resolvedOutput, eff: resolvedEff },
        step.meta.id,
      ));
    }

    // --- Constructor ---
    case "Ctor": {
      const ctorInfo = env.globals.ctors.get(step.name);
      if (!ctorInfo) return typeError(`Unknown constructor '${step.name}'`, step.meta.id, "E_UNKNOWN_CTOR");
      // Freshen the constructor's type variables for this use site
      const { payloadTy, adtTy } = freshenCtor(ctorInfo);
      const ctorInputTy = payloadTy ?? { tag: "Unit" as const };
      const unifyR = unify(ctorInputTy, inputTy);
      if (!unifyR.ok) {
        return typeError(
          `Constructor '${step.name}': expected input ${showType(ctorInputTy)}, got ${showType(inputTy)}: ${unifyR.message}`,
          step.meta.id,
          "E_TYPE_MISMATCH",
        );
      }
      const resolvedAdt = applySubst(adtTy, unifyR.subst);
      return ok(makeStep(
        { tag: "Ctor", name: step.name },
        { input: inputTy, output: resolvedAdt, eff: "pure" },
        step.meta.id,
      ));
    }

    // --- Projection ---
    case "Projection": {
      const fieldTy = lookupField(inputTy, step.field, env);
      if (!fieldTy.ok) return typeError(
        `Projection .${step.field}: ${fieldTy.message}`,
        step.meta.id,
        "E_UNKNOWN_FIELD",
      );
      return ok(makeStep(
        { tag: "Projection", field: step.field },
        { input: inputTy, output: fieldTy.ty, eff: "pure" },
        step.meta.id,
      ));
    }

    // --- Literal ---
    case "Literal": {
      const litTy = literalType(step.value);
      // Literals are unit-sourced: 1 -> T. When used as a step, input is dropped.
      // The morphism is (inputTy -> litTy) via terminal morphism composition.
      return ok(makeStep(
        { tag: "Literal", value: step.value },
        { input: inputTy, output: litTy, eff: "pure" },
        step.meta.id,
      ));
    }

    // --- Build ---
    case "Build": {
      return checkBuild(step.fields, inputTy, env, step.meta.id);
    }

    // --- Fanout ---
    case "Fanout": {
      return checkFanout(step.fields, inputTy, env, step.meta.id);
    }

    // --- Case / case .field ---
    case "Case": {
      if (step.field !== undefined) {
        return checkCaseField(step.field, step.branches, inputTy, env, step.meta.id);
      }
      return checkCaseOrFold(step.branches, inputTy, env, step.meta.id, "case");
    }

    // --- Fold ---
    case "Fold": {
      return checkCaseOrFold(step.branches, inputTy, env, step.meta.id, "fold");
    }

    // --- Over ---
    case "Over": {
      return checkOver(step.field, step.transform, inputTy, env, step.meta.id);
    }

    // --- Let ---
    case "Let": {
      return checkLet(step.name, step.rhs, step.body, inputTy, env, step.meta.id);
    }

    // --- Perform ---
    case "Perform": {
      return checkPerform(step.op, inputTy, env, step.meta.id);
    }

    // --- Schema instantiation ---
    case "SchemaInst": {
      return checkSchemaInst(step.name, step.args, inputTy, env, step.meta.id);
    }

    case "Infix": {
      // Infix is handled before dispatch in checkExpr and never reaches here.
      return typeError(`Internal: Infix step reached checkStep`, step.meta.id, "E_INTERNAL");
    }
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function checkBuild(
  fields: BuildField[], inputTy: Type, env: CheckEnv, sourceId: SourceNodeId,
): TypeResult<TypedStep> {
  if (fields.length === 0) {
    // build {} = unit value; input is the actual contextual type (may be non-unit)
    return ok(makeStep(
      { tag: "Build", fields: [] },
      { input: inputTy, output: { tag: "Unit" }, eff: "pure" },
      sourceId,
    ));
  }

  // Check closedness: no Γ_local references allowed in build field expressions
  const closednessErrors: TypeError[] = [];
  for (const f of fields) {
    const localNames = collectLocalNames(f.expr, env.locals);
    for (const name of localNames) {
      closednessErrors.push({
        code: "E_BUILD_AMBIENT_REF",
        message: `build field '${f.name}': ambient name '${name}' is not permitted in build expressions (use fanout instead)`,
        sourceId,
      });
    }
  }
  if (closednessErrors.length > 0) return fail(closednessErrors);

  // Each field expression is unit-sourced
  const fieldResults = fields.map((f) =>
    mapResult(
      checkExpr(f.expr, { tag: "Unit" }, withFreshLocals(env, { tag: "Unit" })),
      (typedExpr) => ok<TypedBuildField>({ name: f.name, expr: typedExpr }),
    ),
  );
  const fieldsR = collectResults(fieldResults);
  if (!fieldsR.ok) return fieldsR;

  const outputFields = fieldsR.value.map((f) => ({
    name: f.name,
    ty:   f.expr.morphTy.output,
  }));
  const outputTy: Type = { tag: "Record", fields: outputFields, rest: null };
  const eff = fieldsR.value.reduce<ConcreteEffect>(
    (acc, f) => effectJoin(acc, f.expr.morphTy.eff), "pure",
  );

  return ok(makeStep(
    { tag: "Build", fields: fieldsR.value },
    { input: inputTy, output: outputTy, eff },
    sourceId,
  ));
}

/** Collect all local names referenced in an expression, respecting shadowing. */
function collectLocalNames(expr: Expr, locals: LocalEnv): string[] {
  const found: string[] = [];
  const visitExpr = (e: Expr, loc: LocalEnv) => e.steps.forEach((s) => visitStep(s, loc));
  const visitStep = (step: Step, loc: LocalEnv) => {
    if (step.tag === "Name" && loc.has(step.name)) found.push(step.name);
    if (step.tag === "Build")   step.fields.forEach((f) => visitExpr(f.expr, loc));
    if (step.tag === "Fanout")  step.fields.forEach((f) => { if (f.tag === "Field") visitExpr(f.expr, loc); });
    if (step.tag === "Let")     { visitExpr(step.rhs, loc); visitExpr(step.body, loc); }
    if (step.tag === "Over")    visitStep(step.transform, loc);
    if (step.tag === "Case" || step.tag === "Fold")
      step.branches.forEach((b) => visitHandler(b.handler, loc));
    if (step.tag === "Infix")      { visitStep(step.left, loc); visitStep(step.right, loc); }
    if (step.tag === "SchemaInst") step.args.forEach((a) => visitExpr(a.expr, loc));
  };
  const visitHandler = (h: Handler, loc: LocalEnv) => {
    if (h.tag === "NullaryHandler") {
      visitExpr(h.body, loc);
    } else {
      // Record binders shadow outer locals within the handler body.
      const restricted = new Map(loc);
      for (const b of h.binders) {
        if (b.tag === "Bind") restricted.delete(b.name);
      }
      visitExpr(h.body, restricted);
    }
  };
  visitExpr(expr, locals);
  return found;
}

// ---------------------------------------------------------------------------
// Fanout
// ---------------------------------------------------------------------------

function checkFanout(
  fields: FanoutField[], inputTy: Type, env: CheckEnv, sourceId: SourceNodeId,
): TypeResult<TypedStep> {
  if (fields.length === 0) {
    // fanout {} = terminal morphism ! : I -> 1
    return ok(makeStep(
      { tag: "Fanout", fields: [] },
      { input: inputTy, output: { tag: "Unit" }, eff: "pure" },
      sourceId,
    ));
  }

  const typedFields: TypedFanoutField[] = [];
  let eff: ConcreteEffect = "pure";
  const errors: TypeError[] = [];

  for (const f of fields) {
    // Expand shorthand: `name` → `name: name`
    const fieldExpr: Expr = f.tag === "Shorthand"
      ? singleNameExpr(f.name, f.meta.id)
      : f.expr;

    // norm_I: field expressions must have domain inputTy or 1
    const r = normI(fieldExpr, inputTy, env);
    if (!r.ok) { errors.push(...r.errors); continue; }
    const typedExpr = r.value;
    const fieldName = f.tag === "Field" ? f.name : f.name;
    typedFields.push({ name: fieldName, expr: typedExpr });
    eff = effectJoin(eff, typedExpr.morphTy.eff);
  }
  if (errors.length > 0) return fail(errors);

  const outputFields = typedFields.map((f) => ({ name: f.name, ty: f.expr.morphTy.output }));
  return ok(makeStep(
    { tag: "Fanout", fields: typedFields },
    { input: inputTy, output: { tag: "Record", fields: outputFields, rest: null }, eff },
    sourceId,
  ));
}

/**
 * norm_I: normalize an expression to domain inputTy.
 * Case A: expression domain = inputTy → use directly
 * Case B: expression domain = 1 → lift via !
 * Case C: other domain → type error
 */
function normI(expr: Expr, inputTy: Type, env: CheckEnv): TypeResult<TypedExpr> {
  // Try checking as input-derived (Case A)
  const rA = checkExpr(expr, inputTy, env);
  if (rA.ok) return rA;

  // Try checking as unit-sourced (Case B)
  const rB = checkExpr(expr, { tag: "Unit" }, withFreshLocals(env, { tag: "Unit" }));
  if (rB.ok) {
    // Wrap: the typed expr has input 1, but we need input inputTy.
    // The elaborator will insert ! >>> before it. We record the original inputTy.
    // We represent this by keeping the typed expr as-is; the elaborator checks
    // morphTy.input === Unit and lifts accordingly.
    return rB;
  }

  // Case C: neither works — return the input-typed error (most actionable for the user).
  // Note: dual failure does not guarantee a top-level domain mismatch; the expression
  // may be correctly input-derived but contain an internal type error. Preserving rA
  // keeps the actionable downstream diagnostic visible.
  return rA;
}

// ---------------------------------------------------------------------------
// Case / Fold
// ---------------------------------------------------------------------------

function checkCaseOrFold(
  branches: Branch[], inputTy: Type, env: CheckEnv,
  sourceId: SourceNodeId, hint: "case" | "fold",
): TypeResult<TypedStep> {
  // Determine the variant type from inputTy
  const variantInfo = resolveVariant(inputTy, env.typeDecls, sourceId);
  if (!variantInfo.ok) return variantInfo;
  const { info, typeArgs } = variantInfo.value;

  // Determine if this is case or fold.
  // fold requires a recursive ADT; case is a plain coproduct eliminator on any variant.
  if (hint === "fold" && !info.isRecursive) {
    return typeError(
      `fold: input type '${showType(inputTy)}' is not a recursive ADT`,
      sourceId,
      "E_NOT_RECURSIVE_ADT",
    );
  }
  const isFold = hint === "fold";

  // Validate exhaustiveness
  const ctorNames = new Set(
    info.body.tag === "Variant" ? info.body.ctors.map((c) => c.ctorName) : [],
  );
  const branchCtors = new Set(branches.map((b) => b.ctor));
  const errors: TypeError[] = [];
  for (const name of ctorNames) {
    if (!branchCtors.has(name)) errors.push({ code: "E_MISSING_BRANCH", message: `${isFold ? "fold" : "case"}: missing branch for constructor '${name}'`, sourceId });
  }
  for (const name of branchCtors) {
    if (!ctorNames.has(name)) errors.push({ code: "E_UNKNOWN_BRANCH", message: `${isFold ? "fold" : "case"}: unknown constructor '${name}'`, sourceId });
  }
  if (errors.length > 0) return fail(errors);

  // For fold, we need to determine the carrier type A.
  // We'll use a fresh type variable for A and unify across branches.
  const carrierVar = isFold ? freshTyVar() : null;

  // Check branches
  const typedBranches: TypedBranch[] = [];
  let overallEff: ConcreteEffect = "pure";
  let outputTy: Type | null = null;
  let subst: Subst = new Map();
  let effSubst: EffSubst = new Map();

  if (info.body.tag !== "Variant") {
    return typeError(`${isFold ? "fold" : "case"}: input type must be a variant`, sourceId, "E_NOT_VARIANT");
  }

  for (const branch of branches) {
    const ctorInfo = findCtor(info.body.ctors, branch.ctor);
    if (!ctorInfo) continue; // already reported as error above

    // Instantiate the constructor's payload type with the type arguments
    const instantiatedPayload = instantiatePayload(ctorInfo, typeArgs);

    // For fold: substitute μF → A in the payload type
    const branchPayloadTy: Type = isFold && carrierVar !== null
      ? substAdt(instantiatedPayload ?? { tag: "Unit" }, inputTy, { tag: "TyVar", name: carrierVar })
      : (instantiatedPayload ?? { tag: "Unit" });

    // For multi-recursive ADTs (e.g. Tree { left: A, right: A }) the same carrier TyVar
    // appears in both fields. Checking the handler with unresolved TyVars means
    // unify(TyVar, TyVar) can't anchor the carrier to a concrete type inside the handler
    // (e.g. `left + right` fails because `+` needs Int, not TyVar).
    //
    // Fix: if the carrier has already been resolved to a fully-concrete type (no residual
    // TyVars), apply the outer subst to the branch payload before checking. When the
    // carrier is not yet concrete (e.g. schema folds where it's still a named TyVar like
    // `List(b)`), we leave it unresolved — the outer unification chain handles it later.
    const resolvedBranchPayloadTy = (() => {
      if (!isFold || carrierVar === null) return branchPayloadTy;
      const resolvedCarrier = applySubst({ tag: "TyVar", name: carrierVar }, subst, effSubst);
      const carrierVars = new Set<string>();
      collectVarsInType(resolvedCarrier, carrierVars, new Set());
      if (carrierVars.size > 0) return branchPayloadTy; // not concrete yet
      return applySubst(branchPayloadTy, subst, effSubst);
    })();

    // Check the branch handler
    const handlerR = checkHandler(branch.handler, resolvedBranchPayloadTy, env, sourceId);
    if (!handlerR.ok) { errors.push(...handlerR.errors); continue; }
    const { typedHandler, outputTy: branchOut, eff: branchEff } = handlerR.value;

    overallEff = effectJoin(overallEff, branchEff);

    // Unify branch output with overall output type
    if (outputTy === null) {
      outputTy = branchOut;
    } else {
      const uR = unify(outputTy, branchOut, subst, effSubst);
      if (!uR.ok) {
        errors.push({ code: "E_BRANCH_TYPE_MISMATCH", message: `${isFold ? "fold" : "case"} branch '${branch.ctor}': output type ${showType(branchOut)} is incompatible with prior branches (${showType(outputTy)})`, sourceId });
        continue;
      }
      subst = uR.subst; effSubst = uR.effSubst;
      outputTy = applySubst(outputTy, subst, effSubst);
    }

    // For fold: unify carrier variable with the output type
    if (isFold && carrierVar !== null && outputTy !== null) {
      const uR = unify({ tag: "TyVar", name: carrierVar }, outputTy, subst, effSubst);
      if (!uR.ok) {
        errors.push({ code: "E_TYPE_MISMATCH", message: `fold carrier type conflict: ${uR.message}`, sourceId });
        continue;
      }
      subst = uR.subst; effSubst = uR.effSubst;
    }

    typedBranches.push({
      ctor:         branch.ctor,
      rawPayloadTy: instantiatedPayload ?? { tag: "Unit" },
      payloadTy:    branchPayloadTy,
      handler:      typedHandler,
    });
  }

  if (errors.length > 0) return fail(errors);
  if (outputTy === null) return typeError(`${isFold ? "fold" : "case"}: no branches`, sourceId, "E_NO_BRANCHES");

  const finalOutput = applySubst(outputTy, subst, effSubst);

  // Apply the final substitution to all branch payload types and handler bodies.
  // Fold branches contain TyVar(carrierVar) in payload types until subst is resolved.
  const finalBranches = typedBranches.map((b) => ({
    ctor:         b.ctor,
    rawPayloadTy: b.rawPayloadTy,  // concrete: instantiated from typeArgs, no carrier TyVar
    payloadTy:    applySubst(b.payloadTy, subst, effSubst),
    handler:      substTypedHandler(b.handler, subst, effSubst),
  }));

  if (isFold) {
    const carrierTy = carrierVar !== null
      ? applySubst({ tag: "TyVar", name: carrierVar }, subst, effSubst)
      : finalOutput;
    return ok(makeStep(
      { tag: "Fold", adtTy: inputTy, carrierTy, branches: finalBranches },
      { input: inputTy, output: finalOutput, eff: overallEff },
      sourceId,
    ));
  }

  return ok(makeStep(
    { tag: "Case", branches: finalBranches },
    { input: inputTy, output: finalOutput, eff: overallEff },
    sourceId,
  ));
}

// ---------------------------------------------------------------------------
// case .field — field-focused coproduct elimination
// ---------------------------------------------------------------------------

function checkCaseField(
  field: string,
  branches: Branch[],
  inputTy: Type,
  env: CheckEnv,
  sourceId: SourceNodeId,
): TypeResult<TypedStep> {
  if (inputTy.tag !== "Record") {
    return typeError(`case .${field}: input must be a record type, got ${showType(inputTy)}`, sourceId, "E_NOT_RECORD");
  }

  const kField = inputTy.fields.find((f) => f.name === field);
  if (!kField) {
    return typeError(`case .${field}: no field '${field}' in ${showType(inputTy)}`, sourceId, "E_UNKNOWN_FIELD");
  }

  // ρ = input record minus field k (preserve the row tail per spec §case .field)
  const contextTy: Type = { tag: "Record", fields: inputTy.fields.filter((f) => f.name !== field), rest: inputTy.rest };

  // Bool is a builtin primitive but semantically a variant True | False
  const boolCtors = [
    { ctorName: "True",  adtName: "Bool", adtParams: [] as string[], payloadTy: null as Type | null },
    { ctorName: "False", adtName: "Bool", adtParams: [] as string[], payloadTy: null as Type | null },
  ];
  const variantInfo = kField.ty.tag === "Bool"
    ? ok({ info: { name: "Bool", params: [] as string[], isRecursive: false, sourceId, body: { tag: "Variant" as const, ctors: boolCtors } }, typeArgs: new Map<string, Type>() })
    : resolveVariant(kField.ty, env.typeDecls, sourceId);
  if (!variantInfo.ok) {
    return typeError(`case .${field}: field '${field}' must be a variant type, got ${showType(kField.ty)}`, sourceId, "E_NOT_VARIANT");
  }
  const { info, typeArgs } = variantInfo.value;

  if (info.body.tag !== "Variant") {
    return typeError(`case .${field}: field type must be a variant`, sourceId, "E_NOT_VARIANT");
  }

  const ctorNames  = new Set(info.body.ctors.map((c) => c.ctorName));
  const branchCtors = new Set(branches.map((b) => b.ctor));
  const errors: TypeError[] = [];
  for (const name of ctorNames)  { if (!branchCtors.has(name)) errors.push({ code: "E_MISSING_BRANCH", message: `case .${field}: missing branch for '${name}'`, sourceId }); }
  for (const name of branchCtors) { if (!ctorNames.has(name))  errors.push({ code: "E_UNKNOWN_BRANCH", message: `case .${field}: unknown constructor '${name}'`, sourceId }); }
  if (errors.length > 0) return fail(errors);

  const typedBranches: TypedBranch[] = [];
  let overallEff: ConcreteEffect = "pure";
  let outputTy: Type | null = null;
  let subst: Subst = new Map();
  let effSubst: EffSubst = new Map();

  for (const branch of branches) {
    const ctorInfo = findCtor(info.body.ctors, branch.ctor);
    if (!ctorInfo) continue;

    const rawPi = instantiatePayload(ctorInfo, typeArgs);
    const piTy: Type = rawPi ?? { tag: "Unit" };

    let branchInputTy: Type;
    if (piTy.tag === "Unit") {
      branchInputTy = contextTy;
    } else {
      if (piTy.tag !== "Record") {
        errors.push({ code: "E_NOT_RECORD", message: `case .${field}: constructor '${branch.ctor}' has non-record payload ${showType(piTy)}`, sourceId });
        continue;
      }
      // Check field disjointness: fields(Pi) ∩ fields(ρ) = ∅
      const piFieldNames = new Set(piTy.fields.map((f) => f.name));
      for (const rhoF of contextTy.fields) {
        if (piFieldNames.has(rhoF.name)) {
          errors.push({ code: "E_FIELD_COLLISION", message: `case .${field}: payload field '${rhoF.name}' of '${branch.ctor}' collides with context row`, sourceId });
        }
      }
      branchInputTy = { tag: "Record", fields: [...piTy.fields, ...contextTy.fields], rest: contextTy.rest };
    }

    const handlerR = checkCaseFieldHandler(branch.handler, branchInputTy, contextTy, env, sourceId);
    if (!handlerR.ok) { errors.push(...handlerR.errors); continue; }
    const { typedHandler, outputTy: branchOut, eff: branchEff } = handlerR.value;

    overallEff = effectJoin(overallEff, branchEff);

    if (outputTy === null) {
      outputTy = branchOut;
    } else {
      const uR = unify(outputTy, branchOut, subst, effSubst);
      if (!uR.ok) {
        errors.push({ code: "E_BRANCH_TYPE_MISMATCH", message: `case .${field} branch '${branch.ctor}': output type ${showType(branchOut)} is incompatible with prior branches (${showType(outputTy)})`, sourceId });
        continue;
      }
      subst = uR.subst; effSubst = uR.effSubst;
      outputTy = applySubst(outputTy, subst, effSubst);
    }

    typedBranches.push({ ctor: branch.ctor, rawPayloadTy: piTy, payloadTy: branchInputTy, handler: typedHandler });
  }

  if (errors.length > 0) return fail(errors);
  if (outputTy === null) return typeError(`case .${field}: no branches`, sourceId, "E_NO_BRANCHES");

  const finalOutput = applySubst(outputTy, subst, effSubst);
  const finalContextTy = applySubst(contextTy, subst, effSubst);
  const finalBranches = typedBranches.map((b) => ({
    ctor:         b.ctor,
    rawPayloadTy: applySubst(b.rawPayloadTy, subst, effSubst),
    payloadTy:    applySubst(b.payloadTy, subst, effSubst),
    handler:      substTypedHandler(b.handler, subst, effSubst),
  }));

  return ok(makeStep(
    { tag: "CaseField", field, contextTy: finalContextTy, branches: finalBranches },
    { input: inputTy, output: finalOutput, eff: overallEff },
    sourceId,
  ));
}

function checkCaseFieldHandler(
  handler: Handler,
  branchInputTy: Type,
  contextTy: Type,
  env: CheckEnv,
  sourceId: SourceNodeId,
): TypeResult<{ typedHandler: TypedHandler; outputTy: Type; eff: ConcreteEffect }> {
  // ρ fields are always auto-available in branch handlers (spec §10a)
  const rhoEntries = contextTy.tag === "Record"
    ? contextTy.fields.map((f) => ({ name: f.name, ty: f.ty }))
    : [];

  if (handler.tag === "NullaryHandler") {
    // Branch input type = ρ; Γ_local auto-populated from ρ fields
    const handlerEnv = withLocals(env, extendLocalMany(emptyLocal, rhoEntries), branchInputTy);
    const bodyR = checkExpr(handler.body, branchInputTy, handlerEnv);
    if (!bodyR.ok) return bodyR;
    return ok({ typedHandler: { tag: "Nullary", body: bodyR.value }, outputTy: bodyR.value.morphTy.output, eff: bodyR.value.morphTy.eff });
  }

  // Record handler: { binders } >>> body with branchInputTy = merge(Pi, ρ)
  if (branchInputTy.tag !== "Record") {
    return typeError(`case .field: record handler expects a record branch input, got ${showType(branchInputTy)}`, handler.meta.id, "E_NOT_RECORD");
  }
  const payloadFields = new Map(branchInputTy.fields.map((f) => [f.name, f.ty]));

  const typedBinders: TypedBinder[] = [];
  const errors: TypeError[] = [];
  const piEntries: { name: string; ty: Type }[] = [];

  for (const binder of handler.binders) {
    const fieldTy = payloadFields.get(binder.name);
    if (fieldTy === undefined) {
      errors.push({ code: "E_UNKNOWN_FIELD", message: `Field '${binder.name}' not found in branch input type ${showType(branchInputTy)}`, sourceId: handler.meta.id });
      continue;
    }
    if (binder.tag === "Bind") {
      typedBinders.push({ name: binder.name, fieldTy });
      piEntries.push({ name: binder.name, ty: fieldTy });
    }
  }
  if (errors.length > 0) return fail(errors);

  // Γ_local = Pi binders ∪ all ρ fields
  const handlerEnv = withLocals(env, extendLocalMany(emptyLocal, [...piEntries, ...rhoEntries]), branchInputTy);
  const bodyR = checkExpr(handler.body, branchInputTy, handlerEnv);
  if (!bodyR.ok) return bodyR;

  return ok({
    typedHandler: { tag: "Record", binders: typedBinders, body: bodyR.value },
    outputTy: bodyR.value.morphTy.output,
    eff: bodyR.value.morphTy.eff,
  });
}

function checkHandler(
  handler: Handler, payloadTy: Type, env: CheckEnv, sourceId: SourceNodeId,
): TypeResult<{ typedHandler: TypedHandler; outputTy: Type; eff: ConcreteEffect }> {
  if (handler.tag === "NullaryHandler") {
    // Branch input type is determined by the constructor's payload (spec §10):
    // nullary constructor → payloadTy = Unit; record-payload constructor → payloadTy = Pi.
    // No field bindings are introduced; the body receives payloadTy as its input.
    const handlerEnv = withFreshLocals(env, payloadTy);
    const bodyR = checkExpr(handler.body, payloadTy, handlerEnv);
    if (!bodyR.ok) return bodyR;
    return ok({
      typedHandler: { tag: "Nullary", body: bodyR.value },
      outputTy: bodyR.value.morphTy.output,
      eff: bodyR.value.morphTy.eff,
    });
  }

  // Record handler: { binders } >>> body
  // payloadTy must be a record
  if (payloadTy.tag !== "Record") {
    return typeError(`Record handler expects a record payload, got ${showType(payloadTy)}`, handler.meta.id, "E_NOT_RECORD");
  }
  const payloadFields = new Map(payloadTy.fields.map((f) => [f.name, f.ty]));

  // Validate binders and build fresh Γ_local for handler body
  const typedBinders: TypedBinder[] = [];
  const errors: TypeError[] = [];
  const localEntries: { name: string; ty: Type }[] = [];

  for (const binder of handler.binders) {
    const fieldTy = payloadFields.get(binder.name);
    if (fieldTy === undefined) {
      errors.push({ code: "E_UNKNOWN_FIELD", message: `Field '${binder.name}' not found in payload type ${showType(payloadTy)}`, sourceId: handler.meta.id });
      continue;
    }
    if (binder.tag === "Bind") {
      typedBinders.push({ name: binder.name, fieldTy });
      localEntries.push({ name: binder.name, ty: fieldTy });
    }
    // Wildcard: verify field exists (done above), introduce no binding
  }
  if (errors.length > 0) return fail(errors);

  // Handler body env: fresh locals from payload fields, input = payloadTy
  const handlerEnv = withLocals(env, extendLocalMany(emptyLocal, localEntries), payloadTy);
  const bodyR = checkExpr(handler.body, payloadTy, handlerEnv);
  if (!bodyR.ok) return bodyR;

  return ok({
    typedHandler: { tag: "Record", binders: typedBinders, body: bodyR.value },
    outputTy: bodyR.value.morphTy.output,
    eff: bodyR.value.morphTy.eff,
  });
}

// ---------------------------------------------------------------------------
// Over
// ---------------------------------------------------------------------------

function checkOver(
  field: string, transform: Step, inputTy: Type, env: CheckEnv, sourceId: SourceNodeId,
): TypeResult<TypedStep> {
  // Input must be a record containing field `field`
  const fieldTyR = lookupField(inputTy, field, env);
  if (!fieldTyR.ok) {
    return typeError(`over .${field}: ${fieldTyR.message}`, sourceId, "E_UNKNOWN_FIELD");
  }
  const fieldTy = fieldTyR.ty;

  // Handler is elaborated with input type = fieldTy (handler context discipline P4)
  const handlerEnv = withFreshLocals(env, fieldTy);
  const transformR = checkStep(transform, fieldTy, handlerEnv);
  if (!transformR.ok) return transformR;
  const typedTransform = transformR.value;
  const newFieldTy = typedTransform.morphTy.output;
  const eff = typedTransform.morphTy.eff;

  // Output type: same record but with `field` replaced by newFieldTy.
  // Named record aliases are unfolded, so the output is always an explicit Record.
  const outputTy = replaceField(inputTy, field, newFieldTy, env);

  return ok(makeStep(
    { tag: "Over", field, transform: typedTransform },
    { input: inputTy, output: outputTy, eff },
    sourceId,
  ));
}

// ---------------------------------------------------------------------------
// Let
// ---------------------------------------------------------------------------

function checkLet(
  name: string, rhs: Expr, body: Expr,
  inputTy: Type, env: CheckEnv, sourceId: SourceNodeId,
): TypeResult<TypedStep> {
  // Validate: let is only valid inside Γ_local scope
  if (env.locals.size === 0) {
    return typeError(
      `let '${name}': let is only valid inside a { fields } >>> destructor scope or another let`,
      sourceId,
      "E_LET_INVALID_SCOPE",
    );
  }

  // Check rhs with norm_I (must have domain inputTy or 1)
  const rhsR = normI(rhs, inputTy, env);
  if (!rhsR.ok) return rhsR;
  const typedRhs = rhsR.value;
  const rhsTy = typedRhs.morphTy.output;

  // Compute live set: Γ_local names free in body, excluding `name`
  const bodyFreeNames = collectFreeLocalNames(body, env.locals);
  const liveSet: LiveVar[] = bodyFreeNames
    .filter((n) => n !== name)
    .map((n) => ({ name: n, ty: env.locals.get(n)! }));

  // New Γ_local for body: {name → rhsTy} ∪ live set
  const bodyLocalEntries: { name: string; ty: Type }[] = [
    { name, ty: rhsTy },
    ...liveSet,
  ];
  // New input type for body: the intermediate record { name: rhsTy, v1: T1, ... }
  const bodyInputTy: Type = {
    tag: "Record",
    fields: bodyLocalEntries.map((e) => ({ name: e.name, ty: e.ty })),
    rest: null,
  };
  const bodyEnv = withLocals(env, extendLocalMany(emptyLocal, bodyLocalEntries), bodyInputTy);

  const bodyR = checkExpr(body, bodyInputTy, bodyEnv);
  if (!bodyR.ok) return bodyR;
  const typedBody = bodyR.value;

  // Duplication constraint: if rhs effect > pure, name may be used at most once
  const rhsEff = typedRhs.morphTy.eff;
  if (rhsEff !== "pure") {
    const useCount = countLocalUses(name, typedBody);
    if (useCount > 1) {
      return typeError(
        `let '${name}': binding is used ${useCount} times but its RHS has effect '${rhsEff}'. A non-pure let binding may be used at most once.`,
        sourceId,
        "E_LET_DUPLICATE_USE",
      );
    }
  }

  const eff = effectJoin(rhsEff, typedBody.morphTy.eff);

  return ok(makeStep(
    { tag: "Let", name, rhs: typedRhs, body: typedBody, liveSet },
    { input: inputTy, output: typedBody.morphTy.output, eff },
    sourceId,
  ));
}

/** Collect Γ_local names referenced in an expression (surface level). */
function collectFreeLocalNames(expr: Expr, locals: LocalEnv): string[] {
  const found = new Set<string>();

  function visitExpr(e: Expr, loc: LocalEnv): void {
    e.steps.forEach((s) => visitStep(s, loc));
  }

  function visitStep(step: Step, loc: LocalEnv): void {
    if (step.tag === "Name" && loc.has(step.name)) found.add(step.name);
    if (step.tag === "Build")   step.fields.forEach((f) => visitExpr(f.expr, loc));
    if (step.tag === "Fanout")  step.fields.forEach((f) => {
      if (f.tag === "Field") visitExpr(f.expr, loc);
      // Shorthand `name` in fanout is sugar for `name: name` — it references a local
      else if (loc.has(f.name)) found.add(f.name);
    });
    if (step.tag === "Let")     { visitExpr(step.rhs, loc); visitExpr(step.body, loc); }
    if (step.tag === "Over")    visitStep(step.transform, loc);
    if (step.tag === "Case" || step.tag === "Fold")
      step.branches.forEach((b) => visitHandler(b.handler, loc));
    if (step.tag === "Infix")   { visitStep(step.left, loc); visitStep(step.right, loc); }
    if (step.tag === "SchemaInst") step.args.forEach((a) => visitExpr(a.expr, loc));
  }

  function visitHandler(h: Handler, loc: LocalEnv): void {
    if (h.tag === "NullaryHandler") {
      visitExpr(h.body, loc);
    } else {
      // Record handler: Bind binders shadow outer locals within the handler body.
      // Wildcard binders do not introduce a binding, so they do not shadow.
      const restricted = new Map(loc);
      for (const b of h.binders) {
        if (b.tag === "Bind") restricted.delete(b.name);
      }
      visitExpr(h.body, restricted);
    }
  }

  visitExpr(expr, locals);
  return [...found];
}

/** Count how many times a name is used as LocalRef in a TypedExpr. */
function countLocalUses(name: string, expr: TypedExpr): number {
  let count = 0;
  const visitStep = (step: TypedStep) => {
    if (step.node.tag === "LocalRef" && step.node.name === name) count++;
    visitNode(step.node);
  };
  const visitNode = (node: TypedNode) => {
    switch (node.tag) {
      case "Build":   node.fields.forEach((f) => visitTypedExpr(f.expr)); break;
      case "Fanout":  node.fields.forEach((f) => visitTypedExpr(f.expr)); break;
      case "Case":      node.branches.forEach((b) => visitTypedHandler(b.handler)); break;
      case "CaseField": node.branches.forEach((b) => visitTypedHandler(b.handler)); break;
      case "Fold":      node.branches.forEach((b) => visitTypedHandler(b.handler)); break;
      case "Over":         visitStep(node.transform); break;
      case "GroupedExpr":  visitTypedExpr(node.body); break;
      case "Let":          visitTypedExpr(node.rhs); visitTypedExpr(node.body); break;
      case "SchemaInst":   [...node.argSubst.values()].forEach(visitTypedExpr); break;
      default: break;
    }
  };
  const visitTypedExpr = (e: TypedExpr) => e.steps.forEach(visitStep);
  const visitTypedHandler = (h: TypedHandler) => {
    if (h.tag === "Nullary") visitTypedExpr(h.body);
    else visitTypedExpr(h.body);
  };
  visitTypedExpr(expr);
  return count;
}

// ---------------------------------------------------------------------------
// Perform
// ---------------------------------------------------------------------------

function checkPerform(
  op: string[], inputTy: Type, env: CheckEnv, sourceId: SourceNodeId,
): TypeResult<TypedStep> {
  const qualName = op.join(".");
  const entry = env.omega.get(qualName);
  if (!entry) {
    return typeError(`Unknown effect operation '${qualName}'`, sourceId, "E_UNKNOWN_EFFECT");
  }
  // Input must unify with operation's declared input type.
  // uR.subst is intentionally not threaded: effect op types are always concrete
  // (resolved with empty tyVarNames), so the substitution is always empty.
  const uR = unify(entry.inputTy, inputTy);
  if (!uR.ok) {
    return typeError(
      `perform ${qualName}: expected input ${showType(entry.inputTy)}, got ${showType(inputTy)}: ${uR.message}`,
      sourceId,
      "E_TYPE_MISMATCH",
    );
  }
  return ok(makeStep(
    { tag: "Perform", op: entry.qualifiedName },
    { input: inputTy, output: entry.outputTy, eff: entry.eff },
    sourceId,
  ));
}

// ---------------------------------------------------------------------------
// Schema instantiation
// ---------------------------------------------------------------------------

function checkSchemaInst(
  defName: string, args: SchemaArg[], inputTy: Type, env: CheckEnv, sourceId: SourceNodeId,
): TypeResult<TypedStep> {
  const defInfo = env.globals.defs.get(defName);
  if (!defInfo) return typeError(`Unknown def '${defName}'`, sourceId, "E_UNKNOWN_DEF");
  if (defInfo.params.length === 0) {
    return typeError(`'${defName}' is not a higher-order def (no parameters)`, sourceId, "E_NOT_SCHEMA");
  }

  // Match args by name, all-or-nothing
  const argMap = new Map(args.map((a) => [a.name, a]));
  const errors: TypeError[] = [];
  for (const param of defInfo.params) {
    if (!argMap.has(param.name)) {
      errors.push({ code: "E_SCHEMA_MISSING_ARG", message: `Schema instantiation of '${defName}': missing argument '${param.name}'`, sourceId });
    }
  }
  for (const arg of args) {
    if (!defInfo.params.find((p) => p.name === arg.name)) {
      errors.push({ code: "E_SCHEMA_UNKNOWN_ARG", message: `Schema instantiation of '${defName}': unknown argument '${arg.name}'`, sourceId });
    }
  }
  if (errors.length > 0) return fail(errors);

  // Freshen the def's type variables
  const { morphTy: freshMorphTy, params: freshParams, subst: freshSubst, effSubst: freshEffSubst } = freshenDefFull(defInfo);

  // Check each argument against the (freshened) parameter type
  let subst: Subst = freshSubst;
  let effSubst: EffSubst = freshEffSubst;
  const argSubst = new Map<string, TypedExpr>();

  for (const param of freshParams) {
    const arg = argMap.get(param.name)!;
    // Check the argument as a standalone morphism against the parameter's input type.
    // Schema args must not capture caller locals (they are morphisms, not closures).
    const paramInputTy = applySubst(param.morphTy.input, subst, effSubst);
    const argR = checkExpr(arg.expr, paramInputTy, { ...env, locals: new Map() });
    if (!argR.ok) { errors.push(...argR.errors); continue; }
    const typedArg = argR.value;

    // Unify argument morphism type with parameter type
    const paramInput  = applySubst(param.morphTy.input,  subst, effSubst);
    const paramOutput = applySubst(param.morphTy.output, subst, effSubst);
    const uIn = unify(paramInput, typedArg.morphTy.input, subst, effSubst);
    if (!uIn.ok) {
      errors.push({ code: "E_TYPE_MISMATCH", message: `Argument '${param.name}': input type mismatch: expected ${showType(paramInput)}, got ${showType(typedArg.morphTy.input)}`, sourceId: arg.meta.id });
      continue;
    }
    subst = uIn.subst; effSubst = uIn.effSubst;
    const expectedOut = applySubst(paramOutput, subst, effSubst);
    const uOut = unify(expectedOut, typedArg.morphTy.output, subst, effSubst);
    if (!uOut.ok) {
      errors.push({ code: "E_TYPE_MISMATCH", message: `Argument '${param.name}': output type mismatch: expected ${showType(expectedOut)}, got ${showType(typedArg.morphTy.output)}`, sourceId: arg.meta.id });
      continue;
    }
    subst = uOut.subst; effSubst = uOut.effSubst;
    // Effect compatibility for schema arguments uses subsumption, not equality:
    // a purer argument satisfies a less-pure parameter (pure ⊑ sequential).
    // When EffVars are involved, fall back to unifyEffect for binding.
    const paramEff = applyEffSubst(param.morphTy.eff, effSubst);
    const argEff   = typedArg.morphTy.eff;
    if (typeof paramEff === "string" && typeof argEff === "string") {
      if (effectRank(argEff) > effectRank(paramEff)) {
        errors.push({ code: "E_EFFECT_MISMATCH", message: `Argument '${param.name}': effect mismatch: expected ${showEffect(paramEff)}, got ${showEffect(argEff)}`, sourceId: arg.meta.id });
        continue;
      }
      // Subsumption holds; no EffVar to bind.
    } else {
      const uEff = unifyEffect(paramEff, argEff, effSubst);
      if (!uEff.ok) {
        errors.push({ code: "E_EFFECT_MISMATCH", message: `Argument '${param.name}': effect mismatch: expected ${showEffect(paramEff)}, got ${showEffect(argEff)}`, sourceId: arg.meta.id });
        continue;
      }
      effSubst = uEff.effSubst;
    }
    argSubst.set(param.name, typedArg);
  }
  if (errors.length > 0) return fail(errors);

  // Apply substitution to the def's morphism type
  const resolvedInput  = applySubst(freshMorphTy.input,  subst, effSubst);
  const resolvedOutput = applySubst(freshMorphTy.output, subst, effSubst);
  // The declared effect is the public upper-bound contract, not the instantiated effect.
  const declaredEff = resolveEffFinal(applyEffSubst(freshMorphTy.eff, effSubst));

  // Unify the resolved input with the current inputTy
  const uIn = unify(resolvedInput, inputTy, subst, effSubst);
  if (!uIn.ok) {
    return typeError(`Schema instantiation of '${defName}': input type mismatch: ${uIn.message}`, sourceId, "E_TYPE_MISMATCH");
  }
  const finalSubst = uIn.subst;
  const finalEffSubst = uIn.effSubst;
  const finalOutput = applySubst(resolvedOutput, finalSubst, finalEffSubst);

  // Compute the precise instantiated effect (spec §2.2: re-derive after substitution).
  //   instantiatedEff = intrinsicBodyEff ⊔ join(argEffects)
  // where intrinsicBodyEff is the def body's effect with param refs treated as pure.
  // Then verify it does not exceed the declaration's promised upper bound.
  const argEff = [...argSubst.values()].reduce<ConcreteEffect>(
    (acc, typedArg) => effectJoin(acc, typedArg.morphTy.eff),
    "pure",
  );
  const instantiatedEff = effectJoin(defInfo.intrinsicEff, argEff);
  if (effectRank(instantiatedEff) > effectRank(declaredEff)) {
    return typeError(
      `Schema instantiation of '${defName}': instantiated effect '${instantiatedEff}' exceeds declared effect '${declaredEff}'`,
      sourceId,
      "E_EFFECT_MISMATCH",
    );
  }

  // Build concrete tySubst and effSubst for the elaborator
  const tySubstForElab = new Map<string, Type>();
  for (const [k, v] of finalSubst) {
    tySubstForElab.set(k, applySubst(v, finalSubst, finalEffSubst));
  }
  const effSubstForElab = new Map<string, ConcreteEffect>(finalEffSubst);

  return ok(makeStep(
    { tag: "SchemaInst", defName: defInfo.name, tySubst: tySubstForElab, effSubst: effSubstForElab, argSubst },
    { input: inputTy, output: finalOutput, eff: instantiatedEff },
    sourceId,
  ));
}

// ---------------------------------------------------------------------------
// Infix desugaring — called directly from checkExpr's step loop
// ---------------------------------------------------------------------------

function handleInfix(
  op: string, left: Step, right: Step, inputTy: Type, env: CheckEnv, sourceId: SourceNodeId,
): TypeResult<{ fanoutStep: TypedStep; refStep: TypedStep }> {
  const entry = lookupInfixOp(op);
  if (!entry) {
    return typeError(
      `Unknown infix operator '${op}'. Builtin operators: ${BUILTIN_OPS.join(", ")}`,
      sourceId,
      "E_UNDEFINED_NAME",
    );
  }

  const dspan = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
  const leftExpr:  Expr = { tag: "Pipeline", steps: [left],  meta: { id: sourceId, span: dspan } };
  const rightExpr: Expr = { tag: "Pipeline", steps: [right], meta: { id: sourceId, span: dspan } };

  const leftR  = normI(leftExpr,  inputTy, env);
  if (!leftR.ok)  return leftR;
  const rightR = normI(rightExpr, inputTy, env);
  if (!rightR.ok) return rightR;

  const leftTy  = leftR.value.morphTy.output;
  const rightTy = rightR.value.morphTy.output;

  const uR = unify(leftTy, rightTy);
  if (!uR.ok) {
    return typeError(
      `Operator '${op}': operand types ${showType(leftTy)} and ${showType(rightTy)} do not unify: ${uR.message}`,
      sourceId,
      "E_TYPE_MISMATCH",
    );
  }
  const operandTy = applySubst(leftTy, uR.subst, uR.effSubst);

  const sig = entry.signature(operandTy);
  if (!sig) {
    return typeError(`Operator '${op}' cannot be applied to type ${showType(operandTy)}`, sourceId, "E_TYPE_MISMATCH");
  }

  const fanoutFields: TypedFanoutField[] = [
    { name: "l", expr: leftR.value },
    { name: "r", expr: rightR.value },
  ];
  const fanoutEff = effectJoin(leftR.value.morphTy.eff, rightR.value.morphTy.eff);
  const fanoutStep = makeStep(
    { tag: "Fanout", fields: fanoutFields },
    { input: inputTy, output: sig.inputTy, eff: fanoutEff },
    sourceId,
  );
  const refStep = makeStep(
    { tag: "Ref", defId: entry.morphismName },
    { input: sig.inputTy, output: sig.outputTy, eff: "pure" },
    sourceId,
  );

  return ok({ fanoutStep, refStep });
}

// ---------------------------------------------------------------------------
// Typed-AST substitution (used to apply final subst to fold/case branches)
// ---------------------------------------------------------------------------

function substMorphTy(mt: MorphTy, subst: Subst, effSubst: EffSubst): MorphTy {
  return {
    input:  applySubst(mt.input,  subst, effSubst),
    output: applySubst(mt.output, subst, effSubst),
    eff:    mt.eff,
  };
}

function substTypedExpr(expr: TypedExpr, subst: Subst, effSubst: EffSubst): TypedExpr {
  return {
    steps:    expr.steps.map((s) => substTypedStep(s, subst, effSubst)),
    morphTy:  substMorphTy(expr.morphTy, subst, effSubst),
    sourceId: expr.sourceId,
  };
}

function substTypedStep(step: TypedStep, subst: Subst, effSubst: EffSubst): TypedStep {
  return {
    node:     substTypedNode(step.node, subst, effSubst),
    morphTy:  substMorphTy(step.morphTy, subst, effSubst),
    sourceId: step.sourceId,
  };
}

function substTypedHandler(handler: TypedHandler, subst: Subst, effSubst: EffSubst): TypedHandler {
  if (handler.tag === "Nullary") {
    return { tag: "Nullary", body: substTypedExpr(handler.body, subst, effSubst) };
  }
  return {
    tag:     "Record",
    binders: handler.binders.map((b) => ({ name: b.name, fieldTy: applySubst(b.fieldTy, subst, effSubst) })),
    body:    substTypedExpr(handler.body, subst, effSubst),
  };
}

function substTypedNode(node: TypedNode, subst: Subst, effSubst: EffSubst): TypedNode {
  switch (node.tag) {
    case "Ref": case "LocalRef": case "Ctor": case "Projection": case "Literal": case "Perform":
      return node;
    case "Fanout":
      return { tag: "Fanout", fields: node.fields.map((f) => ({ name: f.name, expr: substTypedExpr(f.expr, subst, effSubst) })) };
    case "Build":
      return { tag: "Build", fields: node.fields.map((f) => ({ name: f.name, expr: substTypedExpr(f.expr, subst, effSubst) })) };
    case "Case":
      return {
        tag: "Case",
        branches: node.branches.map((b) => ({
          ctor:         b.ctor,
          rawPayloadTy: applySubst(b.rawPayloadTy, subst, effSubst),
          payloadTy:    applySubst(b.payloadTy, subst, effSubst),
          handler:      substTypedHandler(b.handler, subst, effSubst),
        })),
      };
    case "CaseField":
      return {
        tag:       "CaseField",
        field:     node.field,
        contextTy: applySubst(node.contextTy, subst, effSubst),
        branches:  node.branches.map((b) => ({
          ctor:         b.ctor,
          rawPayloadTy: applySubst(b.rawPayloadTy, subst, effSubst),
          payloadTy:    applySubst(b.payloadTy, subst, effSubst),
          handler:      substTypedHandler(b.handler, subst, effSubst),
        })),
      };
    case "Fold":
      return {
        tag:       "Fold",
        adtTy:     applySubst(node.adtTy,     subst, effSubst),
        carrierTy: applySubst(node.carrierTy, subst, effSubst),
        branches:  node.branches.map((b) => ({
          ctor:         b.ctor,
          rawPayloadTy: applySubst(b.rawPayloadTy, subst, effSubst),
          payloadTy:    applySubst(b.payloadTy, subst, effSubst),
          handler:      substTypedHandler(b.handler, subst, effSubst),
        })),
      };
    case "Over":
      return { tag: "Over", field: node.field, transform: substTypedStep(node.transform, subst, effSubst) };
    case "GroupedExpr":
      return { tag: "GroupedExpr", body: substTypedExpr(node.body, subst, effSubst) };
    case "Let":
      return {
        tag:     "Let",
        name:    node.name,
        rhs:     substTypedExpr(node.rhs,  subst, effSubst),
        body:    substTypedExpr(node.body, subst, effSubst),
        liveSet: node.liveSet.map((lv) => ({ name: lv.name, ty: applySubst(lv.ty, subst, effSubst) })),
      };
    case "SchemaInst": {
      const newArgSubst = new Map<string, TypedExpr>();
      for (const [k, v] of node.argSubst) newArgSubst.set(k, substTypedExpr(v, subst, effSubst));
      const newTySubst = new Map<string, Type>();
      for (const [k, v] of node.tySubst) newTySubst.set(k, applySubst(v, subst, effSubst));
      return { tag: "SchemaInst", defName: node.defName, tySubst: newTySubst, effSubst: node.effSubst, argSubst: newArgSubst };
    }
  }
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

let _tyVarCounter = 0;
function freshTyVar(): string {
  return `_t${++_tyVarCounter}`;
}

function makeStep(node: TypedNode, morphTy: MorphTy, sourceId: SourceNodeId): TypedStep {
  return { node, morphTy, sourceId };
}

function singleNameExpr(name: string, sourceId: SourceNodeId): Expr {
  return {
    tag: "Pipeline",
    steps: [{ tag: "Name", name, meta: { id: sourceId, span: { start: { line:0,column:0}, end:{line:0,column:0}} } }],
    meta: { id: sourceId, span: { start: { line:0,column:0}, end:{line:0,column:0}} },
  };
}

type FieldLookupResult = { ok: true; ty: Type } | { ok: false; message: string };

/**
 * Unfold a Named type whose declaration has a Record body.
 * Returns null if the type is not an unfoldable Named-Record alias.
 */
function unfoldNamedRecord(ty: Type, env: CheckEnv): { tag: "Record"; fields: { name: string; ty: Type }[]; rest: string | null } | null {
  if (ty.tag !== "Named") return null;
  const decl = env.typeDecls.get(ty.name);
  if (!decl || decl.body.tag !== "Record") return null;
  const fields = decl.body.fields.map((f) => {
    let fty = f.ty;
    for (let i = 0; i < decl.params.length; i++) {
      fty = substTyVar(fty, decl.params[i]!, ty.args[i] ?? { tag: "TyVar", name: decl.params[i]! });
    }
    return { name: f.name, ty: fty };
  });
  return { tag: "Record", fields, rest: null };
}

function lookupField(ty: Type, field: string, env: CheckEnv): FieldLookupResult {
  const rec = ty.tag === "Record" ? ty : unfoldNamedRecord(ty, env);
  if (!rec) return { ok: false, message: `Expected record type, got ${showType(ty)}` };
  const f = rec.fields.find((f) => f.name === field);
  if (!f) return { ok: false, message: `No field '${field}' in ${showType(ty)}` };
  return { ok: true, ty: f.ty };
}

function replaceField(ty: Type, field: string, newTy: Type, env?: CheckEnv): Type {
  const rec = ty.tag === "Record" ? ty : (env ? unfoldNamedRecord(ty, env) : null);
  if (!rec) return ty;
  return {
    tag: "Record",
    fields: rec.fields.map((f) => f.name === field ? { name: f.name, ty: newTy } : f),
    rest: rec.rest,
  };
}

function literalType(lit: SurfaceLiteral): Type {
  switch (lit.tag) {
    case "int":   return TInt;
    case "float": return TFloat;
    case "text":  return TText;
    case "bool":  return TBool;
  }
}

function effectRank(eff: ConcreteEffect): number {
  return eff === "pure" ? 0 : eff === "parallel-safe" ? 1 : 2;
}

function resolveEffFinal(eff: EffectLevel): ConcreteEffect {
  if (typeof eff === "string") return eff;
  return "pure"; // Unresolved EffVar defaults to pure (conservative for checking)
}

// ---------------------------------------------------------------------------
// Intrinsic effect computation
// ---------------------------------------------------------------------------

/**
 * Compute the "intrinsic" body effect: the effect of a typed expression with
 * all Ref nodes to schema parameter names treated as pure. This isolates the
 * effect contribution of the def body itself from the effect of supplied args.
 *
 * Used by checkSchemaInst to derive the precise instantiated effect:
 *   instantiatedEff = effectJoin(intrinsicEff, join of arg effects)
 */
function computeBodyIntrinsicEffect(body: TypedExpr, paramNames: Set<string>, defs: Map<string, DefInfo>): ConcreteEffect {
  return body.steps.reduce(
    (acc, step) => effectJoin(acc, intrinsicStepEff(step, paramNames, defs)),
    "pure" as ConcreteEffect,
  );
}

function intrinsicStepEff(step: TypedStep, paramNames: Set<string>, defs: Map<string, DefInfo>): ConcreteEffect {
  const node = step.node;
  switch (node.tag) {
    case "Ref":
      // Schema-param refs are treated as pure; ordinary global refs keep their effect.
      return paramNames.has(node.defId) ? "pure" : step.morphTy.eff;
    case "LocalRef":
    case "Ctor":
    case "Projection":
    case "Literal":
      return "pure";
    case "Perform":
      return step.morphTy.eff;
    case "Fanout":
      return node.fields.reduce(
        (acc, f) => effectJoin(acc, computeBodyIntrinsicEffect(f.expr, paramNames, defs)),
        "pure" as ConcreteEffect,
      );
    case "Build":
      return node.fields.reduce(
        (acc, f) => effectJoin(acc, computeBodyIntrinsicEffect(f.expr, paramNames, defs)),
        "pure" as ConcreteEffect,
      );
    case "Case":
    case "CaseField":
      return node.branches.reduce(
        (acc, b) => effectJoin(acc, computeBodyIntrinsicEffect(b.handler.body, paramNames, defs)),
        "pure" as ConcreteEffect,
      );
    case "Fold":
      return node.branches.reduce(
        (acc, b) => effectJoin(acc, computeBodyIntrinsicEffect(b.handler.body, paramNames, defs)),
        "pure" as ConcreteEffect,
      );
    case "Over":
      return intrinsicStepEff(node.transform, paramNames, defs);
    case "Let":
      return effectJoin(
        computeBodyIntrinsicEffect(node.rhs,  paramNames, defs),
        computeBodyIntrinsicEffect(node.body, paramNames, defs),
      );
    case "GroupedExpr":
      return computeBodyIntrinsicEffect(node.body, paramNames, defs);
    case "SchemaInst": {
      // Re-derive the nested instantiation's intrinsic effect structurally:
      //   join(nestedDef.intrinsicEff, intrinsic effects of all arg expressions)
      // Using step.morphTy.eff would over-approximate when an outer param is
      // threaded through as an arg — it would count the param's declared bound
      // instead of treating it as pure.
      const nestedDef = defs.get(node.defName);
      const nestedIntrinsic: ConcreteEffect = nestedDef ? nestedDef.intrinsicEff : step.morphTy.eff;
      return [...node.argSubst.values()].reduce<ConcreteEffect>(
        (acc, arg) => effectJoin(acc, computeBodyIntrinsicEffect(arg, paramNames, defs)),
        nestedIntrinsic,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Type freshening (for polymorphic instantiation)
// ---------------------------------------------------------------------------

type FreshenResult = {
  morphTy:  MorphTy;
  params:   DefParamInfo[];
  subst:    Subst;
  effSubst: EffSubst;
};

function freshenDefFull(def: DefInfo): FreshenResult {
  // Collect all type variable names in the def's morphTy and params
  const tyVarNames = new Set<string>();
  const effVarNames = new Set<string>();
  collectVarsInMorphTy(def.morphTy, tyVarNames, effVarNames);
  for (const p of def.params) collectVarsInMorphTy(p.morphTy, tyVarNames, effVarNames);

  const subst: Subst = new Map();
  const effSubst: EffSubst = new Map();

  for (const name of tyVarNames) {
    subst.set(name, { tag: "TyVar", name: freshTyVar() });
  }
  // EffVars: we don't rename them for now since v1 effect vars are mostly "ε"
  // and we resolve them via unification. Skip effVar freshening in v1.

  const freshMorphTy: MorphTy = {
    input:  applySubst(def.morphTy.input,  subst, effSubst),
    output: applySubst(def.morphTy.output, subst, effSubst),
    eff:    resolveEffFinal(applyEffSubst(def.morphTy.eff, effSubst)),
  };
  const freshParams = def.params.map((p) => ({
    name: p.name,
    morphTy: {
      input:  applySubst(p.morphTy.input,  subst, effSubst),
      output: applySubst(p.morphTy.output, subst, effSubst),
      eff:    resolveEffFinal(applyEffSubst(p.morphTy.eff, effSubst)),
    },
  }));

  return { morphTy: freshMorphTy, params: freshParams, subst, effSubst };
}

function freshenDef(def: DefInfo): { morphTy: MorphTy } {
  const { morphTy } = freshenDefFull(def);
  return { morphTy };
}

function collectVarsInMorphTy(mt: MorphTy, tyVars: Set<string>, effVars: Set<string>) {
  collectVarsInType(mt.input,  tyVars, effVars);
  collectVarsInType(mt.output, tyVars, effVars);
  // MorphTy.eff is ConcreteEffect (always a string); no EffVars to collect here.
}

function collectVarsInType(ty: Type, tyVars: Set<string>, effVars: Set<string>) {
  switch (ty.tag) {
    case "TyVar": tyVars.add(ty.name); break;
    case "Record": ty.fields.forEach((f) => collectVarsInType(f.ty, tyVars, effVars)); break;
    case "Named":  ty.args.forEach((a) => collectVarsInType(a, tyVars, effVars)); break;
    case "Arrow":
      collectVarsInType(ty.from, tyVars, effVars);
      collectVarsInType(ty.to,   tyVars, effVars);
      if (typeof ty.eff !== "string") effVars.add(ty.eff.name);
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Constructor instantiation
// ---------------------------------------------------------------------------

function freshenCtor(ctor: CtorInfo): { payloadTy: Type | null; adtTy: Type } {
  // Create fresh type variables for the ADT's type params
  const subst: Subst = new Map();
  for (const param of ctor.adtParams) {
    subst.set(param, { tag: "TyVar", name: freshTyVar() });
  }
  const payloadTy = ctor.payloadTy !== null ? applySubst(ctor.payloadTy, subst) : null;
  const adtTy: Type = {
    tag: "Named",
    name: ctor.adtName,
    args: ctor.adtParams.map((p) => applySubst({ tag: "TyVar", name: p }, subst)),
  };
  return { payloadTy, adtTy };
}

// ---------------------------------------------------------------------------
// Variant resolution
// ---------------------------------------------------------------------------

type VariantResolution = { info: TypeDeclInfo; typeArgs: Subst };

function resolveVariant(
  inputTy: Type, typeDecls: TypeDeclEnv, sourceId: SourceNodeId,
): TypeResult<VariantResolution> {
  if (inputTy.tag !== "Named") {
    return typeError(`case/fold requires a variant input type, got ${showType(inputTy)}`, sourceId, "E_NOT_VARIANT");
  }
  const info = typeDecls.get(inputTy.name);
  if (!info) return typeError(`Unknown type '${inputTy.name}'`, sourceId, "E_UNKNOWN_TYPE");
  if (info.body.tag !== "Variant") return typeError(`'${inputTy.name}' is not a variant type`, sourceId, "E_NOT_VARIANT");

  // Build type argument substitution
  const typeArgs: Subst = new Map();
  for (let i = 0; i < info.params.length; i++) {
    const arg = inputTy.args[i];
    if (arg === undefined) break;
    typeArgs.set(info.params[i]!, arg);
  }
  return ok({ info, typeArgs });
}

function instantiatePayload(ctor: CtorInfo, typeArgs: Subst): Type | null {
  if (ctor.payloadTy === null) return null;
  return applySubst(ctor.payloadTy, typeArgs);
}

function findCtor(ctors: CtorInfo[], name: string): CtorInfo | null {
  return ctors.find((c) => c.ctorName === name) ?? null;
}
