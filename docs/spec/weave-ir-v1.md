# Weave v1 — Core Graph IR Design

> **Status:** Draft. Corresponds to:
> - `weave-spec-v1.md` — semantic specification
> - `weave-surface-syntax-v1.md` — surface syntax
> - `weave-elaboration-rules-v1.md` — elaboration rules
>
> This document defines the core graph IR, elaboration context, and
> provenance model agreed during the implementation architecture phase.
> It is a handoff document for Claude Code — read alongside the three
> spec documents, not as a standalone reference.

---

## 1. Overview

The core IR is a **typed, port-based directed graph**. This follows directly
from the semantics:

- Programs are morphisms composed via `>>>`, `***`, `dup`, etc.
- Elaboration produces explicit wiring (`dup`, projections, pairing).
- `let` sharing vs. recomputation is a graph property, not a syntactic one.
- Effect level and structural dependency are orthogonal but both must be
  preserved.

The IR reflects the actual dataflow graph, not an approximation of it.

### Phase boundary

```
Parse → Surface AST (with stable node IDs)
     → Typecheck (unification lives here) → Typed AST
     → Elaborate (no unification; type-directed) → Graph IR
     → Interpret / Rewrite / Visualize
```

Elaboration assumes a fully typed AST. It does not perform unification. All
`Port.ty` values in the graph are fully resolved — no row variables or
unresolved effect variables remain at IR level.

---

## 2. Provenance Model

Provenance must be decided at IR design time. It cannot be retrofitted later
without breaking tooling.

### Stable surface AST node IDs

Every surface AST node is assigned a **stable opaque ID at parse time**,
before elaboration. These IDs are the durable anchor for all provenance
references. Source spans are kept alongside IDs for editor features but are
not the primary key (spans shift on edits; IDs do not).

```ts
type SourceNodeId = string        // stable, assigned at parse time
type SourceSpan = {
  start: Position;
  end:   Position;
}

type Position = {
  line:   number;
  column: number;
}
```

### Provenance on nodes and graphs

Every node and every graph carries a `provenance` list. The list supports
one-to-many and many-to-one relationships:

- A surface construct may elaborate into multiple nodes; all carry the same
  provenance entry.
- Synthetic nodes (e.g. the `dup` introduced by a `fanout`) are attributed to
  the surface construct that caused their introduction.
- The `role` field is optional metadata for tooling — it distinguishes
  structural roles without encoding UX decisions in the IR.

```ts
type Provenance = {
  sourceId: SourceNodeId;
  span?:    SourceSpan;
  role?:    string;    // e.g. "dup-for-fanout", "passthrough-proj", "algebra-branch"
}
```

### Provenance under rewrites

When a rewrite eliminates a node or introduces a new one, the output nodes
inherit the **union** of provenance from the input nodes they were derived
from. Structurally new nodes introduced by a rewrite are attributed to the
rewrite source pattern, which itself carries a name or ID.

Without an explicit merge rule, rewrites silently destroy provenance.

---

## 3. Type Representation

### Design constraint

The `Type` ADT must support:

- **Base types** — `Int`, `Text`, `Bool`, `Float`, `Unit`
- **Record types** — closed: `{ f1: T1, ..., fn: Tn }` and row-polymorphic:
  `{ f1: T1 | ρ }`
- **Variant/ADT types** — with type parameters, e.g. `List a`, `Result e a`
- **Arrow types** — `A -> B ! ε` (with effect level embedded)
- **Type variables** — lowercase, e.g. `a`, `b`; bound and resolved by the
  typechecker before elaboration
- **Row variables** — `ρ`; distinct from type variables (range over field
  sets, not types)
- **Effect variables** — `ε`; appear in higher-order def parameters
- **Type application** — `List A`, `Maybe A`
- **Substitution operation** — required for CataNode base functor substitution
  `Pi[A/μF]`

### Key constraint: row and effect variables in IR

Row variables and effect variables exist in the typed AST but are
**instantiated away** during elaboration — the elaborator expands them against
known concrete types. The core graph IR operates on fully concrete types. No
row or effect variables appear in `Port.ty` values at IR level.

This means the elaborator needs the fully resolved type of the current input
port to expand constructs like `over` (which must enumerate the concrete
passthrough fields from `id_ρ`) and `let` (which must enumerate the live set
of passthrough projections).

---

## 4. Graph Structure

```ts
type GraphId = string
type NodeId  = string
type PortId  = string
type DefId   = string
type OpRef   = string

type Effect = "pure" | "parallel-safe" | "sequential"

type Graph = {
  id:         GraphId;
  inPort:     Port;
  outPort:    Port;
  effect:     Effect;       // join of all contained node effects; cached at construction
  nodes:      Node[];
  wires:      Wire[];
  provenance: Provenance[]; // which surface construct this subgraph corresponds to
}

type Port = {
  id:  PortId;
  ty:  Type;
}

type Wire = {
  from: PortId;
  to:   PortId;
}
```

Each `Graph`:

- Has exactly one input port and one output port — it is a morphism `A -> B`.
- Caches `effect` as the join of all contained node effects, computed eagerly
  at construction. This enables fast rejection in effect-guarded rewrite rules
  without full traversal.
- Can be nested (branch graphs in `CaseNode`, algebra graphs in `CataNode`).

---

## 5. Node Types

All nodes carry a shared base:

```ts
type NodeBase = {
  id:         NodeId;
  effect:     Effect;
  provenance: Provenance[];
}
```

Sequential composition is **implicit via wires** — there is no `ComposeNode`.
A `ComposeNode` would reintroduce tree structure into a graph IR and is
explicitly rejected.

### DupNode

```ts
type DupNode = NodeBase & {
  kind:    "dup";
  input:   Port;
  outputs: Port[];     // n outputs, all same type as input
  effect:  "pure";
}
```

Represents the diagonal morphism `dup_n : I -> I^n`. Introduced by
`fanout`, `let`, and `over` during elaboration. The only mechanism by which
a value is duplicated — multiple outgoing wires without an intervening
`DupNode` is an IR invariant violation.

### DropNode

```ts
type DropNode = NodeBase & {
  kind:   "drop";
  input:  Port;
  effect: "pure";
}
```

Represents the terminal morphism `! : I -> 1`. Introduced when a unit-sourced
morphism is lifted into a non-unit context via `norm_I` (Case B).

### ProjNode

```ts
type ProjNode = NodeBase & {
  kind:   "proj";
  input:  Port;
  output: Port;
  field:  string;
  effect: "pure";
}
```

Represents a projection morphism `.f : { f: A | ρ } -> A ! pure`. Always
pure, always freely duplicable.

### TupleNode

```ts
type TupleNode = NodeBase & {
  kind:   "tuple";
  inputs: { label: string; port: Port }[];
  output: Port;
  effect: "pure";
}
```

Represents the product pairing morphism `⟨f1, ..., fn⟩`. Used by `fanout`,
`build`, `let`, and `over`. The `label` on each input corresponds to the
record field name in the output type.

### CaseNode

```ts
type CaseNode = NodeBase & {
  kind:       "case";
  input:      Port;
  output:     Port;
  variantTy:  Type;
  outTy:      Type;
  branches:   { tag: string; graph: Graph }[];
  effect:     Effect;
  // Field-focused variant (case .field):
  field?:     string;   // name of the discriminant field; absent for plain case
  contextTy?: Type;     // ρ = input record type minus field k; absent for plain case
}
```

Represents either:

- **Plain `case`**: `caseof { Tag1: h1, ..., Tagn: hn } : Σ -> A`.
  `field` and `contextTy` are absent. `input.ty = Σ`.
  Branch graphs have input port typed at the constructor payload type `Pi`
  (or `Unit` for nullary constructors).

- **Field-focused `case .k`**: `CaseNode(field=k, contextTy=ρ) : { k: Σ | ρ } -> A`.
  `field = k`, `contextTy = ρ = input.ty \ {k}`. `input.ty = { k: Σ | ρ }`.
  Branch graphs have input port typed at `merge(Pi, ρ)` for payload constructors,
  or `ρ` for nullary constructors.

**IR invariant (checked):** When `field` is present, each branch graph's input port
type must be `merge(Pi, contextTy)` for payload constructors, or `contextTy` for
nullary constructors. This is a checked IR invariant analogous to IR-6 (CataNode
substituted types).

**Field conflict invariant (checked):** When `field` is present, for each payload
constructor branch, `fields(Pi) ∩ fields(contextTy)` must be empty. This is
enforced at elaboration time (call-site type error) and validated at the IR level.

**Interpreter note:** A `CaseNode` with `field` set is a semantic special case. The
interpreter must internally project `.field` from the input record for discrimination,
then route to the matching branch with the context row (and merged payload) as the
branch input. This distribution step is not represented as explicit graph structure.
This follows the CataNode precedent: both are nodes whose evaluation semantics involve
internal structure not expressed as dataflow wires.

Effect is the join of all branch graph effects (static upper bound — all branches
contribute even though only one executes at runtime).

### CataNode

```ts
type CataNode = NodeBase & {
  kind:      "cata";
  input:     Port;       // type: μF (the recursive ADT)
  output:    Port;       // type: A  (the carrier)
  adtTy:     Type;       // μF
  carrierTy: Type;       // A
  algebra:   { tag: string; graph: Graph }[];
  effect:    Effect;
}
```

Represents `cata(alg) : μF -> A`.

**IR-level invariant (checked):** Each algebra branch graph's input port must
use the **substituted** payload type `Pi[A/μF]`, not the raw ADT payload type
`Pi[μF]`. Substitution replaces every occurrence of `μF` in the constructor
payload type with the carrier type `A`. This is the catamorphism invariant
(GI-8 from the elaboration spec) and must be enforced in the IR, not only in
the elaborator.

**Interpreter note:** `CataNode` is a semantic special case. It cannot be
evaluated as plain dataflow (inputs-to-outputs in topological order). The
interpreter must handle it as a recursive fixed-point combiner performing a
bottom-up traversal. This is a known special case at the IR boundary;
document it explicitly in the interpreter.

Effect is the join of all algebra branch graph effects.

### ConstNode

```ts
type ConstNode = NodeBase & {
  kind:   "const";
  value:  LiteralValue;
  output: Port;          // type: the literal's type
  effect: "pure";
}

type LiteralValue =
  | { tag: "int";   value: number }
  | { tag: "float"; value: number }
  | { tag: "text";  value: string }
  | { tag: "bool";  value: boolean }
  | { tag: "unit" }
```

Represents a unit-sourced literal morphism `1 -> A`. `build {}` elaborates
to a `ConstNode` with `{ tag: "unit" }`. All `ConstNode`s are unit-sourced;
they have no input port (equivalently, their implicit input is the unit
object `1`).

### CtorNode

```ts
type CtorNode = NodeBase & {
  kind:     "ctor";
  input:    Port;        // always present; unit type for nullary constructors
  output:   Port;        // type: the ADT
  ctorName: string;
  adtTy:    Type;
  effect:   "pure";
}
```

Represents a constructor morphism, e.g. `Some : { value: a } -> Maybe a` or
`Nil : 1 -> List a`. Constructors are first-class morphisms in the spec and
are categorically distinct from `RefNode` (injection into a sum type vs.
reference to a defined morphism). They must not be folded into `RefNode`.

**Nullary constructors** have `input.ty = Unit`. This preserves the global
invariant that every node is a morphism `A -> B` — there is no `input: Port |
null` special case.

### EffectNode

```ts
type EffectNode = NodeBase & {
  kind:   "effect";
  input:  Port;
  output: Port;
  op:     OpRef;
  effect: "parallel-safe" | "sequential";
}
```

The **only** primitive that introduces a non-pure effect level. All other
nodes propagate effect levels from subexpressions. Corresponds to `perform op`
in the surface language.

### RefNode

```ts
type RefNode = NodeBase & {
  kind:   "ref";
  defId:  DefId;
  input:  Port;
  output: Port;
  effect: Effect;    // inherited from the referenced definition's signature
}
```

Reference to a globally defined morphism. Effect level is inherited from the
referenced definition's declared effect annotation.

### Node union

```ts
type Node =
  | DupNode
  | DropNode
  | ProjNode
  | TupleNode
  | CaseNode
  | CataNode
  | ConstNode
  | CtorNode
  | EffectNode
  | RefNode
```

---

## 6. IR Invariants

These must hold across the entire IR. An IR term that violates any of these
is malformed.

**IR-1 — Every graph is a morphism.**
Every `Graph` has exactly one `inPort` and one `outPort`. All nodes within it
wire to ports traceable to those boundary ports.

**IR-2 — All sharing is explicit via `DupNode`.**
A port may have at most one outgoing wire unless a `DupNode` has been
introduced. Multiple outgoing wires from a non-`DupNode` port is a violation.

**IR-3 — No implicit recomputation.**
Separate nodes denote separate computations. Two consumers of the same value
must share a `DupNode`, not independently reference the same sub-graph.

**IR-4 — Effects are attached to nodes; graph effect is a derived join.**
`Graph.effect` equals the join of all contained node effects. This is
enforced at construction and optionally validated in debug mode.

**IR-5 — `build` and `fanout` are categorically distinct at all levels.**
`build` elaborates to a `TupleNode` whose implicit input is the unit object
(`ConstNode`-sourced fields only). `fanout` elaborates to `DupNode + TupleNode`
with a shared non-unit input. They must not be conflated.

**IR-6 — `CataNode` algebra branch ports use substituted types.**
For `CataNode` with ADT `μF` and carrier `A`: each algebra branch graph's
input port type is `Pi[A/μF]`, not `Pi[μF]`. This is a checked invariant.

**IR-6b — `CaseNode` field-focused branch ports use merged types.**
For `CaseNode` with `field = k` and `contextTy = ρ`: each branch graph's
input port type must be `merge(Pi, ρ)` for payload constructor branches, or
`ρ` for nullary constructor branches. This is a checked invariant. Additionally,
`fields(Pi) ∩ fields(ρ) = ∅` must hold for all payload constructor branches.

**IR-7 — All port types are fully concrete.**
No row variables or unresolved effect variables appear in `Port.ty` at IR
level. These are instantiated away during elaboration.

**IR-8 — Provenance is never empty on nodes derived from surface constructs.**
Purely synthetic nodes introduced by rewrites may have empty provenance lists,
but must then carry the rewrite source attribution. Nodes derived during
elaboration of a surface construct always carry at least one `Provenance`
entry.

---

## 7. Elaboration Context

The elaboration context is the runtime state of the elaborator as it
traverses the typed AST and constructs the graph.

```ts
type ElabContext = {
  globals:          Map<string, DefId>;    // globally defined names and constructors
  locals:           Map<string, PortId>;   // name → port carrying that value in current graph
  currentInputPort: PortId;                // port representing the current morphism input
  currentInputType: Type;                  // fully resolved type of the current input port
  currentGraph:     GraphBuilder;          // mutable graph under construction
}
```

### Key distinction from the elaboration spec

The elaboration spec defines `Γ_local : Name -> (R -> A ! pure)` as a
typing environment. In the graph IR, `Γ_local` becomes `locals : Map<string,
PortId>` — a map from names to **ports in the graph currently being
constructed**, not to types.

When the elaborator encounters a scoped name `tail` in a body, it does not
introduce a new `ProjNode`. It looks up which port already carries `tail`'s
value (introduced by a prior `{ fields } >>>` binder or `let` step) and
wires to that port.

### Name introduction

Names enter `locals` through exactly two mechanisms, mirroring the spec:

- `{ fields } >>>` destructors — introduces projection ports from the current
  input
- `let` bindings — introduces a new port for the computed value alongside
  passthrough projection ports

No other construct extends `locals`.

### `currentInputType` is required

The elaborator needs `currentInputType` (not just `currentInputPort.ty`) as
a first-class field because several constructs must expand it structurally:

- `over .f t` must enumerate the concrete passthrough fields from the row tail
  `ρ` to construct `id_ρ`
- `let x = e in body` must compute the live set and construct passthrough
  projections for all names free in `body`
- `CataNode` algebra branch construction requires the concrete payload types
  `Pi[A/μF]`

---

## 8. Elaboration Strategy (High-Level)

Elaboration is **surface AST → graph construction**, not AST lowering. Each
surface construct maps to a graph building operation:

| Surface construct   | Graph construction |
|---------------------|--------------------|
| `build { ... }`     | `TupleNode` with `ConstNode`-sourced fields; unit input |
| `fanout { ... }`    | `DupNode` + `TupleNode` |
| `{ fields } >>>`   | Extend `locals` with `ProjNode` outputs; no new nodes until consumed |
| `let x = e in body` | `DupNode` + `TupleNode` (fanout of `f_x` and passthroughs) + extend `locals` |
| `case { ... }`      | `CaseNode` with branch `Graph` values |
| `case .k { ... }`   | `CaseNode(field=k, contextTy=ρ)` with branch input types `merge(Pi, ρ)` or `ρ` |
| `fold { ... }`      | `CataNode` with algebra `Graph` values; apply `Pi[A/μF]` substitution |
| `over .f t`         | `ProjNode` + transform subgraph + `TupleNode` (pairing with `id_ρ`) |
| `perform op`        | `EffectNode` |
| constructor         | `CtorNode` |
| literal             | `ConstNode` |
| global name         | `RefNode` |
| scoped name         | Wire to existing port in `locals` |

Provenance is attached during graph construction: every node and subgraph
created during elaboration of a surface construct carries a `Provenance`
entry pointing to that construct's stable `SourceNodeId`.

---

## 9. What Is Not in This Document

The following are deferred and should not be implemented as part of the
core IR:

- Rewrite rules and fusion laws (depend on the IR but are a separate pass)
- Visualization and diagram rendering (consume provenance but define no IR)
- Runtime binding mechanism for effect operations (how `OpRef` maps to host
  functions is external to the language; the IR only carries the `OpRef`)
- All v2 extensions from the spec (open variants, paramorphisms, trace,
  algebraic effect handlers, etc.)

**Note on `EffectNode.op` resolution:** Effect operation declarations use
`effect name : A -> B ! ε` at the top level of any module (see surface syntax
spec §4). The typechecker populates the operation environment `Ω` from these
declarations. `EffectNode.op` is an `OpRef` that resolves against `Ω` at
typecheck time to obtain `(A, B, ε)`. The IR carries only the `OpRef`; no
further resolution is needed at the IR level or below.
