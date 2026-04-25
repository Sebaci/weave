/**
 * Typed AST — output of the typechecker, input to the elaborator.
 *
 * Invariants at this boundary:
 *   - morphTy on every TypedStep is concrete (no TyVar/RowVar/EffVar)
 *     EXCEPT inside TypedDef bodies of polymorphic defs (those are only
 *     elaborated via TypedSchemaInst, which carries the concrete substitution)
 *   - Infix nodes are desugared to Fanout + Ref
 *   - FanoutField shorthand is expanded
 *   - Name is resolved to Ref | LocalRef | Ctor
 *   - Case and Fold are tagged distinctly
 *   - Ω is fully populated
 */

import type { ConcreteEffect, Type } from "../types/type.ts";
import type { SurfaceLiteral } from "../surface/ast.ts";
import type { Expr } from "../surface/ast.ts";
import type { SourceNodeId } from "../surface/id.ts";

// ---------------------------------------------------------------------------
// Morphism type annotation
// ---------------------------------------------------------------------------

/** The type of any morphism: A -> B ! ε. All fields are concrete at IR level. */
export type MorphTy = {
  input:  Type;
  output: Type;
  eff:    ConcreteEffect;
};

// ---------------------------------------------------------------------------
// Module and declarations
// ---------------------------------------------------------------------------

export type TypedModule = {
  path:      string[];
  typedDefs: Map<string, TypedDef>;
  typeDecls: Map<string, TypedTypeDecl>;
  omega:     Omega;
  sourceId:  SourceNodeId;
};

/** Ω — effect operation environment populated from effect declarations. */
export type Omega = Map<string, OmegaEntry>;
export type OmegaEntry = {
  qualifiedName: string;           // e.g. "Http.get"
  inputTy:       Type;
  outputTy:      Type;
  eff:           ConcreteEffect;   // always parallel-safe or sequential
  sourceId:      SourceNodeId;
};

export type TypedDef = {
  name:     string;
  params:   TypedDefParam[];
  morphTy:  MorphTy;               // may contain TyVars for polymorphic defs
  body:     TypedExpr;             // typed body; types concrete for monomorphic defs
  // Surface body kept for schema instantiation in the elaborator.
  // The elaborator inlines this body with tySubst/effSubst/argSubst applied.
  surfaceBody: Expr;
  sourceId: SourceNodeId;
};

export type TypedDefParam = {
  name:    string;
  morphTy: MorphTy;                // may contain TyVars
};

export type TypedTypeDecl = {
  name:        string;
  params:      string[];
  body:        TypedTypeDeclBody;
  isRecursive: boolean;
  sourceId:    SourceNodeId;
};

export type TypedTypeDeclBody =
  | { tag: "Record";  fields: TypedField[] }
  | { tag: "Variant"; ctors: TypedCtorDecl[] };

export type TypedField    = { name: string; ty: Type };
export type TypedCtorDecl = {
  name:      string;
  payloadTy: Type | null;   // null = nullary; may contain TyVars (the ADT's params)
};

// ---------------------------------------------------------------------------
// Typed expressions
// ---------------------------------------------------------------------------

export type TypedExpr = {
  steps:    TypedStep[];
  morphTy:  MorphTy;
  sourceId: SourceNodeId;
};

export type TypedStep = {
  node:     TypedNode;
  morphTy:  MorphTy;
  sourceId: SourceNodeId;
};

export type TypedNode =
  /** Reference to a globally defined morphism. Elaborates to RefNode. */
  | { tag: "Ref";        defId: string }

  /**
   * Reference to a name in Γ_local (introduced by { fields } >>> or let).
   * Elaborates to a port lookup in ElabContext.locals.
   */
  | { tag: "LocalRef";   name: string }

  /** Constructor reference. Elaborates to CtorNode. */
  | { tag: "Ctor";       name: string }

  /** Field projection. Elaborates to ProjNode. */
  | { tag: "Projection"; field: string }

  /** Literal constant. Elaborates to ConstNode. */
  | { tag: "Literal";    value: SurfaceLiteral }

  /**
   * Closed record construction. All field exprs are unit-sourced.
   * Elaborates to TupleNode with ConstNode-sourced inputs.
   */
  | { tag: "Build";      fields: TypedBuildField[] }

  /**
   * Shared-input record construction. Shorthand fields already expanded.
   * Elaborates to DupNode + TupleNode.
   */
  | { tag: "Fanout";     fields: TypedFanoutField[] }

  /**
   * Coproduct eliminator. All branches unified to output type.
   * Elaborates to CaseNode.
   */
  | { tag: "Case";       branches: TypedBranch[] }

  /**
   * Catamorphism. Branch input types are Pi[carrierTy/adtTy] (substituted).
   * Elaborates to CataNode.
   */
  | { tag: "Fold";       adtTy: Type; carrierTy: Type; branches: TypedBranch[] }

  /**
   * Row-polymorphic field transform. Input record type is fully concrete.
   * Elaborates to ProjNode + transform subgraph + TupleNode (with id_ρ expansion).
   */
  | { tag: "Over";       field: string; transform: TypedStep }

  /**
   * Local binding. liveSet is the set of Γ_local names free in body (excluding `name`),
   * ordered by first occurrence — the elaborator uses this ordering for the intermediate
   * record's field layout.
   */
  | { tag: "Let";        name: string; rhs: TypedExpr; body: TypedExpr; liveSet: LiveVar[] }

  /** Effect invocation. Elaborates to EffectNode. */
  | { tag: "Perform";    op: string }

  /**
   * Schema instantiation (higher-order def application).
   * The elaborator applies tySubst/effSubst to the def body's types,
   * binds argSubst names, and elaborates the body. No new IR node is produced.
   *
   * defName: the name of the higher-order def being instantiated
   * tySubst:  type variable substitution (from unifying param types with arg types)
   * effSubst: effect variable substitution
   * argSubst: morphism argument substitution (param name → typed expression)
   */
  | { tag: "SchemaInst";
      defName:  string;
      tySubst:  Map<string, Type>;
      effSubst: Map<string, ConcreteEffect>;
      argSubst: Map<string, TypedExpr> };

// ---------------------------------------------------------------------------
// Sub-nodes
// ---------------------------------------------------------------------------

export type TypedBuildField  = { name: string; expr: TypedExpr };
export type TypedFanoutField = { name: string; expr: TypedExpr };

export type TypedBranch = {
  ctor:         string;
  /** Always the raw constructor payload type (before any carrier substitution).
   *  For case, same as payloadTy. For fold, has adtTy at recursive positions. */
  rawPayloadTy: Type;
  /** For case: same as rawPayloadTy.
   *  For fold: Pi[carrierTy/adtTy] — adtTy replaced by the carrier type. */
  payloadTy:    Type;
  handler:      TypedHandler;
};

export type TypedHandler =
  | { tag: "Nullary"; body: TypedExpr }
  | { tag: "Record";  binders: TypedBinder[]; body: TypedExpr };

/** A field binder in a record handler. Wildcards are dropped — they produce no binding. */
export type TypedBinder = { name: string; fieldTy: Type };

/** An entry in the live set for a let expression. */
export type LiveVar = { name: string; ty: Type };
