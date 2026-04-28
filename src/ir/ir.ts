/**
 * Weave v1 Core Graph IR.
 *
 * A typed, port-based directed graph. All types are fully concrete —
 * no TyVar, row variables, or effect variables appear at this level.
 *
 * Invariants IR-1 through IR-8 are documented in weave-ir-v1.md §6
 * and enforced by src/ir/validate.ts.
 */

import type { Type, ConcreteEffect } from "../types/type.ts";
import type { SourceNodeId, SourceSpan } from "../surface/id.ts";

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

export type GraphId = string;
export type NodeId  = string;
export type PortId  = string;
export type DefId   = string;
export type OpRef   = string;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type Provenance = {
  sourceId: SourceNodeId;
  span?:    SourceSpan;
  role?:    string;   // e.g. "dup-for-fanout", "passthrough-proj", "algebra-branch"
};

// ---------------------------------------------------------------------------
// Ports and wires
// ---------------------------------------------------------------------------

export type Port = {
  id: PortId;
  ty: Type;
};

export type Wire = {
  from: PortId;
  to:   PortId;
};

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export type Graph = {
  id:         GraphId;
  inPort:     Port;
  outPort:    Port;
  effect:     ConcreteEffect;
  nodes:      Node[];
  wires:      Wire[];
  provenance: Provenance[];
};

// ---------------------------------------------------------------------------
// Literal values (for ConstNode)
// ---------------------------------------------------------------------------

export type LiteralValue =
  | { tag: "int";   value: number  }
  | { tag: "float"; value: number  }
  | { tag: "text";  value: string  }
  | { tag: "bool";  value: boolean }
  | { tag: "unit"                  };

// ---------------------------------------------------------------------------
// Node base
// ---------------------------------------------------------------------------

export type NodeBase = {
  id:         NodeId;
  effect:     ConcreteEffect;
  provenance: Provenance[];
};

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** Diagonal morphism dup_n : I -> I^n. All sharing must go through DupNode. */
export type DupNode = NodeBase & {
  kind:    "dup";
  input:   Port;
  outputs: Port[];   // n outputs, all same type as input; n >= 2
  effect:  "pure";
};

/** Terminal morphism ! : I -> 1. Introduced by norm_I Case B. */
export type DropNode = NodeBase & {
  kind:   "drop";
  input:  Port;
  output: Port;      // always type Unit
  effect: "pure";
};

/** Projection morphism .f : { f: A | ρ } -> A ! pure */
export type ProjNode = NodeBase & {
  kind:   "proj";
  input:  Port;
  output: Port;
  field:  string;
  effect: "pure";
};

/** Product pairing ⟨f1, ..., fn⟩. Used by fanout, build, let, over. */
export type TupleNode = NodeBase & {
  kind:   "tuple";
  inputs: { label: string; port: Port }[];
  output: Port;
  effect: "pure";
};

/**
 * caseof { Tag1: h1, ..., Tagn: hn } : Σ -> A  (plain case)
 * CaseNode(field=k, contextTy=ρ) : { k: Σ | ρ } -> A  (field-focused case .k)
 *
 * IR-6b (checked): when `field` is present, each branch graph's input port type
 * must be merge(Pi, ρ) for record-payload constructors, or ρ for nullary constructors.
 */
export type CaseNode = NodeBase & {
  kind:       "case";
  input:      Port;
  output:     Port;
  variantTy:  Type;        // Σ — the closed variant type being eliminated
  outTy:      Type;        // A — the shared result type of all branches
  branches:   { tag: string; graph: Graph }[];
  field?:     string;      // discriminant field name; absent for plain case
  contextTy?: Type;        // ρ = input record type minus field k; absent for plain case
};

/**
 * cata(alg) : μF -> A
 *
 * IR-6 (checked): each algebra branch graph's input port type must be
 * Pi[A/μF] (substituted payload), not Pi[μF] (raw payload).
 */
export type CataNode = NodeBase & {
  kind:      "cata";
  input:     Port;         // type: μF
  output:    Port;         // type: A
  adtTy:     Type;         // μF
  carrierTy: Type;         // A
  algebra:   { tag: string; rawPayloadTy: Type; graph: Graph }[];
};

/** Unit-sourced literal constant 1 -> T. */
export type ConstNode = NodeBase & {
  kind:   "const";
  value:  LiteralValue;
  output: Port;
  effect: "pure";
};

/**
 * Constructor morphism P -> T (or 1 -> T for nullary).
 * Categorically distinct from RefNode.
 */
export type CtorNode = NodeBase & {
  kind:     "ctor";
  input:    Port;    // Unit type for nullary constructors
  output:   Port;    // the ADT type
  ctorName: string;
  adtTy:    Type;
  effect:   "pure";
};

/** Effectful primitive. The only node that introduces a non-pure effect. */
export type EffectNode = NodeBase & {
  kind:   "effect";
  input:  Port;
  output: Port;
  op:     OpRef;
  effect: "parallel-safe" | "sequential";
};

/** Reference to a globally defined morphism. */
export type RefNode = NodeBase & {
  kind:   "ref";
  defId:  DefId;
  input:  Port;
  output: Port;
};

// ---------------------------------------------------------------------------
// Node union
// ---------------------------------------------------------------------------

export type Node =
  | DupNode
  | DropNode
  | ProjNode
  | TupleNode
  | CaseNode
  | CataNode
  | ConstNode
  | CtorNode
  | EffectNode
  | RefNode;

// ---------------------------------------------------------------------------
// Elaborated module
// ---------------------------------------------------------------------------

export type ElaboratedModule = {
  /** One Graph per monomorphic def. Polymorphic defs are omitted. */
  defs:      Map<string, Graph>;
  /** Pass-through from the typed module. */
  typeDecls: Map<string, import("../typechecker/typed-ast.ts").TypedTypeDecl>;
  omega:     import("../typechecker/typed-ast.ts").Omega;
};
