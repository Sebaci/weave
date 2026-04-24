# Weave Language — Design Specification (v1 Draft)

## Overview

Weave is a typed, composition-first language grounded in symmetric monoidal category theory. Programs are compositions of pure transformations and explicit effects, with dataflow structure visible in syntax. The language is designed to be LLM-friendly, rewrite-friendly, and practically usable.

---

## Surface Primitives

| Primitive   | Description |
|-------------|-------------|
| `>>>`       | Sequential composition |
| `fanout`    | Split one input into multiple derived outputs |
| `build`     | Construct a record from independent expressions |
| `over`      | Transform specific fields of a record |
| `case`      | Coproduct eliminator / branching |
| `fold`      | Structural recursion over an ADT (catamorphism) |
| `perform`   | Explicit effect invocation |
| `let`       | Binding |

---

## Core Calculus

The surface language desugars to a core calculus consisting of:

- `>>>` — sequential composition
- `***` — parallel composition
- `&&&` — binary fanout
- `caseof` — coproduct elimination
- effect nodes

---

## Core Invariants (v1)

These invariants hold across the entire v1 language. They are not local properties of individual constructs — they are the global contract. Future extensions (v2) must either preserve each invariant or explicitly name which invariant they relax and why.

1. **All programs are morphisms.** Every expression denotes a morphism `A -> B`. There are no free-standing values in the core semantics; a value of type `A` is a morphism `1 -> A`.

2. **Unit as implicit input.** Surface expressions with no explicit input (e.g. `build { ... }`) denote morphisms from the unit object `1`. Surface syntax elides this input; the core calculus makes it explicit.

3. **Closed construction, open consumption.** Record and variant construction forms (`build`, `fanout`, variant constructors) produce closed types at the construction site. Consumption forms (`over`, projections, `case`) may be row-polymorphic. Open/extensible production is a v2 extension.

4. **Effect level is a static upper bound.** Effect classification is computed conservatively from subexpressions and branch handlers. It reflects the maximum observable effect of a construct, not the dynamically taken path. A `case` with one `sequential` branch is statically `sequential`, even though only one branch executes at runtime.

5. **Effect level and structural dependency are independent.** Structural constraints — `fold` recursion order, `fanout` shared input via `dup` — are properties of the construct's categorical structure, not of its effect level. Purity does not imply freedom from structural constraints, and structural constraints are not relaxed by purity.

6. **All rewrites are effect-guarded.** Rewrite rules are stated in terms of discardability. In v1, `discardable ≡ pure`; this is a v1 equivalence, not a permanent definition. Stating guards in terms of discardability ensures they remain semantically correct as the effect vocabulary grows in v2.

7. **`fold` is total.** Every `fold` terminates. Recursion in v1 is structural only — `fold` recurses over the finite structure of an ADT, and recursive branches receive the already-folded result, not the raw substructure. There is no `trace`-style feedback or general recursion mechanism in v1. This invariant is what makes `fold` fusion laws sound and what makes every `fold` expressible as a finite diagram.

---

## Construct Semantics

### `fanout` vs `build`

These constructs look superficially similar — both produce record-shaped outputs — but they desugar to different categorical primitives and have different structural dependency profiles.

**`fanout { a: f, b: g }`** desugars to `dup >>> (f *** g)`. It takes a single input, duplicates it via the diagonal morphism, and applies `f` and `g` to the same value in parallel. Both branches share their input. `fanout` is strictly input-dependent: every branch receives the input.

**`build { a: expr1, b: expr2 }`** is a source node. Its field expressions are independent — there is no shared input being threaded through. Categorically, it is a product of independent morphisms from the unit object: `build { a: e1, b: e2 } : 1 -> { a: A, b: B }`. Surface syntax elides the unit input; the core form makes it explicit. Importantly, `build { ... }` should not be read as "`build` applied to a record argument" — it is a surface form denoting a nullary, unit-sourced arrow. `build {}` is the unit value.

This distinction is load-bearing:

- The rewrite rule `fanout { a: f, b: g } >>> .a ⇒ f` applies only when `g` is discardable (equivalently, pure in v1). The analogous question does not arise for `build`.
- Parallelism semantics diverge (see below).
- The two constructs must not be collapsed — doing so introduced real ambiguity and was reversed.

### `case`

`case` is a coproduct eliminator. All branches must unify to a single output type. If branches naturally produce different shapes, they must be wrapped explicitly in a new tagged union rather than having `case` silently produce an implicit union. This keeps `case` a true coproduct eliminator and preserves clean `>>>` composition — the output of `case` is always a concrete type, never an implicit union.

**Example:**
```
fetchResult >>> case {
  Ok:    .user >>> fanout { label: .name, score: .score },
  Error: .message >>> wrapError
}
```

Both branches must unify to a common output type. If `Ok` and `Error` branches produce different record shapes, they should be wrapped in a new tagged union explicitly.

### `fold`

`fold` is a value-directed catamorphism over an ADT. The ADT is inferred from the input type; an explicit type annotation is required only for disambiguation.

```
xs >>> fold {
  Nil:  zero,
  Cons: { head, tail } >>> accumulate
}
```

**Key invariant:** In a `Cons` branch (or any recursive branch), the recursive field (`tail` above) arrives as the **already-folded result** of the recursive substructure, not as the raw substructure. The branch handler is an algebra over the base functor — it cannot inspect or re-enter the recursion. This is what makes `fold` a true catamorphism rather than general recursion in disguise.

**Typing rule:**

```
Γ ⊢ alg : F A -> A ! ε
-----------------------
Γ ⊢ fold alg : μF -> A ! ε
```

`fold` changes the carrier: it consumes a value of the ADT `μF` and produces a value of the result type `A`. The result type `A` need not equal the ADT's own carrier. This is not a "reduction to the same type" — it is a structural elimination that produces whatever type the algebra targets.

Richer recursive schemes (paramorphisms, histomorphisms) are explicit v2 extensions. They are not a weakening of `fold`; `fold` remains a pure catamorphism in v1.

---

## Type System

### Records

Records support row-polymorphic consumption in v1. Record-producing constructs (`build`, `fanout`) produce closed record types at the construct site. Extensible open record production is deferred to v2. This is parallel to the variants decision: closed production forms for simplicity in v1, open/extensible production as an explicit v2 extension.

**Typing rules — production side (closed):**

```
Γ ⊢ e1 : A ! ε1      Γ ⊢ e2 : B ! ε2
-------------------------------------------
Γ ⊢ build { a: e1, b: e2 } : 1 -> { a: A, b: B } ! (ε1 ⊔ ε2)

Γ ⊢ f : I -> A ! ε1      Γ ⊢ g : I -> B ! ε2
-------------------------------------------------
Γ ⊢ fanout { a: f, b: g } : I -> { a: A, b: B } ! (ε1 ⊔ ε2)
```

The n-ary generalisations are straightforward. Effect level in the conclusion is the join of the premise effect levels.

**Typing rules — consumption side (row-polymorphic):**

```
Γ ⊢ f : A -> B ! ε
----------------------------
Γ ⊢ over .name f : { name: A | ρ } -> { name: B | ρ } ! ε

Γ ⊢ .name : { name: A | ρ } -> A ! pure
```

`ρ` is a row variable ranging over the remaining fields. `over` and projections are transparent with respect to effects — `over` inherits the effect level of the transformer it applies, and projections are always `pure`. The `! ε` notation follows the effects literature (Koka, Gifford/Lucassen): effect level is tracked in the typing judgment, not inside the record type itself.

### Variants

Variants are closed tagged unions (ADTs) for v1. Open/row variants are deferred to v2. This is a deliberate pragmatic choice: row variants require explicit evidence passing and make exhaustiveness checking subtle. Closed variants keep exhaustiveness simple and safe.

---

## Effect System

### Classification

Effects are classified into three levels:

| Level | Semantics | Analogy |
|-------|-----------|---------|
| `pure` | No observable effect; discardable, duplicable, freely reorderable | `Functor` |
| `parallel-safe` | Effects admit combination without observable ordering dependence; not freely discardable | `Applicative` |
| `sequential` | Effects are order-sensitive; `f >>> g` must observe that ordering | `Monad` |

The analogy column is explanatory, not foundational. In particular, `parallel-safe` requires a strictly stronger property than plain `Applicative` — effects must be combinable without ordering dependence (commutative combination), not merely independent.

**Effect classification is a static upper bound on observable effects.** It is computed conservatively by joining effect levels of relevant subexpressions or branch handlers, even when only one path executes at runtime.

### Effect Composition Across `>>>`

Effect levels compose across sequential composition via a join on the lattice `pure ⊑ parallel-safe ⊑ sequential`:

```
effect_level(f >>> g) = effect_level(f) ⊔ effect_level(g)
```

`pure` is the bottom element. This rule is purely about **effect propagation** — it says nothing about structural reordering. A pipeline may be effect-level `pure` and still not be freely reorderable if the constructs within it impose structural constraints (e.g. a `fold` with a pure algebra still has a fixed catamorphic traversal order).

### Effect Propagation at Construct Boundaries

Each construct's effect level is derived from its subexpressions or branch handlers via the same join:

- **`build`**: `effect_level(build { a: e1, b: e2, ... }) = effect_level(e1) ⊔ effect_level(e2) ⊔ ...`  
  No structural dependency — effect level is the sole scheduling constraint.

- **`fanout`**: `effect_level(fanout { a: f, b: g, ... }) = effect_level(f) ⊔ effect_level(g) ⊔ ...`  
  Structural dependency via `dup` is present regardless of effect level.

- **`fold`**: effect level is the join of the algebra branch handler effect levels. The recursive traversal order is a structural constraint of the catamorphism itself, independent of effect level. Effect classification is sourced statically from the algebra — it does not accumulate from recursive control flow as if `fold` were general recursion.

- **`case`**: effect level is the join of branch handler effect levels. Only one branch executes at runtime, but static classification must conservatively account for all branches. A `case` with any `sequential` branch is statically `sequential`.

### Effect Level vs Structural Dependency

These are two independent dimensions. Confusing them is a common source of misunderstanding.

**Effect level** describes what kind of computation a construct performs. It is propagated from the construct's expressions/algebra to the construct itself. No construct adds effects of its own.

**Structural dependency** describes what dataflow and scheduling constraints a construct introduces. It is a property of the construct's categorical structure, not of its effect level.

| Construct | Structural dependency    | Effect level source |
|-----------|--------------------------|---------------------|
| `build`   | None                     | Field expressions   |
| `fanout`  | Shared input (`dup`)     | Branch expressions  |
| `fold`    | Recursive (catamorphism) | Algebra             |

**Critical rule: purity does not imply global parallelizability.**

- A pure `fold` is referentially transparent and rewrite-safe, but the recursive data dependency still imposes a traversal order. An optimizer may exploit purity for memoization and fusion, but cannot freely reorder fold steps.
- `build` fields are structurally independent by construction — there is no shared-input dependency. Any remaining scheduling barriers come only from effect semantics, not from data dependency.
- `fanout` with sequential effects on one branch blocks parallel scheduling, even though both branches share the same input structurally.

This distinction is not only about preventing confusion — it explains why rewrite and fusion laws are valid. `fold` fusion works because the recursive scheme is fixed and known, while effect tracking tells us when the algebra can participate safely in the rewrite. The two dimensions reinforce each other.

### Effect-Guarded Rewrites

All rewrite rules are effect-guarded, with guards stated in terms of discardability. In v1, `discardable ≡ pure`; this is a v1 equivalence, not a permanent definition. Examples:

- `fanout { a: f, b: g } >>> .a ⇒ f` — valid only if `g` is discardable (pure in v1)
- `fold` fusion laws — valid when the algebra is pure and the recursive scheme is fixed

### `fanout` and Parallelism

`fanout` branches can be scheduled in parallel when their effects are parallel-safe. Sequential effects on any branch block parallel scheduling.

### `build` and Parallelism

`build` fields are structurally independent — no shared-input dependency exists. Whether they execute in parallel is governed entirely by the effect discipline. A `build` with sequential effects on one field blocks scheduling of that field for effect reasons, not structural ones.

---

## Recursion

### v1: Structural Recursion Only

General recursion is not supported in v1. Only structural recursion over ADTs is permitted, expressed via `fold` (catamorphisms).

This is not merely a pragmatic simplification — it is a principled commitment. Unrestricted lambda-style recursion:

- Cannot be rendered as a finite string diagram without `trace`
- Makes rewrite rules like fusion unsound across recursive calls without a termination condition
- Undermines the "box with wires" reading that makes Weave LLM-friendly

`fold` over an ADT is always terminating and can be encoded as a diagram — it is a recursive scheme, not a free loop.

### v2: General Recursion

`trace`-style feedback loops are deferred to v2 as an explicit extension. They are not a semantic hole in v1 — they are a named future capability.

---

## Open Questions (v1)

All open questions have been resolved. The spec is complete within its stated v1 boundary.

---

## v2 Candidates

The following are explicitly deferred and should not be addressed in v1:

- Open/row variants (extensible unions)
- Paramorphisms and other recursive schemes beyond catamorphisms
- `trace`-style feedback loops for general recursion
- Error/nondeterminism interaction (Verse-style merges)
- `case` auto-wrapping sugar (type-directed desugaring when target variant type is known)
- Purity/discardability split as distinct effect lattice elements (in v1, `discardable ≡ pure`)