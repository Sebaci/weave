/**
 * Surface AST for Weave v1.
 *
 * This is the output of the parser. Every significant node carries a NodeMeta
 * (stable ID + source span) assigned at parse time — provenance cannot be
 * retrofitted later.
 *
 * Invariants maintained by the parser, checked by the typechecker:
 *   - Pipeline.steps is non-empty
 *   - build field expressions are closed (no ambient Γ_local names)
 *   - let is valid only inside { fields } >>> scope or another let
 *   - EffectDecl.eff is parallel-safe or sequential (not pure)
 *   - case/fold branches cover the variant exhaustively
 *   - fanout shorthand `name` refers to an in-scope name
 *
 * The surface AST makes no distinction between global name references and
 * local binding references — both appear as `Name` steps. Resolution is the
 * typechecker's responsibility.
 *
 * Infix operators are preserved as `Infix` nodes and desugared during
 * typechecking using the fixed v1 builtin operator table. Unknown operators
 * are a type error.
 */

import type { EffectLevel } from "../types/type.ts";
import type { NodeMeta } from "./id.ts";
import { dummyMeta } from "./id.ts";

// Re-export for consumers who import from this module.
export type { NodeMeta } from "./id.ts";

// ---------------------------------------------------------------------------
// Surface effect annotations
// ---------------------------------------------------------------------------

/**
 * Effect annotation at the surface level. Identical in structure to EffectLevel
 * from the type system — reused directly to avoid duplication.
 * "pure" | "parallel-safe" | "sequential" | { tag: "EffVar"; name: string }
 */
export type SurfaceEffect = EffectLevel;

// ---------------------------------------------------------------------------
// Surface type expressions
// ---------------------------------------------------------------------------

/**
 * A field in a surface record type declaration, or a constructor payload field.
 * Used in type declarations only (not in expressions).
 */
export type SurfaceField = {
  name: string;
  ty:   SurfaceType;
  meta: NodeMeta;
};

export type SurfaceType =
  /**
   * One of the five builtin base types. The parser resolves uppercase type names
   * Int, Float, Bool, Text, Unit directly to BaseType; all other uppercase names
   * become Named.
   */
  | { tag: "BaseType"; base: "Int" | "Float" | "Bool" | "Text" | "Unit"; meta: NodeMeta }

  /**
   * Type variable — a lowercase name in a type expression, e.g. `a`, `b`.
   * Absent at IR level (resolved by typechecker).
   */
  | { tag: "TyVar"; name: string; meta: NodeMeta }

  /**
   * Named ADT or type constructor, potentially applied to args.
   *   List a   →  Named("List", [TyVar("a")])
   *   List Int →  Named("List", [BaseType("Int")])
   *   Maybe    →  Named("Maybe", [])
   */
  | { tag: "Named"; name: string; args: SurfaceType[]; meta: NodeMeta }

  /**
   * Record type.
   *   Closed:          { f: T, g: U }           rest = null
   *   Row-polymorphic: { f: T | r }              rest = "r"
   *
   * Production forms (in type declarations) are always closed (rest = null).
   * Consumption forms (in def params, over types) may be row-polymorphic.
   */
  | { tag: "Record"; fields: SurfaceField[]; rest: string | null; meta: NodeMeta }

  /**
   * Arrow type.
   *   A -> B       eff = null   (effect inferred or from outer defDecl annotation)
   *   A -> B ! ε   eff = ε
   *
   * For unit-sourced defs the surface elides `1 ->`. In that case the
   * defDecl carries the output type directly (not wrapped in Arrow) and the
   * outer `! effectLevel` annotation applies.
   */
  | { tag: "Arrow"; from: SurfaceType; to: SurfaceType; eff: SurfaceEffect | null; meta: NodeMeta };

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

export type SurfaceLiteral =
  | { tag: "int";   value: number  }
  | { tag: "float"; value: number  }
  | { tag: "text";  value: string  }
  | { tag: "bool";  value: boolean };

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/**
 * The canonical expression type. A pipeline of one or more steps.
 * Parser invariant: steps.length >= 1.
 * A single-step expression is Pipeline { steps: [s] } — no special singleton form.
 */
export type Expr = { tag: "Pipeline"; steps: Step[]; meta: NodeMeta };

export type Step =
  /**
   * Reference to a lowercase name — could be a globally defined morphism,
   * a local binding from { fields } >>> or let, or a higher-order param.
   * Resolved by the typechecker.
   */
  | { tag: "Name";       name: string;                               meta: NodeMeta }

  /**
   * Reference to an uppercase constructor name, e.g. `Cons`, `None`.
   * Categorically distinct from Name — elaborates to CtorNode, not RefNode.
   */
  | { tag: "Ctor";       name: string;                               meta: NodeMeta }

  /**
   * Field projection morphism: `.fieldName : { f: A | ρ } -> A ! pure`
   */
  | { tag: "Projection"; field: string;                              meta: NodeMeta }

  /**
   * Literal constant: int, float, text, bool.
   * `build {}` (empty build) is the unit value — represented as Build([]).
   */
  | { tag: "Literal";    value: SurfaceLiteral;                      meta: NodeMeta }

  /**
   * Schema instantiation of a higher-order def: `f (p1: e1, p2: e2, ...)`.
   * Resolved at definition level before expression elaboration.
   * Distinct from plain Name even though `name` has the same lexical form.
   */
  | { tag: "SchemaInst"; name: string; args: SchemaArg[];            meta: NodeMeta }

  /**
   * Closed record construction from independent unit-sourced expressions.
   * Parser invariant: no field expression references a Γ_local name.
   * (Enforced as a type error by the typechecker, not structurally.)
   */
  | { tag: "Build";      fields: BuildField[];                       meta: NodeMeta }

  /**
   * Shared-input record construction: desugars to dup_n >>> (f1 *** ... *** fn).
   * Fields may reference input-derived names (Γ_local).
   * Shorthand `name` (without `: expr`) expands to `name: name` during typechecking.
   */
  | { tag: "Fanout";     fields: FanoutField[];                      meta: NodeMeta }

  /**
   * Coproduct eliminator. Branches must unify to a single output type.
   * Syntactically identical to Fold; the distinction is type-directed.
   */
  | { tag: "Case";       branches: Branch[];                         meta: NodeMeta }

  /**
   * Catamorphism over a recursive ADT. Branch handlers receive already-folded
   * recursive fields (type A, not μF). Syntactically identical to Case.
   */
  | { tag: "Fold";       branches: Branch[];                         meta: NodeMeta }

  /**
   * Row-polymorphic field transform: `over .f t`
   * `.f` is the field name; `transform` is a step-level expression.
   * Pipeline handlers must be parenthesised at the surface (handled by parser).
   */
  | { tag: "Over";       field: string; transform: Step;             meta: NodeMeta }

  /**
   * Local derived binding: `let name = rhs in body`.
   * Valid only inside a { fields } >>> scope or another let (typechecker enforces).
   * Desugars to fanout + passthrough projections during elaboration.
   */
  | { tag: "Let";        name: string; rhs: Expr; body: Expr;        meta: NodeMeta }

  /**
   * Explicit effect invocation: `perform Http.get`.
   * op is the qualified name as a string list, e.g. ["Http", "get"].
   * The typechecker resolves op against Ω to obtain (A, B, ε).
   */
  | { tag: "Perform";    op: string[];                               meta: NodeMeta }

  /**
   * Infix operator sugar: `a + b` → `fanout { l: a, r: b } >>> add`.
   * The operator string is the raw symbol: "+", "-", "*", "==", "&&", etc.
   * Desugared by the typechecker using the fixed v1 builtin operator table.
   * Unknown operators are a type error.
   */
  | { tag: "Infix";      op: string; left: Step; right: Step;        meta: NodeMeta };

// ---------------------------------------------------------------------------
// Expression sub-forms
// ---------------------------------------------------------------------------

/** Named morphism argument in a schema instantiation: `paramName: expr` */
export type SchemaArg = { name: string; expr: Expr; meta: NodeMeta };

/** Named field in a build expression: `fieldName: expr` */
export type BuildField = { name: string; expr: Expr; meta: NodeMeta };

/**
 * Named field in a fanout expression.
 *   Field:     `name: expr`   — explicit
 *   Shorthand: `name`         — sugar for `name: name`; typechecker expands
 */
export type FanoutField =
  | { tag: "Field";     name: string; expr: Expr; meta: NodeMeta }
  | { tag: "Shorthand"; name: string;             meta: NodeMeta };

/**
 * A single branch in a case or fold expression.
 * `ctor` is the constructor name (uppercase).
 */
export type Branch = { ctor: string; handler: Handler; meta: NodeMeta };

/**
 * Branch handler.
 *   NullaryHandler: for constructors with no payload — body is a morphism from 1
 *   RecordHandler:  for record-payload constructors — binders bind payload fields,
 *                   then body is elaborated with those names in Γ_local
 */
export type Handler =
  | { tag: "NullaryHandler"; body: Expr;                             meta: NodeMeta }
  | { tag: "RecordHandler";  binders: FieldBinder[]; body: Expr;    meta: NodeMeta };

/**
 * Field binder in a { fields } >>> destructor.
 *   Bind:     `name`   — binds the field, introduces name into Γ_local
 *   Wildcard: `name: _` — field must be present in the type but is not bound;
 *             name is kept so the typechecker can verify field presence
 */
export type FieldBinder =
  | { tag: "Bind";     name: string; meta: NodeMeta }
  | { tag: "Wildcard"; name: string; meta: NodeMeta };

// ---------------------------------------------------------------------------
// Top-level declarations
// ---------------------------------------------------------------------------

export type Module = {
  path:    string[];   // e.g. ["Collections", "List"]
  imports: Import[];
  decls:   TopDecl[];
  meta:    NodeMeta;
};

export type Import = { path: string[]; meta: NodeMeta };

export type TopDecl =
  | { tag: "TypeDecl";   decl: TypeDecl   }
  | { tag: "DefDecl";    decl: DefDecl    }
  | { tag: "EffectDecl"; decl: EffectDecl };

// ---------------------------------------------------------------------------
// Type declarations
// ---------------------------------------------------------------------------

export type TypeDecl = {
  name:   string;     // uppercase, e.g. "List"
  params: string[];   // type variable names, e.g. ["a"]
  body:   TypeDeclBody;
  meta:   NodeMeta;
};

export type TypeDeclBody =
  | { tag: "Record";  fields: SurfaceField[] }
  | { tag: "Variant"; ctors:  CtorDecl[]    };

/**
 * A single constructor in a variant declaration.
 *   payload = null  →  nullary constructor (e.g. Nil)
 *   payload = [...]  →  record-payload constructor (e.g. Cons { head: a, tail: List a })
 */
export type CtorDecl = {
  name:    string;                  // uppercase
  payload: SurfaceField[] | null;
  meta:    NodeMeta;
};

// ---------------------------------------------------------------------------
// def declarations
// ---------------------------------------------------------------------------

/**
 * A higher-order morphism parameter: `(name : typeExpr)` in a def signature.
 * `ty` must be an Arrow type; enforced by the typechecker.
 */
export type DefParam = { name: string; ty: SurfaceType; meta: NodeMeta };

export type DefDecl = {
  name:   string;               // lowercase
  params: DefParam[];           // higher-order morphism params (may be empty)

  /**
   * The full typeExpr parsed after the `:` in the def signature.
   *
   *   def f : A -> B ! ε = ...   →  ty = Arrow(A, B, ε),  eff = null
   *   def f : B ! ε = ...        →  ty = <output type B>, eff = ε
   *   def f : A -> B = ...       →  ty = Arrow(A, B, null), eff = null
   *
   * Unit-sourced defs have no Arrow at the surface — the elaborator inserts
   * `1 ->`. When `ty` is not an Arrow, `eff` carries the effect annotation.
   */
  ty:     SurfaceType;

  /**
   * Outer effect annotation from `def name : outputTy ! eff = ...`.
   * Present only when `ty` is not an Arrow type (unit-sourced def).
   * null means pure (inferred), or the Arrow's inner eff applies.
   */
  eff:    SurfaceEffect | null;

  body:   Expr;
  meta:   NodeMeta;
};

// ---------------------------------------------------------------------------
// effect declarations
// ---------------------------------------------------------------------------

/**
 * An effect operation signature declaration.
 *
 *   effect name : A -> B ! ε
 *
 * Always an arrow type with a mandatory, non-pure effect annotation.
 * Stored decomposed (inputTy, outputTy, eff) because the arrow structure
 * is mandatory and known at parse time. The typechecker enforces eff ≠ pure.
 *
 * Populates Ω: name → (inputTy, outputTy, eff).
 * Produces no core term — no elaborated form exists for effect declarations.
 */
export type EffectDecl = {
  name:     string;          // lowercase
  inputTy:  SurfaceType;
  outputTy: SurfaceType;
  eff:      SurfaceEffect;   // mandatory; typechecker rejects "pure"
  meta:     NodeMeta;
};

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

// Surface types

export function stBase(base: "Int" | "Float" | "Bool" | "Text" | "Unit"): SurfaceType {
  return { tag: "BaseType", base, meta: dummyMeta() };
}
export function stTyVar(name: string): SurfaceType {
  return { tag: "TyVar", name, meta: dummyMeta() };
}
export function stNamed(name: string, ...args: SurfaceType[]): SurfaceType {
  return { tag: "Named", name, args, meta: dummyMeta() };
}
export function stRecord(fields: SurfaceField[], rest: string | null = null): SurfaceType {
  return { tag: "Record", fields, rest, meta: dummyMeta() };
}
export function stArrow(from: SurfaceType, to: SurfaceType, eff: SurfaceEffect | null = null): SurfaceType {
  return { tag: "Arrow", from, to, eff, meta: dummyMeta() };
}
export function stField(name: string, ty: SurfaceType): SurfaceField {
  return { name, ty, meta: dummyMeta() };
}

// Expressions

export function pipeline(...steps: Step[]): Expr {
  return { tag: "Pipeline", steps, meta: dummyMeta() };
}
export function stepName(name: string): Step {
  return { tag: "Name", name, meta: dummyMeta() };
}
export function stepCtor(name: string): Step {
  return { tag: "Ctor", name, meta: dummyMeta() };
}
export function stepProj(field: string): Step {
  return { tag: "Projection", field, meta: dummyMeta() };
}
export function stepLit(value: SurfaceLiteral): Step {
  return { tag: "Literal", value, meta: dummyMeta() };
}
export function stepBuild(fields: BuildField[]): Step {
  return { tag: "Build", fields, meta: dummyMeta() };
}
export function stepFanout(fields: FanoutField[]): Step {
  return { tag: "Fanout", fields, meta: dummyMeta() };
}
export function stepCase(branches: Branch[]): Step {
  return { tag: "Case", branches, meta: dummyMeta() };
}
export function stepFold(branches: Branch[]): Step {
  return { tag: "Fold", branches, meta: dummyMeta() };
}
export function stepOver(field: string, transform: Step): Step {
  return { tag: "Over", field, transform, meta: dummyMeta() };
}
export function stepLet(name: string, rhs: Expr, body: Expr): Step {
  return { tag: "Let", name, rhs, body, meta: dummyMeta() };
}
export function stepPerform(op: string[]): Step {
  return { tag: "Perform", op, meta: dummyMeta() };
}
export function stepInfix(op: string, left: Step, right: Step): Step {
  return { tag: "Infix", op, left, right, meta: dummyMeta() };
}
export function stepSchema(name: string, args: SchemaArg[]): Step {
  return { tag: "SchemaInst", name, args, meta: dummyMeta() };
}

// Branches / handlers

export function branch(ctor: string, handler: Handler): Branch {
  return { ctor, handler, meta: dummyMeta() };
}
export function nullaryHandler(body: Expr): Handler {
  return { tag: "NullaryHandler", body, meta: dummyMeta() };
}
export function recordHandler(binders: FieldBinder[], body: Expr): Handler {
  return { tag: "RecordHandler", binders, body, meta: dummyMeta() };
}
export function bindBinder(name: string): FieldBinder {
  return { tag: "Bind", name, meta: dummyMeta() };
}
export function wildcardBinder(name: string): FieldBinder {
  return { tag: "Wildcard", name, meta: dummyMeta() };
}

// Fields

export function buildField(name: string, expr: Expr): BuildField {
  return { name, expr, meta: dummyMeta() };
}
export function fanoutField(name: string, expr: Expr): FanoutField {
  return { tag: "Field", name, expr, meta: dummyMeta() };
}
export function fanoutShorthand(name: string): FanoutField {
  return { tag: "Shorthand", name, meta: dummyMeta() };
}
export function schemaArg(name: string, expr: Expr): SchemaArg {
  return { name, expr, meta: dummyMeta() };
}

// Declarations

export function mkModule(path: string[], imports: Import[], decls: TopDecl[]): Module {
  return { path, imports, decls, meta: dummyMeta() };
}
export function mkImport(path: string[]): Import {
  return { path, meta: dummyMeta() };
}
export function mkTypeDeclRecord(name: string, params: string[], fields: SurfaceField[]): TypeDecl {
  return { name, params, body: { tag: "Record", fields }, meta: dummyMeta() };
}
export function mkTypeDeclVariant(name: string, params: string[], ctors: CtorDecl[]): TypeDecl {
  return { name, params, body: { tag: "Variant", ctors }, meta: dummyMeta() };
}
export function mkCtorDecl(name: string, payload: SurfaceField[] | null): CtorDecl {
  return { name, payload, meta: dummyMeta() };
}
export function mkDefDecl(
  name: string,
  params: DefParam[],
  ty: SurfaceType,
  eff: SurfaceEffect | null,
  body: Expr,
): DefDecl {
  return { name, params, ty, eff, body, meta: dummyMeta() };
}
export function mkDefParam(name: string, ty: SurfaceType): DefParam {
  return { name, ty, meta: dummyMeta() };
}
export function mkEffectDecl(
  name: string,
  inputTy: SurfaceType,
  outputTy: SurfaceType,
  eff: SurfaceEffect,
): EffectDecl {
  return { name, inputTy, outputTy, eff, meta: dummyMeta() };
}
