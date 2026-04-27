# Weave v1 — Implementation Notes

> **Status:** Canonical for this codebase.
> These decisions are not derived from the four spec documents. They resolve
> ambiguity, fill underspecified gaps, or record choices that could reasonably
> have gone another way. They must be followed consistently. If a decision here
> conflicts with the spec, the **spec wins** and this document must be updated.

---

## 1. Implementation Language

TypeScript, strict mode (`strict: true`, `noUncheckedIndexedAccess: true`).
Module format: NodeNext ESM (`.ts` import extensions, `"type": "module"`).
No `any`. No implicit coercions. Immutable data by default; mutation only where
clearly justified and documented.

---

## 2. Type ADT (`src/types/`)

### 2.1 Row variables are not standalone Type nodes

Row variables (`ρ`) appear only as `Record.rest: string | null`.
They are not a `Type` constructor. A row variable cannot stand alone as a type —
it always appears as the tail of a record, which matches its semantic role
(ranging over field sets, not types).

### 2.2 Effect variables are not standalone Type nodes

Effect variables (`ε`) appear only in `EffectLevel`, which annotates `Arrow.eff`.
`EffectLevel = ConcreteEffect | { tag: "EffVar"; name: string }`.
`EffVar` is not a `Type` constructor and cannot appear elsewhere in the type
structure.

### 2.3 Named type representation covers both constructors and applications

`{ tag: "Named"; name: string; args: Type[] }` represents both a bare type
constructor (`Named("List", [])`) and a fully applied one (`Named("List", [TInt])`).
Kinding (saturation checks) is the typechecker's responsibility, not the ADT's.

### 2.4 typeEq is purely structural — no alpha-equivalence

`typeEq` compares type variable names literally. `TyVar("a")` ≠ `TyVar("b")` even
if both are uninstantiated in a context where they are alpha-equivalent.
Callers (especially `substAdt`) must ensure types are properly instantiated before
invoking `typeEq` for matching purposes.

### 2.5 substAdt checks for a match before recursing

`substAdt(ty, adtTy, carrier)` checks `typeEq(ty, adtTy)` at the current node
first, then recurses into sub-nodes. This handles the case where the ADT type
appears nested inside a type application (e.g. `List (Tree a)` — `Tree a` is
matched inside the args of `List`).

### 2.6 substRowVar appends expansion fields after existing fields

When row variable `ρ` is expanded to a concrete field list, the new fields are
appended *after* the record's existing explicit fields. Field order is
declaration/occurrence order; expansion fields are always last.

### 2.7 effectLevelJoin with unresolved EffVar is conservative

When joining `EffVar` with a concrete effect:
- If the concrete side is `"sequential"`, return `"sequential"` (upper bound wins).
- Otherwise return the `EffVar` (treat it as a lower bound pending resolution).

When joining two *distinct* `EffVar`s: return `"sequential"` (maximally conservative).
When joining two *identical* `EffVar`s: return the shared `EffVar`.

The typechecker is responsible for resolving all `EffVar`s before elaboration.
`effectLevelJoin` with `EffVar`s is only valid during type inference; the result
must never appear in IR port types.

### 2.8 isConcrete is the IR boundary enforcer

Every `Port.ty` in the IR must satisfy `isConcrete`. The elaborator checks this
at construction time. A type is concrete iff it contains no `TyVar`, no `Record`
with `rest !== null`, and no `EffVar` in any `Arrow.eff`.

---

## 3. Surface AST (`src/surface/`)

### 3.1 Stable IDs use a module-level counter; format is opaque

`freshId()` returns `"n_<counter>"` where the counter is a module-level integer.
IDs are globally unique within a compilation session. The counter must **not** be
reset between files in the same session — resets (`resetIdCounter()`) apply only
between entirely independent parse sessions (e.g. in tests).
The format `"n_42"` is opaque; no other module may parse or structurally depend on it.

### 3.2 Expr is always Pipeline — no special singleton form

`type Expr = { tag: "Pipeline"; steps: Step[]; meta: NodeMeta }`.
A single-step expression is `Pipeline { steps: [s] }`.
Parser invariant (not structurally enforced in the type): `steps.length >= 1`.
There is no `Singleton` or `Step` alias for `Expr`.

### 3.3 SurfaceEffect reuses EffectLevel directly

`SurfaceEffect = EffectLevel` (re-exported from `src/types/type.ts`).
No parallel surface-level effect type is defined. Any change to `EffectLevel`
propagates to the surface AST automatically.

### 3.4 BaseType vs Named resolved at parse time

The parser resolves the five builtin type names — `Int`, `Float`, `Bool`, `Text`,
`Unit` — to `{ tag: "BaseType" }` directly. All other uppercase names become
`{ tag: "Named" }`. The typechecker maps `Named("Int", [])` → `TInt` as a fallback
for aliases, but the canonical parse of a builtin type is always `BaseType`.

### 3.5 True and False are Literal nodes, not Ctor nodes

Despite starting with an uppercase letter and matching the `CtorName` lexical rule,
`True` and `False` are parsed as `{ tag: "Literal"; value: { tag: "bool"; ... } }`,
not as `{ tag: "Ctor" }`. The parser special-cases them before the general
uppercase-name rule.

### 3.6 FanoutField shorthand is preserved in the surface AST

`fanout { tail }` (shorthand for `tail: tail`) is stored as
`{ tag: "Shorthand"; name: "tail" }` in the surface AST. The typechecker expands
it to `{ tag: "Field"; name: "tail"; expr: pipeline(stepName("tail")) }` using
scope information. The parser does not expand shorthand.

### 3.7 Infix nodes are desugared by the typechecker

`Infix` nodes survive from parsing into the pre-typed surface AST and are desugared
during typechecking, not during parsing. The typechecker uses the fixed v1 builtin
operator table (see §4.2). Desugaring produces a `Fanout` of the two operands
composed with a `Name` reference to the corresponding morphism. The operator table
is implicitly available — no `import Prelude` is required to use infix operators.

### 3.8 Parentheses produce no AST node

Parentheses affect parse-time precedence only. No `Grouped` or `Paren` node exists
in the surface AST. After parsing, `(expr)` is indistinguishable from `expr`.

### 3.9 DefDecl stores the full typeExpr plus a separate outer eff

From the grammar: `defDecl ::= "def" name defParam* ":" typeExpr ("!" effectLevel)? "=" expr`.

- `DefDecl.ty` is the full parsed `typeExpr`. For `def f : A -> B ! ε`, `ty` is
  `Arrow(A, B, ε)` with the effect embedded. For `def f : B ! ε` (unit-sourced),
  `ty` is the plain output type `B`.
- `DefDecl.eff` carries the outer `! effectLevel` annotation — present only for
  non-arrow `ty` (unit-sourced defs). It is `null` when `ty` is already an `Arrow`
  or when effect is to be inferred as pure.

The typechecker reconciles both positions and rejects double annotation (arrow with
embedded effect AND an outer annotation on the same def).

### 3.10 EffectDecl stores decomposed input/output types

`EffectDecl` stores `inputTy`, `outputTy`, `eff` separately rather than a single
`ty: SurfaceType`. The parser decomposes the mandatory arrow at parse time.
The typechecker validates that `eff ≠ "pure"` and registers the declaration in `Ω`.

### 3.11 Wildcard binder preserves the field name

`{ tag: "Wildcard"; name: string }` keeps the field name so the typechecker can
verify the field exists in the constructor payload type. The name is never
introduced into `Γ_local`; it is used solely for field-presence checking.

### 3.12 Perform.op is string[] — casing not enforced in AST

`Perform.op: string[]`, e.g. `["Http", "get"]`. Module parts are expected to be
uppercase and operation names lowercase (per naming conventions), but the AST
does not enforce this — the typechecker validates the qualified name against `Ω`.

### 3.13 Module paths are string[]

`Module.path` and `Import.path` are `string[]`, e.g. `["Collections", "List"]`.
Dot-separated module paths are split at parse time; the AST carries the parts, not
the joined string.

### 3.14 build {} is the surface representation of the unit value

An empty `Build([])` step is the surface unit value. It elaborates to
`ConstNode { tag: "unit" }` in the IR. There is no standalone `unit` literal token.

---

## 4. Typechecker (decisions recorded as they are made)

### 4.1 Case and Fold are keyword-directed, not type-directed — CORRECTED

**Previous (wrong) decision:** the typechecker used `isFold = hint === "fold" || info.isRecursive`,
forcing any `case` over a recursive ADT to become a catamorphism. This was retracted
because it directly contradicts the spec.

**Correct rule (spec §10–11):**

`case` is a coproduct eliminator on any closed variant `Σ`. Branch payload types
are always raw (`Pi`). `tail` in a `Cons` branch over `List Int` has type `List Int`.

`fold` is a catamorphism requiring a recursive ADT (`μF`). Branch payload types
are `Pi[A/μF]` — recursive positions carry the already-folded carrier `A`.
`tail` in a `Cons` branch over `List Int → Int` has type `Int`.

`fold` on a non-recursive ADT is a type error. `case` on a recursive ADT is
valid and gives single-level coproduct elimination — the programmer sees raw
recursive fields, not pre-folded results.

The distinction is enforced by the surface keyword alone. The two constructs
elaborate to `CaseNode` and `CataNode` respectively; they cannot silently
swap based on whether the ADT happens to be recursive.

### 4.2 Fixed v1 builtin infix operator table

The operator-to-morphism mapping is a fixed table implicit in the typechecker.
No explicit import is required. Unknown operators are a type error.
All builtin operators are pure.

| Operator | Morphism | Input record type | Output type |
|----------|----------|-------------------|-------------|
| `+`  | `add` | `{ l: Int, r: Int }` or `{ l: Float, r: Float }` | same as inputs |
| `-`  | `sub` | `{ l: Int, r: Int }` or `{ l: Float, r: Float }` | same as inputs |
| `*`  | `mul` | `{ l: Int, r: Int }` or `{ l: Float, r: Float }` | same as inputs |
| `/`  | `div` | `{ l: Int, r: Int }` or `{ l: Float, r: Float }` | same as inputs |
| `==` | `eq`  | `{ l: a, r: a }` | `Bool` |
| `!=` | `neq` | `{ l: a, r: a }` | `Bool` |
| `<`  | `lt`  | `{ l: Int, r: Int }` or `{ l: Float, r: Float }` | `Bool` |
| `>`  | `gt`  | `{ l: Int, r: Int }` or `{ l: Float, r: Float }` | `Bool` |
| `<=` | `leq` | `{ l: Int, r: Int }` or `{ l: Float, r: Float }` | `Bool` |
| `>=` | `geq` | `{ l: Int, r: Int }` or `{ l: Float, r: Float }` | `Bool` |
| `&&` | `and` | `{ l: Bool, r: Bool }` | `Bool` |
| `\|\|` | `or`  | `{ l: Bool, r: Bool }` | `Bool` |

Desugaring: `a OP b` → `fanout { l: a, r: b } >>> morphismName`.
The morphism name is looked up by the typechecker, not the elaborator.

### 4.3 DefParam.ty must be an Arrow type

The typechecker rejects any `DefDecl` whose `DefParam.ty` is not an `Arrow`
surface type. The surface AST permits any `SurfaceType` in param position;
the restriction is a type error.

### 4.4 Schema instantiation arg matching: by name, all-or-nothing, no extras

`f (p1: e1, p2: e2, ...)` is validated as follows:
- Every declared parameter must have a corresponding named argument.
- No extra arguments are permitted.
- Order is irrelevant; matching is by name.
- Missing or extra arguments are type errors (not warnings).

### 4.5 let live-set ordering is left-to-right first occurrence

The live set `L` for `let x = e in body` is ordered by the first occurrence of
each name under left-to-right lexical traversal of `body`. This matches the
elaboration spec §9 and determines field order in the intermediate record type `R'`.
The elaborator relies on this ordering being stable and reproducible.

### 4.6 Infix desugaring happens in checkExpr, not checkStep

`checkStep` returns a single `TypedStep`. Desugaring `a OP b` requires two steps
(Fanout + Ref), so the Infix case is handled directly in `checkExpr`'s step-loop
via `handleInfix`. `checkStep` never receives an `Infix` node; if it does, it is
an internal error. One surface `Infix` step expands to exactly two `TypedStep`s
in the output pipeline, both sharing the same `sourceId`.

### 4.7 effectJoin is exported from src/types/check.ts, not src/types/type.ts

`effectJoin(a, b): ConcreteEffect` and `effectLevelJoin(a, b): EffectLevel` live
in `src/types/check.ts`. Importers (including `unify.ts` and `check.ts`) must
import from `"../types/check.ts"`, not `"../types/type.ts"`.

### 4.8 Type declaration pre-scan resolves self-referential and mutually recursive types

`buildEnv` registers a stub `TypeDeclInfo` entry for every type name in the module
before resolving any constructor payloads. This allows `resolveSurfaceType` to
accept self-referential types (e.g. `List a` inside `Cons`'s payload) and
forward references between type declarations. The stubs are replaced in-place with
fully resolved entries during the second pass.

### 4.9 Constructor references use Ctor steps, not Name steps

In the surface AST, uppercase identifiers used as values (e.g. `Nil`, `Cons`,
`Some`) are `Ctor` steps. The typechecker's `Name` case resolves only locals
(`Γ_local`) and global defs. Constructor references must be `stepCtor(name)`;
using `stepName(name)` for a constructor is a type error ("Undefined name").

---

## 5. Elaborator (decisions recorded as they are made)

### 5.1 Elaborator reads Case/Fold from the typed AST tag

By the time the elaborator runs, the typechecker has tagged each construct as
`TypedCase` or `TypedFold` in the typed AST. The elaborator reads the tag directly
and does not re-examine input types.

### 5.2 substAdt is called with fully instantiated types

Before calling `substAdt` for a `Fold` branch, the elaborator holds the fully
instantiated `adtTy` (e.g. `Named("List", [TInt])`, not `Named("List", [TyVar("a")])`).
Both `adtTy` and carrier type `A` are post-unification; no type variables remain.

---

## 6. IR (decisions recorded as they are made)

### 6.1 Graph.effect is computed eagerly at construction

`Graph.effect` is the join of all contained node effects, computed when the graph
is constructed (not lazily on demand). This enables fast effect-guarded rewrite
rejection without full graph traversal.

### 6.2 Port IDs are unique within a graph, not globally

`PortId` uniqueness is scoped to the containing graph. Nested graphs (branch graphs
in `CaseNode`, algebra graphs in `CataNode`) have independent port ID namespaces.

### 6.3 IR validation runs eagerly in v1

IR invariants IR-1 through IR-8 (from `weave-ir-v1.md` §6) are checked by a
dedicated `validateGraph` function called eagerly after each graph is constructed.
v1 treats this as always-on. A future optimization may make it opt-in.

---

## 7. Interpreter (decisions recorded as they are made)

### 7.1 CataNode is the only node requiring recursive descent

All other node types evaluate in a single topological pass (inputs → outputs in
dependency order). `CataNode` requires bottom-up traversal of the ADT value at
runtime and must not be evaluated via plain dataflow. This is a known, documented
special case at the IR boundary.

### 7.2 Effect dispatch uses a caller-supplied runtime binding map

The interpreter accepts `RuntimeBindings: Map<OpRef, (input: Value) => Value>`
supplied at program entry. `EffectNode.op` is looked up in this map at evaluation
time. Unknown `OpRef`s at runtime are interpreter errors, not type errors (the
typechecker validates `OpRef` membership in `Ω` statically).

### 5.3 substTypedHandler applies the final substitution from checkCaseOrFold

After the per-branch unification loop in `checkCaseOrFold`, a `finalBranches` pass
applies the accumulated `subst`/`effSubst` to every `Type` inside each branch's
`TypedHandler`. This is done via `substTypedHandler` → `substTypedExpr` →
`substTypedStep` → `substTypedNode`, which walks the full typed-AST tree.
Without this pass, fold branches retain `TyVar(carrierVar)` in their payload types
and morph annotations, causing IR-7 violations (non-concrete port types).

### 5.4 Polymorphic defs are skipped during module-level elaboration

`elaborateModule` calls `hasTypeVar` on each def's `morphTy`. Defs that have any
`TyVar` in their signature are skipped entirely — they appear in `TypedModule` but
not in `ElaboratedModule.defs`. They are elaborated only at `SchemaInst` call sites
with a concrete `tySubst`. As a consequence, elaborator tests for polymorphic
constructs (length, safeHead) must use monomorphic signatures.

### 5.5 DupNode is inserted only at names used more than once

`allocateLocalPort` counts uses of each name in a branch handler. If a name is used
exactly once, the existing port is reused directly with no `DupNode`. A `DupNode`
with `n` output ports is inserted only when a name is used `n > 1` times.

---

## 8. Interpreter (decisions recorded during Stage 5)

### 8.1 Evaluation is demand-driven (lazy memoisation), not topological sort

Rather than pre-computing a topological order of nodes, `evalGraph` uses a
`getValue(portId)` function that memoises results in a `portValues` map.
When a port has no cached value, it follows wires back to their source and
evaluates the producing node recursively. This avoids building an explicit
dependency graph and naturally handles graphs where some nodes are unreachable.

### 8.2 Builtin morphisms are resolved before the def map

`RefNode`s with `defId` in `{ add, sub, mul, div, lt, gt, leq, geq, eq, neq, and, or }`
are resolved via a static `BUILTIN_MORPHISMS` table in `eval.ts`, not from
`ElaboratedModule.defs`. This is correct because these names are emitted by
the typechecker's infix desugaring but are not elaborated as Weave defs.
If a future `def add : ...` is written by the user, it would shadow the builtin.

### 8.3 CataNode uses constructor-set membership for recursion detection

The catamorphism evaluator detects recursive substructures by checking if a
variant value's constructor name appears in the algebra's branch set (the set
of tags covered by the `CataNode`). This avoids needing type information at
runtime but assumes that constructor names uniquely identify the ADT within a
given CataNode scope — which is guaranteed by the typechecker's exhaustiveness
check and the closed-variant invariant.

### 8.4 DropNode evaluates its input for potential effects

`evalNode` for `DropNode` calls `getValue(node.input.id)` before setting the
output to `VUnit`. This preserves effect ordering — a `perform` node feeding
into a `DropNode` still executes. In a pure-only interpreter this could be
skipped, but v1 must preserve the correct effect semantics.

---

## 9. Parser (`src/parser/`)

### 9.1 Hand-rolled recursive descent with precedence climbing

The parser is a single-class recursive descent parser (`Parser` class in
`parse.ts`) over a flat token stream from the lexer. Infix operators use
precedence climbing (`parseInfix(minPrec)`) with six levels: `||`(1),
`&&`(2), `==`/`!=`(3), `<`/`>`/`<=`/`>=`(4), `+`/`-`(5), `*`/`/`(6).
`>>>` is handled at the pipeline level above all infix, not in the climbing
table — it splits a sequence of steps into composition.

### 9.2 `parallel-safe` is three tokens, not an IDENT

The effect level `parallel-safe` contains a hyphen, which the lexer tokenizes
as MINUS. `parseEffectLevel` handles this explicitly: when it sees
`IDENT("parallel")` followed by `MINUS`, it consumes both tokens plus
`IDENT("safe")` to form the level. All other positions where MINUS appears
are arithmetic operators, so no ambiguity arises from this rule.

### 9.3 Effect decl input type must use `parseTypeTerm`, not `parseTypeExpr`

`parseEffectDecl` parses `effect name : inputTy -> outputTy ! effLevel`.
The input type must be parsed with `parseTypeTerm` (not `parseTypeExpr`)
because `parseTypeExpr` is right-recursive on `->` and would consume
`Int -> Int ! sequential` as a single Arrow type, eating the `->` that
separates input from output. Using `parseTypeTerm` stops before `->`.

### 9.4 `{` at handler position always means RecordHandler

Inside `fold { ... }` and `case { ... }` branch bodies, a `{` always starts a
`RecordHandler` (binders list). This is unambiguous because no Weave
expression starts with a bare `{` — the expression-level constructs that use
`{` are always preceded by a keyword (`build`, `fanout`).

### 9.5 Fanout shorthand requires a bound local name

`fanout { f }` (shorthand, no `:`) parses as `Shorthand { name: "f" }` in the
surface AST. The typechecker resolves this as a LocalRef to `f`, which must be
bound in `env.locals`. Shorthand is therefore only valid inside a destructor
handler scope (e.g. `{ head, tail } >>> head + tail`). Using it at the
top-level of a def body — where there are no locals — is a type error. Tests
that need arithmetic on the input must use a handler or fold context.

### 9.6 IR-2 violation in elaborator: `locals` queue, not single PortId

Multiple uses of the same local name (`x + x`) require distinct DupNode
outputs. The fix: `ElabContext.locals` is `Map<string, PortId[]>` (a queue).
`allocateLocalPort` returns `PortId[]` (one per anticipated use). Each
`LocalRef` pops the front element via `shift()`. The use-count is computed
ahead of time with `countUsesInTypedExpr`.

### 9.7 rPrime record in let elaboration needs DupNode for projections + body input

`elabLet` builds an intermediate record `rPrime = { x: rhsOut, v1: ..., vk: ... }`
and then (a) projects each field to create locals, and (b) passes `rPrime` as
the body's piped input. Both uses require outgoing wires from `rPrime`. The fix:
create a DupNode with `tupleInputs.length + 1` outputs — one per projection
plus one for the body input — so no port has multiple outgoing wires (IR-2).

### 9.8 norm_I Case B must thread the DropNode's output port, not the original input

`elabNormI` Case B fires when a unit-sourced expression is used in a non-unit
input context (spec §5: `(! >>> m)`). `liftUnit` returns the DropNode's Unit
output port. That port — not the original `inputPortId` — must be passed to
`elabExpr`. Passing `inputPortId` instead wires the original non-unit port to
both the DropNode input and the downstream expression input, which violates IR-2
(a port may have at most one outgoing wire per consumer).

The previous code had `void droppedPort` followed by `elabExpr(expr, inputPortId, ...)`,
effectively discarding the DropNode output and creating the IR-2 violation.

### 9.9 checkBuild must record morphTy.input = inputTy, not Unit

`build` is semantically unit-sourced (`1 → T`), but when it appears in a pipeline
context the typechecker sees the actual contextual input type `inputTy` (which may be
non-unit). `checkBuild` must record `{ input: inputTy, ... }` in both return sites
(empty and non-empty), exactly as `checkLiteral` does.

Without this, `elabBuild` calls `liftUnit(inputPortId, step.morphTy.input, ...)` with
`step.morphTy.input = { tag: "Unit" }`, which hits the early-return no-op in `liftUnit`
and never emits the required DropNode (`! : I → 1`). The graph's `inPort` becomes
dangling — no node consumes it — which is an IR structural violation.

`elabBuild` itself does not need to change: the `liftUnit` calls already pass
`step.morphTy.input`, and now that `morphTy.input` carries the real contextual type,
the DropNode is emitted correctly whenever needed.

### 9.10 ElabContext.paramPorts is a PortId[] queue, not a single PortId

Schema params are elaborated as arg expressions at the SchemaInst call site. If
the same param is referenced n times in the def body, each use is a `Ref` node
that, at elaboration time, must be wired to a distinct output port — otherwise
n wires leave the same source port, violating IR-2.

Fix: `ElabContext.paramPorts` is `Map<string, PortId[]>` (a queue). For each
param, `elabSchemaInst` counts how many `Ref` nodes with that `defId` appear in
the substituted body, calls `allocateLocalPort` to create a DupNode with that
many outputs, and stores the resulting queue. Each `Ref` lookup via `.shift()`
consumes one port from the front.

The count is computed by `countParamRefUses` — a mirror of `countUsesInTypedExpr`
that visits `Ref` nodes by `defId` instead of `LocalRef` nodes by `name`. The
same recursive structure (Build/Fanout/Case/Fold/Over/Let/SchemaInst) is needed
because param refs can appear inside nested sub-expressions.

### 9.11 collectLocalNames in checkBuild must recurse into SchemaInst args

`collectLocalNames` detects ambient local references inside `build` field
expressions (the closedness check). A `SchemaInst` step passes arg expressions
that may reference locals; without the SchemaInst case, those references slip
through undetected, allowing closed-form violations to pass the typechecker.

Fix: add `if (step.tag === "SchemaInst") step.args.forEach((a) => visitExpr(a.expr));`
to the `visitStep` in `collectLocalNames` in `src/typechecker/check.ts`.

### 9.12 TypedBranch carries rawPayloadTy for type-directed fold recursion

`TypedBranch.payloadTy` for fold branches is the POST-substitution payload:
recursive positions hold the carrier type `A` instead of the ADT type `μF`.
This is the right input for the branch handler, but the wrong guide for deciding
which positions to recurse into during evaluation.

Fix: add `rawPayloadTy: Type` to `TypedBranch` — the pre-substitution payload
(`instantiatedPayload ?? Unit` from `checkCaseOrFold`), where recursive positions
still hold `adtTy`. This is always concrete (instantiated from the ADT's concrete
type arguments) so no further substitution is needed when storing it.

The field propagates through all TypedBranch reconstruction sites
(`checkCaseOrFold`, `substTypedNode` in both `check.ts` and `elab.ts`,
`substBranch` in `elab.ts`) and into `CataNode.algebra` entries
(`{ tag, rawPayloadTy, graph }`).

### 9.13 Fold recursion is type-directed, not constructor-set-directed

The previous `evalCata` used `ctorSet.has(v.ctor)` to detect recursive
sub-values. This is wrong for parametric recursive types: `fold over List (List Int)`
has `Nil`/`Cons` constructors shared by both the outer list and any inner `List Int`
values. The inner lists would be incorrectly folded.

Fix: `evalCata` now takes `adtTy: Type` (from `CataNode.adtTy`). `foldPayload`
is type-directed: it recurses based on the raw payload type structure, folding
only at positions where `typeEq(rawTy, adtTy)` is true. For record payloads, it
walks field-by-field using the raw payload type's field list. Non-recursive leaves
are returned as-is.

### 9.14 IR-6 validation now checks that adtTy is absent from branch inPort types

The previous `checkCataSubstitution` only checked `isConcrete(branch.graph.inPort.ty)`.
This is too weak — a branch could have a concrete inPort type that still contains
`adtTy` (if the carrier substitution was not applied).

Fix: add `typeStructurallyContains(branch.graph.inPort.ty, node.adtTy)` check.
`typeStructurallyContains` uses `typeEq` for leaf comparison and recurses into
`Named.args`, `Record.fields`, and `Arrow.from`/`to`. A positive result means
the elaborator failed to substitute the carrier for the ADT at recursive positions.

### 9.15 CaseNode carries variantTy and outTy to match spec

The spec (weave-ir-v1.md §CaseNode) defines `variantTy: Type` and `outTy: Type`
on `CaseNode`. The implementation previously omitted them. They are redundant with
`input.ty` and `output.ty` but are required by the spec for structural completeness
and for tooling that reads the IR directly. `CataNode` had its analogous fields
(`adtTy`, `carrierTy`) from the start; `CaseNode` now matches. Populated in
`elabCase` from `step.morphTy.input` and `step.morphTy.output`.

### 9.16 DropNode.output is a necessary extension not in the spec

The spec defines `DropNode` with no output port (`! : I -> 1`, `1` implicit).
The implementation adds `output: Port` (always `Unit`-typed) for two reasons:

1. Uniform traversal: `nodePorts` and `outputPortIds` iterate all output ports of
   every node kind. A missing output on DropNode would require a special case.

2. norm_I Case B: the elaboration rule `(! >>> m)` requires threading the Unit
   value from the DropNode to the next node's input. This is represented as a wire
   from `droppedPort` (DropNode's output) to the downstream node's input. Without
   an output port, this wire cannot be expressed.

The spec's DropNode definition is inconsistent with the norm_I elaboration rule.
The implementation's `output: Port` resolves the inconsistency. For ConstNode and
TupleNode (which are implicitly unit-sourced and have no explicit input port), the
DropNode output remains unconnected — this is a structural consequence of those
nodes not having wirable input ports, not a graph error.

### 9.18 build field expressions require a real unit ConstNode as input source

`elabBuild` elaborates each field expression in a fresh sub-context with a unit
input. The original code created a raw port ID (`mkPort({tag:"Unit"}).id`) as the
input port. For field expressions that are `Ref` nodes (e.g., def references like
`origin`), the elaborator wires this ID to the Ref's input port. Since the raw ID
has no producer node, this caused IR-1 validation failures ("wire references unknown
port").

Fix: for each build field, create a real `ConstNode` (value: unit) in the
sub-builder before elaborating the field expression. The ConstNode's output port is
used as the unit input. For literal fields, the ConstNode's output is never wired
(literals are self-contained ConstNodes), which is a harmless dangling output.

### 9.19 The spec's filter example is inconsistent with the elaboration rules

The surface-syntax spec (§10 and §12) presents a `filter` function that uses
`let passed = head >>> pred in passed >>> case { True: fanout { head, tail } >>> Cons, ... }`.
Inside the nullary case branches (`True:`, `False:`), `head` and `tail` from the
outer `{ head, tail } >>>` scope are referenced.

However, the elaboration spec (§10 case) explicitly states:
> **Nullary `Tagi`:** `hi` elaborated under `(Γ_global, Γ_local = {})`.
> Outer `Γ_local` entries are ill-typed in handler contexts and rejected.

So outer locals from the `let` scope are inaccessible inside nullary case branches.
The spec's filter example is self-contradictory: it presents code that violates the
elaboration rules it defines.

The implementation correctly follows the elaboration rules (outer locals are
inaccessible in handler contexts). The `let.weave` example demonstrates `let` with
a pattern that is actually valid: naming an intermediate computation inside a fold
branch body that doesn't involve a nested case dispatch.

### 9.17 Effect variables in def params are not supported in v1

`resolveEffLevelFinal` previously silently converted any unresolved `EffVar`
to `"pure"`. This meant a param declared `f: a -> b ! ε` would be stored as
`f: a -> b ! pure`. Effect substitution at the call site never updated the
stored `eff: "pure"` on the param's morphTy, so a schema instantiated with a
`sequential` function would report `pure` — breaking the `parallel-safe` semantic
contract (spec §4.4: "parallel-safe is a semantic contract, not a hint").

Fix: `resolveEffLevelFinal` now returns a type error when an `EffVar` is
encountered. Effect polymorphism on def params requires threading `EffVar` through
`MorphTy.eff: ConcreteEffect`, which is a type system change beyond v1 scope.
In v1, def params must carry a concrete effect annotation.
