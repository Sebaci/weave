# Weave v1 — Elaboration Rules

> **Status:** Draft. Corresponds to:
> - `weave-spec-v1.md` — semantic specification
> - `weave-surface-syntax-v1.md` — surface syntax
>
> This document defines the precise, implementable mapping from surface syntax
> to the core calculus. Desugaring is total: every well-typed surface
> expression has a unique elaborated core form.

---

## 1. Overview

Elaboration translates surface Weave syntax into the core calculus. The core
calculus is a symmetric monoidal category (SMC) with effect nodes. It has no
surface conveniences: no named bindings, no infix operators, no syntactic
sugar. Elaboration is a purely structural transformation — it introduces no
new semantics, resolves no overloading, and performs no type inference beyond
what is necessary to determine which core forms apply.

**Phase boundary.** Elaboration assumes the surface program has passed parsing
and the relevant well-typedness and exhaustiveness checks required to determine
construct shape (e.g. that `case`/`fold` branches cover a known closed variant,
and that types resolve). The elaborator is not responsible for these checks;
they are the typechecker's responsibility.

Every surface expression denotes a morphism `A -> B`. Elaboration produces a
core morphism term. The correspondence is:

| Surface construct | Core form |
|---|---|
| `{ fields } >>> expr` | projection bindings dissolved into body |
| `build { ... }` | `⟨e1', ..., en'⟩ : 1 -> { a1: A1, ..., an: An }` |
| `fanout { ... }` | `dup_n >>> (f1 *** ... *** fn)` |
| `let x = e in body` | `dup_n >>> (f_x *** passthroughs) >>> body'`  (n = \|L\|+1, see §9) |
| `case { ... }` | `caseof { Tag1: h1, ..., Tagn: hn }` |
| `fold { ... }` | `cata(caseof { Tag1: h1, ..., Tagn: hn })` |
| `over .f t` | `⟨.f >>> t', id_ρ⟩` |
| `perform op` | `effect_node(op)` |
| `f (p1: e1, ...)` | definition-level substitution; no new core form (see §2) |
| constructor (nullary) | unit-sourced morphism `(1 -> T)` |
| constructor (payload) | constructor morphism `(P -> T)` |

### Elaboration Function

`elab(...)` denotes the meta-level elaboration function from surface
expressions to core morphism terms. The document uses two related
presentations:

1. **Standalone construct morphism** — the core morphism denoted by a
   construct in isolation, e.g. `caseof { ... } : Σ -> A`.
2. **Full pipeline elaboration** — the elaboration of a whole pipeline in
   which that construct appears, e.g. `elab(expr) >>> caseof { ... }`.

These are related by compositionality:

```
elab(e1 >>> e2) = elab(e1) >>> elab(e2)
```

Stress tests give both forms where relevant. `elab(...)` is used only when
referring to the elaboration of a surface expression as a whole. Within
construct rules, core forms are written directly without wrapping them in
`elab`.

### Core Calculus Notation

| Notation | Meaning |
|---|---|
| `>>>` | sequential composition |
| `***` | monoidal product on morphisms (parallel) |
| `⟨f1, ..., fn⟩` | product pairing morphism (universal property) |
| `.f` | projection morphism |
| `dup` | diagonal morphism `(I -> I ⊗ I)` |
| `dup_n` | n-ary diagonal `(I -> I^n)` |
| `!` | terminal morphism `(I -> 1)` |
| `id` | identity morphism |

**Pairing and expansion.** The pairing notation `⟨f1, ..., fn⟩` is the
abstract product morphism derived from the universal property of products.
In worked core expansions, when the shared source object is made explicit,
we write it as:

```
dup_n >>> (f1 *** ... *** fn)
```

These two forms are definitionally equivalent. The pairing form is preferred
in rules; the expanded form is used in examples for clarity.

### Product-Structure Unification

Several constructs are related instances of product-structure manipulation:

- **`fanout`** — shared-input product construction: all branches receive the
  same input via `dup`, producing a record.
- **`let`** — shared-input product construction plus rebinding: desugars to a
  `fanout` that introduces a new name alongside passthrough fields.
- **`over`** — product reconstruction with one field transformed: projects the
  target field, applies the transform, and pairs the result back with the
  passthrough fields.

---

## 2. `effect` Declarations and Schema Instantiation

These two constructs sit above the expression-level elaboration machinery.
Neither produces a core morphism term directly; they operate at the module and
definition levels respectively.

### 2.1 `effect` Declarations — Populating `Ω`

An `effect` declaration:

```weave
effect name : A -> B ! ε
```

is a **module-level type declaration**. It does not elaborate to any core term.
Its sole elaboration effect is to register an entry in the operation environment
`Ω`:

```
Ω(qualifiedName) = (A, B, ε)
```

where `qualifiedName` is the module-qualified name of the operation (e.g.
`Http.get` when `get` is declared in module `Http`).

`Ω` is populated by the typechecker from all `effect` declarations in scope
(direct and imported) before any expression-level elaboration begins. The
elaborator treats `Ω` as read-only.

**Effect level constraint:** `ε` in an `effect` declaration must be
`parallel-safe` or `sequential`. A declaration with `! pure` is a type error —
pure computations are ordinary `def`s, not effect operations.

**Runtime binding:** `Ω` records the declared signature only. The mapping from
operation name to host-provided implementation function is supplied externally
at program entry. The elaborator and IR carry only the `OpRef`; no runtime
implementation detail enters the core.

### 2.2 Schema Instantiation — Definition-Level Substitution

A schema instantiation:

```weave
f (p1: e1, p2: e2, ...)
```

where `f` is the name of a higher-order `def` with declared parameters
`(p1 : T1) (p2 : T2) ...`, is resolved **before expression-level elaboration**.
It is not a new core form.

**Resolution rule:** The elaborator locates the definition of `f` in
`Γ_global`. It binds each declared parameter name to the corresponding supplied
morphism expression by name, in any order. It then elaborates the body of `f`
with those bindings substituted. The result is a fully elaborated core morphism
for the instantiated body, identical to what would result from inlining a
`def` with concrete arguments.

**Formally:** if `f` has definition:

```
def f (p1 : T1) ... (pn : Tn) : A -> B ! ε = body
```

then `f (p1: e1, ..., pn: en)` elaborates as:

```
elab(body[p1 := elab(e1), ..., pn := elab(en)])
```

Substitution is capture-avoiding. The substituted morphisms `elab(ei)` are
closed morphisms with their own types and effect levels; no ambient `Γ_local`
is in scope at the substitution site.

**Effect level:** The effect level of the instantiated body is re-derived after
substitution, following the standard join rules. It is not read from the
declaration's effect annotation — the annotation is a checked assertion, not
the source of truth at elaboration time.

**Any well-typed morphism expression is a valid argument.** This includes named
`def`s, constructors, grouped pipeline expressions `(step >>> step)`,
`case`/`fold`/`over` expressions, and `perform op`. There is no second-class
status for any morphism form at a call site. The constraint is purely
type-directed: `elab(ei)` must have type `Ti`.

**Schema instantiation is not general function application.** It is
definition-level parameter substitution. The core calculus has no application
node corresponding to it.

---

## 3. Environment Model

### 3.1 Environment Structure

An elaboration environment consists of two disjoint components:

```
Γ = (Γ_global, Γ_local)
```

**`Γ_global : Name -> (A -> B ! ε)`**
Maps globally defined names and constructors to their core morphisms.
These are closed: they do not depend on any ambient pipeline input.

**`Γ_local : Name -> (R -> A ! pure)`**
Maps locally bound names to pure projection morphisms from the current
input type `R`. These are input-derived. All entries share the same
source object `R`.

The fundamental distinction is closed vs input-derived:

- **Closed morphisms:** independent of any ambient input. Source: `1`.
  Includes globals, nullary constructors, literals, `build` expressions.

- **Input-derived morphisms:** projections from the current input `R`.
  Source: `R`. Introduced only by `{ fields } >>>` and `let` bindings.

### 3.2 Names Are Projections, Not Values

A name `fi` introduced by `{ fields } >>>` denotes the projection morphism:

```
.fi : R -> Ai ! pure
```

Names are not stored values. They are abbreviations for pure projections
from the shared input `R`. All `Γ_local` entries share the same source object
`R`. When multiple names are used together, `R` must be duplicated via `dup`
— this duplication is introduced by the consuming construct, not by the
binding form.

### 3.3 Γ_local at Construct Boundaries

`Γ_local` is never structurally reset. It remains present across all
elaboration steps. However, when elaborating a sub-expression whose input
type differs from `R` — such as a `case`/`fold` branch handler or an `over`
handler — the outer `Γ_local` entries have domain `R`, which does not unify
with the sub-expression's input type. They are ill-typed in that context and
are rejected by the type system. This is a type-mismatch consequence, not a
scoping operation.

### 3.4 Name Introduction

Names enter `Γ_local` through exactly two mechanisms:

- `{ fields } >>>` destructors
- `let` bindings (which desugar to `fanout`)

No other construct introduces names. `build`, `fanout`, `case`, `fold`,
`over`, and `perform` do not extend `Γ_local`.

### 3.5 Wildcard Binder

In `{ f1, head: _, f2 } >>>`, the `_` binder introduces no name into
`Γ_local`. The projection `.head` is simply not bound. `_` is not discarding
a computation — pure projections have no effects to drop. `_` is
elaboration-neutral but not type-irrelevant: the input type must contain the
field `head` for some type `A`. The type system enforces field presence;
elaboration proceeds as if the field were absent from the binder list.

---

## 4. General Principles

These principles hold across all elaboration rules. Construct sections
reference rather than re-derive them.

**P1 — No environment reset.**
`Γ_local` is structurally preserved at all construct boundaries.
Sub-expression inaccessibility is always a consequence of type mismatch,
never of environment mutation.

**P2 — No construct introduces effects.**
Every construct's effect level is the join of its sub-expression effect
levels. `effect_node(op)` (from `perform`) is the only primitive that
introduces a non-pure effect. All other constructs propagate.

**P3 — Projections are always pure and always duplicable.**
`.f : { f: A | ρ } -> A ! pure` for any field `f`. Projections may be
duplicated without constraint. This distinguishes `{ fields } >>>`-bound
names from `let`-bound names, whose duplication may be constrained by the
RHS effect level.

**P4 — Handler context discipline.**
Whenever a sub-expression has a different input type from the outer pipeline
(`case`/`fold` branch handlers, `over` handlers), outer `Γ_local` entries
are ill-typed there. Handler elaboration uses a fresh `Γ_local` populated by
the handler's own `{ fields } >>>` binder (if present), with projections from
the handler's input type.

**P5 — `build` and `fanout` are categorically distinct.**
They share the product pairing form `⟨...⟩` but differ in source object and
validity conditions. `build`: source is `1`, fields must be closed. `fanout`:
source is `I` (shared pipeline input), fields may be input-derived. They are
not variations of the same construct.

**P6 — Elaboration produces finite core terms.**
The recursive traversal in `fold` is a semantic execution property of `cata`,
not a product of elaboration. Elaboration constructs the algebra and forms
`cata(alg)`; the bottom-up traversal is performed at runtime.

---

## 5. norm_I — Branch Normalization

`norm_I` is a sub-rule used by `fanout` and `let` to normalize branch
expressions to morphisms of type `I -> A`, for a given shared input type `I`.
It is used only for constructs that normalize subexpressions against a shared
input object `I`. Constructs whose subexpressions are elaborated under a
different fixed input type (`case`, `fold`, `over`) do not use `norm_I` —
their subexpressions must already have the correct domain and are checked
directly by the type system.

### Definition: norm_I(I, e)

1. Elaborate `e` under the current `(Γ_global, Γ_local)` to obtain a core
   morphism `m`.

2. Classify `m` by its domain type:

   **Case A — `m : I -> A`**
   `norm_I(I, e) = m`. Used directly. Covers: `Γ_local` projections, global
   morphisms of type `I -> A`, composed pipelines whose domain is `I`.

   **Case B — `m : 1 -> A`**
   `norm_I(I, e) = (! >>> m) : I -> A`. Lifted via the terminal morphism
   `! : I -> 1`. Covers: literals, nullary constructors, `build` expressions,
   unit-sourced globals.

   **Case C — `m : X -> A` where `X ≠ I` and `X ≠ 1`**
   `norm_I` fails. Type error:
   `"branch expression has domain X; expected I or 1."`

**Effect level of `norm_I(I, e)`:**
Cases A and B: `effect(m)`. (`!` is pure; contributes nothing to join.)
Case C: n/a.

`norm_I` is used only by constructs that normalize against a shared input `I`.
`build` does not use `norm_I` — it has a stricter origin constraint
(closedness) and a fixed source object (`1`). `norm_I` is also the only
place where unit-sourced morphisms (`1 -> A`) are lifted to match a non-unit
input via `! >>>`. No other construct performs this lifting independently.

---

## 6. `{ fields } >>>` — Projection Binding

### Surface Form

```weave
{ f1, f2, ..., fn } >>> body
```

where each `fi` is a plain name or `name: _` (wildcard).

### Input and Output Types

```
Input type:  R = { f1: A1, ..., fn: An | ρ }
Output type: determined by body
```

### Elaboration

`{ fields } >>>` has no independent core form. Its sole elaboration effect is
to extend `Γ_local` with projections from `R`:

```
Γ_local' = Γ_local
          ∪ { fi ↦ (.fi : R -> Ai ! pure) | fi not wildcarded }
```

The body is elaborated under `(Γ_global, Γ_local')`. Each occurrence of a
bound name `fi` in the body contributes the projection `.fi` at that point.
All wiring (`dup`, `***`) is introduced by the consuming constructs within
`body`, not by the binder.

`{ fields } >>>` introduces no `dup`, no fanout, and no core-level term of
its own.

### Effect Rule

```
effect({ fields } >>> body) = effect(body)
```

Projections are pure (P3); the binder contributes nothing.

### Duplication of Bound Names

A name `fi` from `{ fields } >>>` may appear any number of times in `body`.
Duplication is unconditionally valid because projections are always pure (P3).
No discardability constraint applies.

### Stress Test — Wildcard Binder

```weave
Cons: { head: _, tail } >>> tail + 1
```

Input type `R = { head: a, tail: Int }`
`Γ_local' = { tail ↦ (.tail : R -> Int ! pure) }`
(`head` is wildcarded; `.head` never enters `Γ_local`)

Body `tail + 1` infix-desugars to `fanout { l: tail, r: 1 } >>> add`,
which elaborates to:

```
dup_2 >>> (.tail *** (! >>> zero_1)) >>> add
: R -> Int ! pure
```

---

## 7. `build` — Closed Record Construction

### Surface Form

```weave
build { a1: e1, a2: e2, ..., an: en }    -- n ≥ 0
```

### Input and Output Types

```
Input type:  1   (unit object; build is unit-sourced)
Output type: { a1: A1, ..., an: An }
```

The empty case: `build {}` elaborates to `id_1 : 1 -> 1`, the unique
morphism on the unit object. (`{}` is the unit object `1` in the cartesian
structure on record types — they are the same object, not merely isomorphic.)

### Validity Condition (enforced during elaboration)

Each field expression `ei` must be closed: no name from `Γ_local` may appear
in `ei`. `Γ_local` is structurally present but any reference to it is a type
error (origin check, independent of domain-type checking):

```
"build field expression must be closed; ambient name X is not permitted."
```

This constraint is categorical: `build` fields are independent morphisms from
`1`. An input-derived name would require a shared input, which `build` does
not have.

### Elaboration

1. Elaborate each `ei` under `(Γ_global, Γ_local)` — `Γ_local` references
   are rejected as above.
2. Obtain `ei' : 1 -> Ai` for each `i`.
3. Construct:
   ```
   ⟨e1', ..., en'⟩ : 1 -> { a1: A1, ..., an: An }
   ```
   No duplication of a non-unit input occurs. Source is `1`; duplication
   at `1` is trivial in a strict SMC.

### Effect Rule

```
effect(build { a1: e1, ..., an: en }) = effect(e1') ⊔ ... ⊔ effect(en')
```

### Stress Test — Invalid `build`

```weave
{ head, tail } >>>
  build { head, tail }
```

`Γ_local = { head ↦ .head, tail ↦ .tail }`

Both field expressions reference `Γ_local` names and are rejected:

```
"build field expression must be closed; ambient name head is not permitted."
"build field expression must be closed; ambient name tail is not permitted."
```

Correction: use `fanout { head, tail }` to construct a record from
input-derived names.

---

## 8. `fanout` — Shared-Input Record Construction

### Surface Form

```weave
fanout { a1: e1, a2: e2, ..., an: en }    -- n ≥ 0
```

### Input and Output Types

```
Input type:  I   (shared pipeline input at the fanout call site)
Output type: { a1: A1, ..., an: An }
```

The empty case: `fanout {}` elaborates to `! : I -> 1` (terminal morphism
into the unit object).

### Elaboration

1. For each branch `ei`, compute `fi = norm_I(I, ei) : I -> Ai`.
   If any branch fails normalization, elaboration fails.
2. Construct:
   ```
   ⟨f1, ..., fn⟩ : I -> { a1: A1, ..., an: An }
   ```
3. Expand to core form:
   ```
   dup_n >>> (f1 *** f2 *** ... *** fn)
   ```
   where `dup_n : I -> I^n` is the canonical n-ary diagonal morphism,
   defined inductively from `dup` (up to standard associativity isomorphisms
   of the monoidal structure).

Shorthand: in `fanout { a: name }` where `name ∈ Γ_local` and field name
equals binding name, this expands to `a: .name` (Case A of `norm_I`).

### Effect Rule

```
effect(fanout { a1: e1, ..., an: en }) = effect(f1) ⊔ ... ⊔ effect(fn)
```

### Product Pairing Laws

```
⟨f1, ..., fn⟩ >>> .ai  =  fi        (beta, for each i; unconditional)
⟨.a1, ..., .an⟩        =  id_R      (eta, for R = { a1: A1, ..., an: An })
```

These are categorical facts about products. The effect-guarded rewrite:

```
dup >>> (f *** g) >>> .a  ⇒  f    (when g is discardable)
```

is an operational optimization distinct from the beta law. The beta law
establishes meaning; the effect guard establishes when removing `g` is
semantics-preserving.

### Stress Test

```weave
{ head, tail } >>>
  fanout { head: head >>> transform, tail }
```

Input type `I = { head: a, tail: b }`,
`Γ_local = { head ↦ .head, tail ↦ .tail }`

Branch elaboration:
- `head >>> transform`: `norm_I(I, ...) = .head >>> transform : I -> C` (Case A)
- `tail` (shorthand): `norm_I(I, tail) = .tail : I -> b` (Case A)

Elaborated form:

```
dup_2 >>> ((.head >>> transform) *** .tail)
: { head: a, tail: b } -> { head: C, tail: b }
```

---

## 9. `let` — Local Derived Binding

### Valid Contexts

`let` is valid only:

- inside a `{ fields } >>>` destructor scope (`Γ_local` non-empty), or
- nested inside another `let` (which must itself satisfy the above)

`let` is not valid at the top level or inside `build` field expressions.

### Surface Form

```weave
let x = e in body
```

### Input and Output Types

```
Input type:  I   (shared input at the let site)
Output type: determined by body
```

### Live Set

```
L = fv_Γ_local(body) \ {x}
```

`fv_Γ_local(body)` is the set of `Γ_local` names appearing free in `body`
under lexical scope. Shadowing is handled naturally by lexical scope. `L` is
ordered by first occurrence of each name in `body` under left-to-right
lexical traversal.

### Elaboration

Let `n = |L| + 1` (one branch for `f_x`, one for each passthrough in `L`).
Let `f_x = norm_I(I, e) : I -> A_x` and
`f_vi = .vi : I -> A_vi` for each `vi ∈ L` (pure passthrough projections).

1. Construct fanout:
   ```
   dup_n >>> (f_x *** f_v1 *** ... *** f_v|L|)
   : I -> R'
   ```
   where `R' = { x: A_x, v1: A_v1, ..., v|L|: A_v|L| }`.
   Branch-to-label correspondence fixed by the ordering of `L`.

2. Extend environment:
   ```
   Γ_local' = { x ↦ (.x : R' -> A_x) }
            ∪ { vi ↦ (.vi : R' -> A_vi) | vi ∈ L }
   ```
   `x` denotes projection `.x` from `R'` — a dataflow component, not a
   captured value.

3. Elaborate `body` under `(Γ_global, Γ_local')` to obtain `body' : R' -> B`.

4. Full elaborated form:
   ```
   dup_n >>> (f_x *** f_v1 *** ... *** f_v|L|) >>> body'
   : I -> B
   ```

### Duplication Constraint

Let `G` be the elaborated subgraph rooted at the continuation — the graph of
`body'` and all nested RHS subgraphs within it.

```
uses(x, G) > 1  implies  effect(f_x) = pure
```

`uses(x, G)` counts distinct consumption sites of `.x` in `G` — that is,
the number of outgoing edges from the `.x` node in the elaborated graph,
corresponding to the number of distinct consumers of the computed value.
This is a graph-structural count, not a textual occurrence count. If violated:

```
"let binding x is used N times but its RHS is not discardable.
 A non-pure let binding may be used at most once."
```

Passthrough names `vi ∈ L` are always pure projections; their duplication is
unconditionally valid.

### Sharing Semantics

`f_x` is evaluated exactly once; its effects (if any) occur exactly once.
Downstream uses of `x` duplicate only the produced value via `dup` — they do
not re-trigger the RHS. Effects in `body'` are independent.

### Effect Rule

```
effect(let x = e in body) = effect(f_x) ⊔ effect(body')
```

### Stress Test 1 — Nested `let`

```weave
{ head, tail } >>>
  let y = head >>> f in
  let z = y >>> g in
  fanout { left: y, right: z, tail } >>> Out
```

Initial: `I = { head: a, tail: b }`,
`Γ_local = { head ↦ .head, tail ↦ .tail }`

**Outer `let` (`y`):**
- `f_y = .head >>> f : I -> B` (norm_I Case A)
- `L = { tail }` (tail free in outer body; head not free; y excluded)
- Fanout: `dup_2 >>> ((.head >>> f) *** .tail) : I -> { y: B, tail: b }`
- `I' = { y: B, tail: b }`, `Γ_local' = { y ↦ .y, tail ↦ .tail }`

**Inner `let` (`z`), under `I'`:**
- `f_z = .y >>> g : I' -> C` (norm_I Case A)
- `L' = { y, tail }` (both free in inner body; z excluded)
- Fanout: `dup_3 >>> ((.y >>> g) *** .y *** .tail)`
- Note: `.y` appears twice. `y` is a `Γ_local'` projection — pure, always
  duplicable (P3). No constraint fires.
- `I'' = { z: C, y: B, tail: b }`,
  `Γ_local'' = { z ↦ .z, y ↦ .y, tail ↦ .tail }`

**Body:** `fanout { left: y, right: z, tail } >>> Out`
elaborates to `dup_3 >>> (.y *** .z *** .tail) >>> Out : I'' -> Output`

**Full elaborated form:**

```
dup_2 >>> ((.head >>> f) *** .tail)
>>> dup_3 >>> ((.y >>> g) *** .y *** .tail)
>>> dup_3 >>> (.y *** .z *** .tail) >>> Out
```

Effect: `effect(f) ⊔ effect(g) ⊔ effect(Out)`

**Duplication constraint on outer `let`:**
`y` appears in inner let RHS (`y >>> g`) and in final fanout (`left: y`).
`uses(y, G) = 2`. Therefore `effect(f)` must be `pure`.

### Stress Test 2 — Invalid Non-Pure Duplication

```weave
let response = perform Http.get in
fanout { a: response, b: response }
```

- `f_response = norm_I(I, perform Http.get) : I -> Response ! sequential`
  (Case B: lifted via `!`)
- `uses(response, G) = 2`
- `effect(f_response) = sequential ≠ pure`

Elaboration fails:

```
"let binding response is used 2 times but its RHS is not discardable.
 A non-pure let binding may be used at most once."
```

---

## 10. `case` — Coproduct Eliminator

### Surface Form

```weave
case {
  Tag1: handler1,
  Tag2: { f1, f2 } >>> handler2,
  ...
  Tagn: handlern,
}
```

### Input and Output Types

```
Input type:  Σ = Tag1(P1) | ... | Tagn(Pn)   (closed variant; exhaustive)
Output type: A   (all branch handlers must unify to A)
```

`A` is concrete. `case` never produces an implicit union.

### Branch Input Types

```
Nullary constructor Tagi:    branch input type = 1
Record-payload constructor:  branch input type = Pi
```

### Branch Elaboration

For each branch `Tagi: handleri`, elaborated under handler context discipline
(P4): outer `Γ_local` entries are projections from the pre-branch input type
at the `case` call site; branch input type is `Pi`; outer entries are
ill-typed in the branch context and rejected by the type system.

**Nullary `Tagi`:**
`hi` elaborated under `(Γ_global, Γ_local = {})`.
Result: `hi : 1 -> A`

**Record-payload `Tagi` with `{ f1, ..., fk } >>>`:**
```
Γ_local^i = { fj ↦ (.fj : Pi -> Aj ! pure) | fj not wildcarded }
```
Handler body elaborated under `(Γ_global, Γ_local^i)`.
Result: `hi : Pi -> A`

### Core Form

```
caseof { Tag1: h1, ..., Tagn: hn } : Σ -> A
```

Constructor-keyed. Branch identity is determined by constructor tags,
not position.

### Effect Rule

```
effect(case { Tag1: h1, ..., Tagn: hn }) = effect(h1) ⊔ ... ⊔ effect(hn)
```

Static upper bound. All branches contribute even though only one executes
at runtime (P2).

### Full Pipeline Elaboration

```
elab(expr) >>> caseof { Tag1: h1, ..., Tagn: hn }
Effect: effect(expr) ⊔ effect(h1) ⊔ ... ⊔ effect(hn)
```

### Stress Test

```weave
fetchResult >>> case {
  Ok:  { value } >>> value >>> formatUser,
  Err: { error } >>> error >>> formatError,
}
```

Preceding expression: `elab(fetchResult) : 1 -> Σ`
where `Σ = Ok { value: User } | Err { error: Text }`

**Ok branch:**
- Branch input type: `{ value: User }`
- `Γ_local^Ok = { value ↦ (.value : { value: User } -> User ! pure) }`
- Elaborated handler: `.value >>> formatUser`
- `h_Ok : { value: User } -> Output`

**Err branch:**
- Branch input type: `{ error: Text }`
- `Γ_local^Err = { error ↦ (.error : { error: Text } -> Text ! pure) }`
- Elaborated handler: `.error >>> formatError`
- `h_Err : { error: Text } -> Output`

Standalone `case` morphism:
```
caseof { Ok: h_Ok, Err: h_Err } : Σ -> Output
```

Full elaborated pipeline:
```
elab(fetchResult) >>> caseof { Ok: h_Ok, Err: h_Err } : 1 -> Output
```

Effect: `effect(fetchResult) ⊔ effect(formatUser) ⊔ effect(formatError)`

---

## 11. `fold` — Catamorphism

### Surface Form

Identical to `case`. The semantic distinction — `fold` applies to recursive
ADTs and substitutes the carrier type `A` for recursive positions — is
enforced by the type system.

### Input and Output Types

```
Input type:  μF   (recursive ADT; F is its base functor)
Output type: A    (fold carrier type; need not equal μF)
```

### Base Functor Substitution

For ADT `μF` with constructors `Tag1(P1[μF]) | ... | Tagn(Pn[μF])`:

The algebra payload for each constructor is `Pi[A/μF]` — obtained by
substituting `A` for `μF` structurally throughout the type expression `Pi`.
Substitution is applied at every occurrence of `μF` within `Pi`, regardless
of nesting depth, including occurrences inside nested record types or type
applications. Only occurrences of the specific ADT `μF` being folded are
substituted; type parameters, other ADTs, and other type constructors are
not affected.

**Examples:**

```
type List a = Nil | Cons { head: a, tail: List a }
Cons payload: { head: a, tail: List a }  →  { head: a, tail: A }
(tail is a recursive position; head is a type parameter — not substituted)

type Weird a = Wrap { pair: { left: Weird a, right: Weird a } }
Wrap payload: { pair: { left: Weird a, right: Weird a } }
           →  { pair: { left: A, right: A } }
(recursive positions nested inside inner record — substituted)

type Tree a = Leaf | Node { value: a, children: List (Tree a) }
Node payload: { value: a, children: List (Tree a) }
           →  { value: a, children: List A }
(Tree a inside List — substituted; List itself is not)
```

### Branch Coverage

The branch set must cover the constructors of `μF` exactly. Exhaustiveness
is enforced by the type system.

### Branch Input Types

```
Nullary constructor Tagi:    branch input type = 1
Record-payload constructor:  branch input type = Pi[A/μF]
```

Recursive fields arrive with type `A` — the already-folded result. Branch
handlers cannot inspect the raw sub-ADT or re-enter the recursion. This is
the catamorphism invariant; it guarantees termination.

### Branch Elaboration

Identical mechanism to `case`, with substituted payload types `Pi[A/μF]`.
Handler context discipline (P4) applies: outer `Γ_local` entries are
projections from the pre-fold input type at the call site; inside a branch
the input is `Pi[A/μF]`; outer entries are ill-typed there and rejected by
the type system.

**Nullary `Tagi`:** `hi : 1 -> A`

**Record-payload `Tagi`:**
`Γ_local^i` populated from `Pi[A/μF]`; `hi : Pi[A/μF] -> A`

### Core Form

```
alg = caseof { Tag1: h1, ..., Tagn: hn } : F(A) -> A
cata(alg) : μF -> A
```

Elaboration constructs `alg` and forms `cata(alg)`. The bottom-up recursive
traversal is a semantic execution property of `cata`, not a product of
elaboration (P6).

### Effect Rule

```
effect(fold { Tag1: h1, ..., Tagn: hn }) = effect(h1) ⊔ ... ⊔ effect(hn)
```

Effect level is sourced statically from the algebra. It does not accumulate
through recursive calls as if `fold` were general recursion. `fold`
introduces no effects of its own (P2).

### Full Pipeline Elaboration

```
elab(expr) >>> cata(alg)
```

### Stress Test

```weave
xs >>> fold {
  Nil:  0,
  Cons: { head, tail } >>> head + tail,
}
```

Input type: `μF = List Int`, Carrier `A = Int`

**Base functor substitution:**
- `Nil` — payload: `1`
- `Cons` — payload: `{ head: Int, tail: Int }`
  (`tail: List Int` → `tail: Int`; `head: Int` unchanged)

**Nil branch:**
`h_Nil : 1 -> Int` elaborates to `zero_0 : 1 -> Int`

**Cons branch:**
- Branch input type: `{ head: Int, tail: Int }`
- `Γ_local^Cons = { head ↦ .head, tail ↦ .tail }`
  (`tail : Int` — already-folded result, not `List Int`)
- Body `head + tail` elaborates to: `dup_2 >>> (.head *** .tail) >>> add`
- `h_Cons : { head: Int, tail: Int } -> Int`

```
alg = caseof { Nil: h_Nil, Cons: h_Cons } : F(Int) -> Int
```

Standalone `fold` morphism: `cata(alg) : List Int -> Int`

Full elaborated pipeline: `elab(xs) >>> cata(alg) : 1 -> Int`

Effect: `pure`

---

## 12. `over` — Row-Polymorphic Field Transform

### Surface Form

```weave
over .f t
```

where `.f` names the field to transform and `t` is a step-level expression.
A pipeline handler must be parenthesised: `over .f (step1 >>> step2)`.

### Input and Output Types

```
Input type:  { f: A | ρ }
Output type: { f: B | ρ }
```

`ρ` is a row variable. All non-`f` fields pass through unchanged.

### Handler Context

The handler `t` is elaborated with input type `A` — the type of field `f`.
This is not the ambient outer record type.

Handler context discipline (P4): outer `Γ_local` entries are projections from
the outer record type `{ f: A | ρ }`; inside the handler, the input type is
`A`. Outer `Γ_local` entries are ill-typed in the handler context and rejected
by the type system.

A `{ fields } >>>` binder inside `t` (if present) introduces projections from
`A` into a fresh `Γ_local^handler`.

### Handler Elaboration

```
elab(t) : A -> B ! ε    — used directly
elab(t) : 1 -> B        — lifted to (! >>> elab(t)) : A -> B
otherwise               — type error: handler domain does not match field type
```

### id_ρ — Row Passthrough

`id_ρ` denotes the identity on the row remainder `ρ` — the unique morphism
induced by the product structure that re-emits all fields in `ρ` via their
projections. It is shorthand for derived structure, not a new core primitive.
For concrete `{ f: A, g1: C1, ..., gk: Ck }`, `id_ρ` expands to projections
`.g1, ..., .gk` in the pairing.

### Elaboration

Let `t' : A -> B` be the elaborated handler.

```
over .f t  elaborates to:
  ⟨.f >>> t', id_ρ⟩ : { f: A | ρ } -> { f: B | ρ }
```

Concrete expansion for `{ f: A, g1: C1, ..., gk: Ck }`:

```
dup_{k+1} >>> ((.f >>> t') *** .g1 *** ... *** .gk)
```

Eta law consistency: when `t' = id_A`:
`⟨.f >>> id_A, id_ρ⟩ = ⟨.f, id_ρ⟩ = id_{ f: A | ρ }`

### Effect Rule

```
effect(over .f t) = effect(t')
```

`over` introduces no effects. Passthrough projections are pure (P3).

### Full Pipeline Elaboration

```
elab(expr) >>> ⟨.f >>> t', id_ρ⟩
Effect: effect(expr) ⊔ effect(t')
```

### Stress Test — `over` with Grouped Handler

```weave
user >>> over .address ({ street, city } >>> formatAddress)
```

Assume `formatAddress : { street: Text, city: Text } -> Address ! pure`

Input type: `{ address: { street: Text, city: Text } | ρ }`
Field type `A = { street: Text, city: Text }`

**Handler elaboration:**
- `({ street, city } >>> formatAddress)` has input type `A`
- `Γ_local^handler = { street ↦ .street, city ↦ .city }` (projections from `A`)
- The binder dissolves; body is `formatAddress` with domain `A`
- `t' = formatAddress : A -> Address` ✓

Standalone `over` morphism:
```
⟨.address >>> formatAddress, id_ρ⟩
: { address: { street: Text, city: Text } | ρ } -> { address: Address | ρ }
```

Full elaborated pipeline:
```
elab(user) >>> ⟨.address >>> formatAddress, id_ρ⟩
: 1 -> { address: Address | ρ }
```

Effect: `pure`

---

## 13. `perform` — Explicit Effect Invocation

### Surface Form

```weave
perform qualifiedName
```

`qualifiedName` resolves to a declared effect operation `op` in the effect
operation environment `Ω`.

### Input and Output Types

Determined entirely by the declaration of `op`:

```
Ω(op) = (A, B, ε)

Input type:   A
Output type:  B
Effect level: ε ∈ { parallel-safe, sequential }
```

`perform` contributes no type information of its own.

### Elaboration

```
perform op  →  effect_node(op) : A -> B ! ε
```

`effect_node(op)` is a primitive core calculus node. Its type and effect level
are fixed by the declaration.

### Effect Rule

```
effect(perform op) = ε
```

`perform` is the only elaboration rule that introduces a non-pure effect node
(P2). All other constructs propagate effect levels from subexpressions. In v1,
effect operations are declared only at non-pure effect levels. Pure
computations are ordinary defined morphisms, not `perform` invocations.

### Unit-Sourced `perform`

When `perform` appears without a preceding pipeline, the declared input type
`A` must be `1`. The elaborated morphism is `effect_node(op) : 1 -> B ! ε`.

### Full Pipeline Elaboration

```
elab(expr) >>> effect_node(op)
Effect: effect(expr) ⊔ ε
```

### Stress Test

```weave
userId >>> perform Http.get >>> parseUser
```

`Ω(Http.get) = (UserId, RawResponse, sequential)`
`parseUser : RawResponse -> User ! pure`

Elaboration:
```
elab(userId)            : 1 -> UserId ! pure
effect_node(Http.get)   : UserId -> RawResponse ! sequential
elab(parseUser)         : RawResponse -> User ! pure
```

Full elaborated pipeline:
```
elab(userId) >>> effect_node(Http.get) >>> elab(parseUser)
: 1 -> User ! sequential
```

Effect: `pure ⊔ sequential ⊔ pure = sequential`

---

## 14. Global Invariants of Elaboration

These invariants hold across the entire elaboration model. A proposed
elaboration rule is valid only if it preserves all of them.

**GI-1 — Every elaborated expression is a morphism.**
Every surface expression elaborates to a core morphism `A -> B` for some
`A`, `B`. There are no elaborated terms that are not morphisms.

**GI-2 — `Γ_local` entries are projections from a shared source.**
All entries in `Γ_local` at any elaboration point have the same domain `R`.
They are projections from `R`, not independent morphisms.

**GI-3 — No environment reset.**
`Γ_local` is never structurally mutated or removed at construct boundaries.
Inaccessibility of outer `Γ_local` in sub-expressions is always a consequence
of type mismatch (domain `R` ≠ sub-expression input type).

**GI-4 — No construct introduces effects.**
The effect level of every construct is a join of its sub-expression effect
levels. `effect_node(op)` from `perform` is the only primitive that introduces
a non-pure effect level. A construct whose elaborated form has effect level `ε`
must have at least one sub-expression with effect level `ε`.

**GI-5 — Projections are pure and freely duplicable.**
`.f : { f: A | ρ } -> A ! pure` for all `f`. Names introduced by
`{ fields } >>>` may be used any number of times without constraint.

**GI-6 — `build` and `fanout` are distinct at all levels.**
`build`: source `1`, closedness enforced as origin check, no `dup` of
non-unit input. `fanout`: source `I`, fields may be input-derived, `dup`
introduced. They must not be collapsed or treated as variations of the same
construct.

**GI-7 — `let` sharing semantics.**
The RHS of `let` is evaluated exactly once. Its effects occur exactly once.
Downstream uses of the bound name duplicate only the produced value. A
non-pure RHS may be used at most once (`uses(x, G) ≤ 1`).

**GI-8 — `fold` is a true catamorphism.**
Recursive fields in `fold` branches arrive with type `A` (the carrier), not
`μF` (the ADT). Branch handlers cannot inspect the raw sub-ADT or re-enter
the recursion. The recursive traversal is performed at runtime by `cata`,
not constructed by elaboration.

**GI-9 — Handler context discipline.**
Constructs with sub-expression handlers (`case`, `fold`, `over`) elaborate
those handlers with the handler's own input type, not the outer pipeline
input. Outer `Γ_local` entries are ill-typed in handler contexts and unusable
there.

**GI-10 — Elaboration is finite.**
Every surface program elaborates to a finite core morphism term. There is no
elaboration-time recursion, feedback, or unbounded construction. `fold`
constructs a finite algebra; `cata`'s traversal is a runtime property.

**GI-11 — `effect` declarations produce no core terms.**
An `effect` declaration populates `Ω` at module scope and has no elaborated
core form. The only core artefact of an effect operation is `effect_node(op)`
introduced by `perform op` at call sites. `Ω` is read-only during elaboration
and carries declared signatures only; no runtime implementation detail enters
the core.

**GI-12 — Schema instantiation produces no new core form.**
A schema instantiation `f (p1: e1, ..., pn: en)` is resolved by definition-
level substitution before expression-level elaboration. The result is
indistinguishable in the core from the elaboration of the instantiated body
written out directly. No application node, closure node, or meta-level
abstraction appears in the core term.
