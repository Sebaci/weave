# Weave Surface Syntax — v1 Design Document

> **Status:** Draft. Corresponds to semantic spec v1. This document defines
> what Weave programs look like as text. Elaboration rules (desugaring to the
> core calculus) are a separate document; only their outcomes are referenced
> here where needed to justify surface decisions.

---

## 1. Module and Top-Level Structure

A Weave source file is a **module**. Every file begins with a module
declaration, followed by optional imports, followed by top-level definitions
in any order.

```weave
module Collections.List

import Prelude
import Collections.Internal
```

Top-level constructs are exactly three:

- `type` — closed ADT and record type declarations
- `def` — named morphism definitions
- `effect` — effect operation signature declarations

There is no top-level `let`, no `where` block, and no `do`-style sequencing.
Everything at the top level is a type, a morphism, or an effect operation
signature. Module names
follow a dot-separated hierarchy (`Collections.List`) that corresponds to the
file system path; this is a tooling convention, not a language semantic.

Imports are unqualified by default. A qualified name uses dot-access:
`Collections.Internal.merge`. There is no `hiding` or `as`-renaming in v1.

---

## 2. Type Declarations

### Records

```weave
type Point = { x: Float, y: Float }
```

Record types are closed in v1 — the field set is fixed at the declaration
site. A record type written with a row variable (`{ name: Text | r }`) is a
consumption-site shorthand for row-polymorphic operations; it is not a valid
form in a `type` declaration.

### Variants (ADTs)

```weave
type TypeName typeParams =
  | Constructor1
  | Constructor2 { field1: T1, field2: T2 }
  | Constructor3 { field: T3 }
```

Each constructor is either nullary (no payload) or carries a **named-field
record payload**. Positional (unnamed) payloads are not permitted in v1.
This keeps the whole language aligned around named-field records — every
payload is accessible via projection, `over`, and `{ fields } >>>`.

The `|` on the first constructor is optional but recommended for consistency.

**Examples:**

```weave
type List a =
  | Nil
  | Cons { head: a, tail: List a }

type Result e a =
  | Ok  { value: a }
  | Err { error: e }

type Maybe a =
  | None
  | Some { value: a }

type User =
  | Guest
  | Member { name: Text, score: Int }
```

Type parameters are lowercase; constructor names begin with an uppercase
letter; field names and type variables are lowercase.

### Constructors as Morphisms

Every constructor is a first-class morphism and can be used directly in
pipelines:

```weave
-- Nil  : 1 -> List a
-- Cons : { head: a, tail: List a } -> List a
-- None : 1 -> Maybe a
-- Some : { value: a } -> Maybe a
```

Nullary constructors are unit-sourced morphisms. Record-payload constructors
accept a record of the declared payload type. There is no constructor
application syntax (`Cons(x, xs)` is not valid Weave); constructors compose
via `>>>` like any other morphism.

---

## 3. `def` Signatures and Effect Annotations

### Basic form

```weave
def name : InputType -> OutputType ! effectLevel =
  body
```

Every `def` is a morphism from `InputType` to `OutputType`. The `! effectLevel`
annotation is the public contract for the definition's effect level.

### Unit-sourced definitions

When a definition has no input (it denotes a value or a closed pipeline), the
input type is elided at the surface:

```weave
def defaultUser : User ! pure =
  Member { name: "Anonymous", score: 0 }
```

The elaborated type is `1 -> User ! pure`. The `1 ->` is a core-calculus
detail; surface signatures omit it. This is a surface elision only — the
invariant "values are morphisms from unit" still holds in the core.

### Effect annotation rules

Effect levels are `pure`, `parallel-safe`, and `sequential`.

| Situation | Annotation | Rule |
|-----------|-----------|------|
| Pure definition, no commitment needed | omit `!` | effect inferred as `pure` |
| Pure definition, stability guarantee wanted | `! pure` | optional; becomes a checked assertion — compiler rejects if body is not pure |
| `parallel-safe` definition | `! parallel-safe` | required |
| `sequential` definition | `! sequential` | required |

Omitting `!` on a definition that turns out to be non-pure is a type error.
Writing `! pure` on a definition whose body is not pure is also a type error.

```weave
-- effect inferred; no annotation needed
def sum : List Int -> Int =
  fold { Nil: 0, Cons: { head, tail } >>> head + tail }

-- non-pure; annotation required
def fetchUser : UserId -> User ! sequential =
  perform Http.get >>> parseUser

-- pure with explicit assertion (checked by compiler)
def safeNorm : Vec -> Vec ! pure =
  fanout { x: .x >>> normalise, y: .y >>> normalise }
```

---

## 4. `effect` — Effect Operation Declarations

An `effect` declaration introduces a **typed operation signature** at the top
level of a module. It declares the name, input type, output type, and effect
level of an external operation. It has no body and no runtime semantics of its
own — it is a type-level contract only.

### Syntax

```weave
effect name : InputType -> OutputType ! effectLevel
```

The effect level annotation is **required** on every `effect` declaration.
There is no pure `effect` — pure computations are ordinary `def`s.

### Semantics

`effect` declarations populate the operation environment `Ω` consulted by the
typechecker and elaborator. An `effect` declaration for `op` establishes:

```
Ω(op) = (A, B, ε)
```

where `A` is the input type, `B` is the output type, and `ε` is the effect
level. When `perform op` appears in a pipeline, the typechecker resolves it
against `Ω` to obtain the arrow type `A -> B ! ε`.

`effect` declarations are **signatures only**. They carry no implementation.
Runtime binding — the mapping from operation name to host-provided function —
is external to the language and supplied at program entry. The language does
not specify the runtime binding mechanism; it only specifies that the
implementation must honour the declared type and effect level.

### Namespacing

`effect` declarations follow the standard module system. They are declared in
a module, imported via `import`, and referenced with qualified names:

```weave
module Http

effect get  : UserId -> RawResponse ! sequential
effect post : { url: Text, body: Text } -> RawResponse ! sequential
```

Usage in another module:

```weave
import Http

def fetchUser : UserId -> User ! sequential =
  perform Http.get >>> parseUser
```

There is no dedicated "effect module" construct. Any module may contain
`effect` declarations alongside `type` and `def` declarations. Namespacing
and qualified access use the standard module system with no special casing.

### `parallel-safe` operations

A `parallel-safe` effect operation is a **semantic contract**: the
implementation promises that reordering or concurrent execution of this
operation with other `parallel-safe` operations does not change observable
behaviour. This is stronger than a hint — it is a contract the implementation
must honour. The runtime is permitted but not required to exploit this for
parallel scheduling. A sequential interpreter is a valid v1 runtime.

```weave
module Logger

effect write : Event -> Unit ! parallel-safe
```

### What `effect` declarations are not

- They do not introduce handler scope or interception
- They do not support resumption or continuation capture
- They are not analogous to algebraic effect handlers; there is no `handle`
  construct in v1
- They do not affect the module import semantics beyond adding names to `Ω`

---

## 5. Higher-Order `def` Parameters

A `def` may be parameterised by one or more morphisms. These appear in
parentheses before the `:`, each with an explicit type:

```weave
def map (f : a -> b ! ε) : List a -> List b ! ε =
  fold {
    Nil:  Nil,
    Cons: { head, tail } >>>
      fanout { head: head >>> f, tail } >>> Cons
  }
```

**Semantics:** The parenthesised binder closes over a morphism `f`. The
resulting `def` is a morphism-valued schema — at the meta-level, `map` has
type `(a -> b ! ε) -> (List a -> List b ! ε)`. This is not general
currying or multi-argument application; it is a single level of definition
abstraction used to abstract over a morphism argument.

Multiple parameters are permitted:

```weave
def foldr (f : { head: a, acc: b } -> b ! ε) (z : b ! pure) : List a -> b ! ε =
  fold {
    Nil:  z,
    Cons: { head, tail } >>>
      fanout { head, acc: tail } >>> f
  }
```

**Effect variable scoping:** Effect variables (`ε` above) are implicitly
universally quantified at the `def` site, parallel to type variables. No
explicit `forall ε` syntax is needed in v1. The same variable name in the
parameter type and the result type refers to the same variable — the
definition is polymorphic in the effect level of the supplied morphism.

A definition may constrain its parameter to a specific effect level:

```weave
def pureMap (f : a -> b ! pure) : List a -> List b =
  fold {
    Nil:  Nil,
    Cons: { head, tail } >>>
      fanout { head: head >>> f, tail } >>> Cons
  }
```

Here `pureMap` is only applicable when `f` is pure; the result definition is
also pure (inferred, annotation omitted).

### Schema instantiation — call-site syntax

A higher-order `def` is instantiated at the call site using a **named
morphism-argument list** in parentheses:

```weave
name (param1: expr1, param2: expr2, ...)
```

The parameter names match the binder names declared in the `def`. Order is
irrelevant; arguments are matched by name, not position. This mirrors the
named-field convention used everywhere else in Weave.

```weave
-- single parameter
xs >>> map (f: transform)

-- multiple parameters
xs >>> foldr (f: combine, z: zero)

-- effect operation passed directly as morphism argument
xs >>> map (f: perform Http.get)

-- grouped pipeline expression as argument
xs >>> map (f: (.value >>> normalise))
```

**Semantics:** Schema instantiation is resolved at the definition level.
Named morphism parameters are bound to the supplied named morphism expressions
before elaboration of the instantiated body. This is meta-level substitution,
not a new core form — the elaborator sees the body with parameters already
replaced by the supplied morphisms.

**Any well-typed morphism expression may be supplied as an argument**, including:
- named `def`s
- constructors
- grouped pipeline expressions: `(step >>> step)`
- `case` / `fold` / `over` expressions
- `perform op`

There is no second-class status for any morphism expression at a call site.

**Parentheses disambiguation:** The schema instantiation form `f (p: e, ...)`
is unambiguous with `f` followed by a grouped expression `f (e)`. The
parenthesised content is a schema argument list if and only if it contains
at least one `name:` pair. A colon does not appear in the standalone expression
grammar, so there is no overlap and no lookahead ambiguity.

---

## 6. Expression Grammar Overview

Every expression in Weave denotes a morphism. The primary structuring
operator is `>>>` (sequential composition), which is left-associative and has
the lowest precedence.

```
expr     ::= pipeline
pipeline ::= step (">>>" step)*
step     ::= atom
           | caseExpr
           | foldExpr
           | buildExpr
           | fanoutExpr
           | overExpr
           | letExpr
           | performExpr
           | "(" expr ")"
atom     ::= name               -- defined morphism or constructor
           | name "(" schemaArg ("," schemaArg)* ","? ")"
                               -- schema instantiation of a higher-order def
           | projection         -- ".fieldName"
           | literal            -- Int, Text, Bool, Float literals

schemaArg ::= name ":" expr
```

**Parentheses** are used for grouping subexpressions where a single morphism
is expected but the expression is a pipeline. They carry no semantic weight
beyond grouping. The one narrow extension to this rule is **schema
instantiation**: after the name of a higher-order `def`, a parenthesised
named morphism-argument list instantiates the schema. This form is
distinguished from plain grouping by the presence of at least one `name:`
pair inside the parentheses — a colon does not appear in the standalone
expression grammar, so there is no ambiguity. `f(x)` without a `name:` pair
is not valid Weave; `(f >>> g)` is grouping only.

**Infix operators** (`+`, `-`, `*`, `==`, `&&`, etc.) are surface sugar for
named morphisms applied via `fanout` and composition. They are permitted
within expression bodies for readability. Infix operator precedence follows
standard mathematical convention and is resolved **before** `>>>` — so
`a + b >>> f` parses as `(a + b) >>> f`, not `a + (b >>> f)`. The expression
`a + b` within a `{ fields } >>>` scope, where `a` and `b` are in-scope
names, desugars to `fanout { l: a, r: b } >>> add`. The full operator-to-
morphism mapping (`+` → `add`, `*` → `mul`, `==` → `eq`, etc.) is defined
in the Prelude; the surface language only specifies the desugaring shape.

---

## 7. `build` and `fanout`

### Load-bearing distinction

These two constructs both produce record-shaped outputs, but they denote
entirely different categorical structures. Confusing them is a type error;
the compiler enforces the distinction.

> **`build` is closed and unit-sourced.**
> **`fanout` is input-derived.**
> Local scoped names introduced by `{ fields } >>>` or `let` are not closed
> values; they may be used in `fanout` but not in `build`.

### `build` — closed record construction

```weave
build { field1: expr1, field2: expr2, ... }
```

`build` is a source node: a morphism from unit `1`. Every field expression
must be **closed** — it must not reference any name introduced by a
`{ fields } >>>` destructor or a `let` binding. Field expressions may be
literals, globally defined names, nullary constructors, or nested closed
`build` expressions.

```weave
-- valid: all fields are closed
def origin : Point =
  build { x: 0.0, y: 0.0 }

-- valid: nested build
def defaultConfig : Config =
  build { host: "localhost", port: 8080, tls: build { enabled: False } }
```

`build {}` is the unit value.

A `build` expression whose field expressions refer to ambient scoped names is
a **compile-time error**. Use `fanout` instead.

### `fanout` — shared-input record construction

```weave
fanout { field1: f, field2: g, ... }
```

`fanout` takes a single input and applies each branch morphism to it,
producing a record. It desugars to `dup >>> (f *** g *** ...)`. Every branch
receives the same input.

`fanout` is the correct form whenever field expressions reference the current
input — including scoped names from `{ fields } >>>` or `let`:

```weave
-- takes a User input, derives two output fields from it
fanout { label: .name, score: .score }

-- inside a { head, tail } >>> scope: head and tail are input-derived
{ head, tail } >>>
  fanout { head: head >>> transform, tail } >>> Cons
```

**Shorthand:** In `fanout { field: name }`, if the field name and the binding
name are the same, the explicit form `tail: tail` may be written as the
shorthand `tail`. This shorthand is only valid when `tail` refers to a name
already in scope from a `{ fields } >>>` destructor or a `let` binding — it
is not valid for globally defined names, which have no ambient input to
project from. The shorthand expands to `tail: tail`; the projection semantics
of that name come from the enclosing `{ fields } >>>` scope, not from the
shorthand itself.

---

## 8. `case` and `fold`

`case` and `fold` share identical surface structure. The semantic distinction
— `fold` recurses catamorphically while `case` eliminates without recursion —
is enforced by the type system, not by syntax.

Both are first-class morphism expressions and may appear anywhere a `step` is
expected. They do not syntactically require a preceding `>>>` — they can be
named, passed as higher-order arguments, or appear as the body of a `def`.

**Typing invariant common to both:** Every branch handler is a morphism from
its constructor's payload type to the shared result type `A`. All branches in
a single `case` or `fold` must unify to the same output type `A`. There is no
silent union promotion — if branches produce different types naturally, they
must be explicitly wrapped in a new variant constructor. The output of `case`
and `fold` is always a concrete type, never an implicit union.

### `case` — coproduct eliminator

```weave
case {
  Label1: handler1,
  Label2: { field1, field2 } >>> handler2,
  Label3: handler3,
}
```

Each branch is `Label: handler`. The handler for a **nullary constructor** is
a bare expression (a morphism from `1` to the result type `A`). The handler
for a **record-payload constructor** begins with a `{ fields } >>>` destructor
that binds the payload fields, followed by the handler body — a morphism from
the payload record type to `A`.

```weave
-- branches unify to Text
fetchResult >>> case {
  Ok:  { value } >>> value >>> formatUser,
  Err: { error } >>> error >>> formatError,
}

-- standalone named morphism
def handleResult : Result e a -> Output ! sequential =
  case {
    Ok:  { value } >>> display,
    Err: { error } >>> logAndFail,
  }
```

### `fold` — catamorphism over an ADT

Surface syntax is identical to `case`. The key semantic invariant: in any
recursive branch, the recursive field arrives as the **already-folded result**
— the result type `A`, not the raw sub-ADT. The branch handler is an algebra
over the base functor; it cannot inspect or re-enter the recursion.

```weave
xs >>> fold {
  Nil:  0,
  Cons: { head, tail } >>> head + tail
}
```

Here `tail` is of type `Int` (the result type), not `List Int`. This is what
makes `fold` a true catamorphism and guarantees termination.

### `case .field` — field-focused coproduct elimination

```weave
case .k {
  Tag1: handler1,
  Tag2: { field1, field2 } >>> handler2,
}
```

`case .field` is a field-focused variant of `case`. Where plain `case` has type
`Σ -> A`, `case .field` has type `{ k: Σ | ρ } -> A`. It eliminates a
variant-typed field from a record while giving each branch handler access to the
surrounding record context.

**Semantics — eliminate then extend.** `case .k` first removes field `k` from
the input record, producing the context row `ρ = R \ {k}`. It then matches on
the value of `k` and merges the constructor payload into `ρ` to form the branch
input:

- **Nullary constructor `Tag_i`**: branch handler receives `ρ` (the context row
  alone; no payload to merge).
- **Record-payload constructor `Tag_i { f1: A1, ... }`**: branch handler receives
  `merge(Pi, ρ)`. The field sets of `Pi` and `ρ` must be disjoint; a field name
  collision is a call-site type error.

Field `k` is not available inside any branch. It has been eliminated. A branch that
needs the value of `k` must reconstruct it explicitly.

```weave
-- filter: branch on pred result while preserving head and tail
Cons: { head, tail } >>>
  let passed = head >>> pred in
  case .passed {
    True:  fanout { head, tail } >>> Cons,
    False: tail,
  }
```

In the `True` and `False` branches, the input type is `{ head: a, tail: List a }` —
the context row after `passed` has been eliminated. Both `head` and `tail` are
directly accessible.

**Typing rule:**

```
R = { k: Σ | ρ }    ρ = R \ {k}    Σ = Tag_i Pi
∀i.  h_i : merge(Pi, ρ) -> A ! ε_i     (h_i : ρ -> A when Pi = Unit)
     fields(Pi) ∩ fields(ρ) = ∅
-------------------------------------------------------------------
case .k { Tag_i: h_i } : R -> A ! (⊔_i ε_i)
```

**Effect rule:** `effect(case .k { ... }) = ⊔_i effect(h_i)`. The construct itself
introduces no effects; all effects come from branch handlers.

**First-class morphism.** Like `case` and `fold`, `case .field` may appear as the
body of a `def`, as an inline pipeline step, or as a higher-order argument.

**Single field only.** The field selector is a single `.name`. Nested paths
(`case .a.b`) are not valid in v1. Nested elimination is expressible by sequencing:
`{ outer } >>> outer >>> case .inner { ... }`.

**Composition with `let`.** `let` and `case .field` are designed to compose
naturally. `let x = compute in case .x { ... }` introduces a derived field `x` into
the current product context; `case .x` then eliminates it, giving each branch the
surrounding structure. The `let` elaboration's live set computation threads
surrounding fields through automatically — no explicit `fanout` required.

**Symmetry with `over`.** `case .field` is the elimination counterpart to `over .field`:

| Construct      | Input              | Output             | Role                            |
|----------------|--------------------|--------------------|---------------------------------|
| `over .k f`    | `{ k: A \| ρ }`   | `{ k: B \| ρ }`   | Transform field, preserve shape |
| `case .k { }` | `{ k: Σ \| ρ }`   | `A`                | Eliminate field, expose context |

**`fold .field` does not exist.** The field-selector form is defined only for
`case`. `fold` operates on a complete recursive ADT and performs carrier
substitution throughout that ADT's recursive structure. There is no `fold .field`
form in v1. To fold a recursive field inside a record, project that field, apply
`fold`, and reconstruct any surrounding context explicitly.

### Trailing commas

Trailing commas in `case` and `fold` bodies are permitted and recommended.
They aid diff-friendliness, copy-paste safety, and LLM generation.

---

## 9. `over` — Field-Local Transform

```weave
over .fieldName transform
```

`over` applies `transform` to a single named field of a record, passing all
other fields through unchanged. It is row-polymorphic in the remaining fields:

```
over .name f : { name: A | ρ } -> { name: B | ρ } ! ε
```

where `ε` is the effect level of `f`. Effect propagation:

```
effect(over .name f) = effect(f)
```

`over` contributes no effects of its own; it inherits the effect level of the
transformer it applies.

`transform` may be any single `step`-level expression of the appropriate
type. A pipeline expression used as a handler must be grouped in parentheses,
because `over` binds its second argument as a `step`, not a full `pipeline` —
this prevents `over .score clamp >>> next` from being ambiguously parsed as
`over .score (clamp >>> next)` rather than `(over .score clamp) >>> next`.
For inline complex handlers, use parentheses:

```weave
user >>> over .score clamp
user >>> over .name (fanout { first: .firstName, last: .lastName } >>> joinName)
user >>> over .address ({ street, city } >>> formatAddress)
```

Multiple fields are updated by chaining `over`:

```weave
user
  >>> over .score clamp
  >>> over .name trim
  >>> over .email normalise
```

There is no multi-field simultaneous `over` in v1. If coordinated multi-field
update is required, use `fanout` with record reconstruction explicitly.

**Note:** `.fieldName` in `over .fieldName` is part of `over` syntax, not
postfix field access on a term variable. There is no `u.name` value-variable
syntax in Weave. The only field access mechanism is projection (`.name` as a
morphism) or binding via `{ fields } >>>`.

---

## 10. `let` — Local Derived Bindings

`let` introduces a local name for a derived expression within a scoped
context. It is syntactic sugar over `fanout`.

### Syntax

```weave
let name = expr in
body
```

### Scope restriction

`let` is only valid:
- inside a `{ fields } >>>` destructor scope, or
- nested inside another `let`

`let` is not a top-level binding form. There is no top-level `let`.

### Names introduced by `let` are not closed values

A `let`-bound name inside a `{ fields } >>>` scope is an input-derived binding
relative to the current morphism input. It is not a closed value. Consequently:

- `let`-bound names may appear in `fanout { ... }` field expressions
- `let`-bound names may **not** appear in `build { ... }` field expressions (compile-time error)

### Elaboration

`let x = e in body` elaborates as follows. Let `v1, ..., vn` be the names
free in `body` that come from the ambient `{ fields } >>>` or outer `let`
scope (the *live set*), excluding `x` itself. The elaborated form is:

```
fanout { x: e, v1: .v1, ..., vn: .vn } >>> body
```

The passthrough fields `v1: .v1, ..., vn: .vn` re-emit all live names as
projections from the shared input, making them available to `body` alongside
the new binding `x`. The elaborator computes the live set automatically; no
explicit passthrough syntax is required at the surface.

**Effect propagation:**

```
effect(let x = e in body) = effect(e) ⊔ effect(body)
```

The effect of a `let` expression is the join of the effect of the RHS and the
effect of the body. This follows directly from the `fanout` desugaring, where
effect level is the join of all branch expressions.

### Duplication rule

`let x = e in body` is valid for any expression `e`. If `x` appears more than
once in `body`, the elaboration requires duplicating `e`. Duplication is only
valid if `e` is **discardable** (equivalently, pure in v1). Single use of `x`
in `body` imposes no effect constraint on `e`.

In practice: a `let` binding whose RHS has non-pure effects can be used
exactly once; using it twice or more is a compile-time error. The "appears
more than once" check is a conservative surface approximation; the precise
semantic criterion, stated in the elaboration document, is whether the
elaborated graph duplicates the result of `e`.

### Example

```weave
def filter (pred : a -> Bool ! pure) : List a -> List a ! pure =
  fold {
    Nil:  Nil,
    Cons: { head, tail } >>>
      let passed = head >>> pred in
      case .passed {
        True:  fanout { head, tail } >>> Cons,
        False: tail,
      },
  }
```

Here `passed` is used once (as the discriminant field eliminated by `case .passed`);
`pred` need not be checked for discardability on that account. `head` and `tail` come
from the `{ head, tail } >>>` destructor and are threaded through by `let`'s live set
computation — they are directly accessible in both branch handlers.

---

## 11. `perform` — Explicit Effect Invocation

`perform` marks an explicit call to a declared effect operation. It is the
only mechanism by which a pipeline acquires a non-pure effect level.

### Syntax

```weave
perform qualifiedName
```

`perform op` is a morphism whose input type, output type, and effect level are
determined entirely by the declared type of `op`. `perform` itself contributes
no type information; it is a syntactic marker that an effect operation is
being invoked.

### Usage in pipelines

```weave
userId >>> perform Http.get >>> parseBody

def fetchUser : UserId -> User ! sequential =
  perform Http.get >>> parseUser

def logEvent : Event -> Unit ! parallel-safe =
  perform Logger.write
```

### What `perform` is not

- Not a general side-effect escape hatch
- Not an IO primitive
- Not analogous to Haskell's `IO` type or a `do`-block continuation
- Not a handler or interception mechanism; there is no continuation capture
  or resumption in v1

Effect operations are declared with `effect` at the top level of any module
(see §4). The surface syntax for `perform` is complete with
`perform qualifiedName`.

---

## 12. Complete Worked Example — List ADT

```weave
module Example.List

-- ------------------------------------------------------------
-- Type declaration
-- ------------------------------------------------------------

type List a =
  | Nil
  | Cons { head: a, tail: List a }


-- ------------------------------------------------------------
-- sum : List Int -> Int
-- ------------------------------------------------------------

def sum : List Int -> Int =
  fold {
    Nil:  0,
    Cons: { head, tail } >>> head + tail,
  }


-- ------------------------------------------------------------
-- map : (a -> b ! ε) -> List a -> List b ! ε
-- ------------------------------------------------------------

def map (f : a -> b ! ε) : List a -> List b ! ε =
  fold {
    Nil:  Nil,
    Cons: { head, tail } >>>
      fanout { head: head >>> f, tail } >>> Cons,
  }


-- ------------------------------------------------------------
-- filter : (a -> Bool ! pure) -> List a -> List a ! pure
-- ------------------------------------------------------------

def filter (pred : a -> Bool ! pure) : List a -> List a ! pure =
  fold {
    Nil:  Nil,
    Cons: { head, tail } >>>
      let passed = head >>> pred in
      passed >>> case {
        True:  fanout { head, tail } >>> Cons,
        False: tail,
      },
  }


-- ------------------------------------------------------------
-- length : List a -> Int
-- ------------------------------------------------------------

def length : List a -> Int =
  fold {
    Nil:  0,
    Cons: { head: _, tail } >>> tail + 1,
  }


-- ------------------------------------------------------------
-- head : List a -> Maybe a
--   returns None for empty list, Some for non-empty
-- ------------------------------------------------------------

type Maybe a =
  | None
  | Some { value: a }

def safeHead : List a -> Maybe a ! pure =
  case {
    Nil:  None,
    Cons: { head, tail: _ } >>>
      fanout { value: head } >>> Some,
  }
```

**Notes on the examples:**

- `_` in `{ head: _, tail }` is a wildcard field binder — it records that the
  field is present in the payload shape but introduces no local name for it.
  It does not discard a computation; it omits a binding for a pure projection.
  The projection `.head : { head: A | ρ } -> A ! pure` is always pure by the
  spec's typing rule, so the omission is always structurally valid regardless
  of what type `A` is. No duplication occurs, so no discardability constraint
  applies.
  More precisely: `_` does not bind the projection at all — it is choosing
  not to introduce a name for a pure projection, not dropping a computation.
  The discardability constraint applies to morphisms being dropped from
  pipelines, not to projections that are never bound. This distinction matters
  if the effect system evolves in v2.
- `tail + 1` in `length` uses infix syntax as sugar for
  `fanout { l: tail, r: 1 } >>> add`.
- `map` uses `fanout` (not `build`) because `head >>> f` and `tail` both
  reference scoped bindings from `{ head, tail } >>>`.
- `filter` uses `let` to name the predicate result once, avoiding the need
  for an explicit `fanout` to carry `head` and the predicate result
  simultaneously.

---

## 13. Grammar Appendix (EBNF)

```ebnf
-- Top level
module      ::= "module" modulePath import* topDecl*
modulePath  ::= Name ("." Name)*
import      ::= "import" modulePath
topDecl     ::= typeDecl | defDecl | effectDecl

-- Types
typeDecl    ::= "type" TypeName typeParam* "=" "|"? ctorDecl ("|" ctorDecl)*
typeParam   ::= name
ctorDecl    ::= CtorName
              | CtorName recordType

defDecl     ::= "def" name defParam* ":" typeExpr ("!" effectLevel)? "=" expr
defParam    ::= "(" name ":" typeExpr ")"

effectDecl  ::= "effect" name ":" typeExpr "!" effectLevel

-- Type expressions
typeExpr    ::= arrowType
arrowType   ::= typeTerm ("->" typeExpr ("!" effectLevel)?)?
typeTerm    ::= TypeName typeAtom*
              | recordType
              | "(" typeExpr ")"
typeAtom    ::= TypeName | name | "(" typeExpr ")"

recordType  ::= "{" fieldType ("," fieldType)* ("," rowVar)? "}"
rowVar      ::= "|" name
fieldType   ::= name ":" typeExpr

effectLevel ::= "pure" | "parallel-safe" | "sequential" | name

-- Expressions
expr        ::= pipeline
pipeline    ::= step (">>>" step)*
step        ::= atom
              | caseExpr
              | foldExpr
              | buildExpr
              | fanoutExpr
              | overExpr
              | letExpr
              | performExpr
              | "(" expr ")"

atom        ::= name
              | name "(" schemaArg ("," schemaArg)* ","? ")"
              | CtorName
              | projection
              | literal

schemaArg   ::= name ":" expr

projection  ::= "." name

-- Constructs
buildExpr   ::= "build" "{" buildField ("," buildField)* ","? "}"
buildField  ::= name ":" expr

fanoutExpr  ::= "fanout" "{" fanoutField ("," fanoutField)* ","? "}"
fanoutField ::= name ":" expr
              | name                    -- shorthand: name: name

caseExpr    ::= "case" ("." name)? "{" branch ("," branch)* ","? "}"
foldExpr    ::= "fold" "{" branch ("," branch)* ","? "}"
branch      ::= CtorName ":" handler
handler     ::= expr                                  -- nullary constructor
              | "{" fieldBinders "}" ">>>" expr       -- record-payload constructor
fieldBinders ::= fieldBinder ("," fieldBinder)*
fieldBinder  ::= name
               | name ":" "_"

overExpr    ::= "over" projection step

letExpr     ::= "let" name "=" expr "in" expr

performExpr ::= "perform" qualifiedName
qualifiedName ::= Name ("." Name)*

-- Literals
literal     ::= intLit | floatLit | textLit | boolLit
intLit      ::= [0-9]+
floatLit    ::= [0-9]+ "." [0-9]+
textLit     ::= '"' [^"]* '"'
boolLit     ::= "True" | "False"

-- Lexical
name        ::= [a-z_][a-zA-Z0-9_']*
Name        ::= [A-Z][a-zA-Z0-9_']*
```

---

## Appendix A: Decisions Not in v1

The following are explicitly deferred to v2 and should not appear in v1 source
programs or implementations:

- Open/row variants (extensible tagged unions)
- Positional (unnamed) constructor payloads
- `{ user: { name } }` nested destructuring in `{ fields } >>>` binders
- `{ head as x }` field renaming in binders
- `{ head, ...rest }` rest/spread binders
- Multi-field simultaneous `over`
- Anonymous inline functions / lambdas
- `trace`-style general recursion
- Paramorphisms, histomorphisms, and other recursive schemes beyond `fold`
- Top-level `let` / `val` definitions separate from `def`
- Module system features beyond flat import (qualified imports, `hiding`, `as`)
- Algebraic effect handlers, handler scopes, and continuation capture (`handle` construct)
- Effect operation declaration syntax beyond signatures (e.g. inline implementation bodies)

---

## Appendix B: Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Composition operator | `>>>` primary | Spec invariant; pipeline-first |
| Unit in signatures | Elided; elaborator inserts `1 ->` | Surface/core split; values feel like values |
| Constructor payloads | Named record fields only | Uniformity with `over`, projections, `{ fields } >>>` |
| Branch binding form | `{ fields } >>>` always | Keeps branch handlers as morphisms |
| `build` restriction | Closed/unit-sourced only | Preserves `build`/`fanout` semantic distinction |
| `fanout` scope | Input-derived; ambient names allowed | Correct denotation for shared-input construction |
| Effect annotation | Required non-pure; optional `! pure` assertion | Salience for effectful boundaries; lightweight pure code |
| `let` purity rule | Semantic (duplicate iff used twice) | Blanket restriction prohibits valid single-use sequential |
| Grouping syntax | Parentheses (expression only), with narrow schema instantiation extension | `over` with inline handlers requires grouping; schema instantiation is named, not positional |
| Delimiters | Explicit `{}` everywhere | LLM-friendly, copy-paste safe, no significant whitespace |
| Trailing commas | Permitted | Diff-friendly, consistent with modern tooling |
| `case`/`fold` syntax | Identical surface structure | Reduce cognitive load; distinction is type-level only |
| `case .field` syntax | `case ("." name)? { ... }` | Symmetric with `over .field`; minimal grammar extension; field-qualified form of existing construct; no new keyword |
| `effect` declarations | Top-level signatures in any module; standard import/namespacing | Keeps type info in source where typechecker can see it; no separate manifest format |
| `effect` runtime binding | External to the language | v1 has no handler or scope construct; implementation map supplied at program entry |
| `parallel-safe` semantics | Semantic contract (commutativity); runtime permitted but not required to exploit | Sequential interpreter is valid; annotation enables scheduling optimizations |
| Schema instantiation syntax | Named argument list: `f (p: e, ...)` | Named over positional; mirrors def-site binder names; no new keyword; unambiguous with grouping |
| Schema instantiation semantics | Definition-level substitution before elaboration | Meta-level operation; no new core form; any well-typed morphism expression is a valid argument |
