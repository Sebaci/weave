# CLAUDE.md

This repository implements **Weave v1**.

The specification documents in `docs/spec/` are the **source of truth**.
If code and spec diverge, the spec wins — always call out discrepancies explicitly.

### Spec documents (`docs/spec/`)

| File | Content |
|------|---------|
| `weave-spec-v1.md` | Core language semantics and type system |
| `weave-surface-syntax-v1.md` | Surface syntax grammar (§13 EBNF) |
| `weave-ir-v1.md` | Graph IR structure and validation rules |
| `weave-elaboration-rules-v1.md` | Typed AST → IR elaboration rules |

---

## Language & Tooling

* Implementation language: **TypeScript**
* Prefer:

  * strict typing (`strict: true`)
  * algebraic data types via tagged unions
  * immutable data structures
* Avoid:

  * `any`
  * implicit coercions
  * mutation unless clearly justified

---

## Core Architecture

The implementation is strictly layered:

1. Surface AST (parse + IDs)
2. Typechecker (unification, produces typed AST)
3. Elaboration (typed AST → Graph IR, no inference)
4. IR (fully explicit graph)
5. Interpreter (evaluation of IR)

Do not blur boundaries between these phases.

---

## Non-Negotiable Invariants

### Typing & Elaboration

* Elaboration operates on a **fully typed AST**
* Elaboration performs **no unification or inference**
* IR contains **only fully concrete types**

  * no row variables
  * no effect variables

### Graph Semantics

* Sequential composition is represented by **wiring**, not nodes
* There is **no ComposeNode**
* All sharing is explicit via **DupNode**

### Core Constructs

* `build` and `fanout` are **categorically distinct**
* `perform` is:

  * an **opaque external call**
  * not a handler
  * not a continuation
* `EffectNode` is the **only effectful primitive**

### Higher-order

* Higher-order `def`s are **schema-like**, not runtime function values
* Schema instantiation:

  * is **definition-level binding/substitution**
  * does **not** produce a new IR node
  * is **not general function application**

### Recursion

* `fold` is a **true catamorphism**
* Recursive branches receive **already-folded results**
* `CataNode` is a **semantic special case** in the interpreter

### Provenance

* Every AST node has a **stable ID assigned at parse time**
* Every IR node carries **provenance**
* Provenance is **never reconstructed later**

---

## Effects

* Effects are **tracked, not interpreted**
* Effect levels:

  * `pure`
  * `parallel-safe`
  * `sequential`
* `parallel-safe` is a **semantic contract**, not a hint
* Runtime binding of effects is **external**

---

## Implementation Rules

* Do not “fill in” missing semantics silently
* When spec is unclear:

  * choose minimal consistent behavior
  * document the assumption
* Prefer clarity over cleverness
* Keep modules small and focused

---

## Validation

Where practical:

* enforce invariants with runtime checks
* fail early on invalid IR
* do not allow malformed graphs to propagate

---

## Workflow

For non-trivial changes:

1. Summarize relevant spec constraints
2. Propose structure (types / modules / APIs)
3. Wait for review if architecture is affected
4. Implement
5. Explain how invariants are preserved

---

## Development Strategy

### Incremental Changes (Required)

All work must be done in **small, reviewable steps**.

Do not:
- implement multiple major subsystems in one pass
- perform large refactors without prior proposal
- combine unrelated concerns (e.g. CLI + module system + VS Code)

Always:

1. Propose a minimal next step
2. Implement only that step
3. Stop and summarize:
   - what was added
   - how to test it
   - what the next step is

### Step Size Guideline

A single step should be roughly:

- one new module or file
- or one CLI command
- or one well-contained feature (e.g. diagnostics formatting)

If a change touches many parts of the system, it must be split.

---

## Release Workflow

### Commits

Commit freely during development. Use conventional commits (`feat:`, `fix:`, `chore:`, `test:`).
Keep commit messages short — one line, under ~72 characters. The subject line is not a changelog; save detail for the CHANGELOG entry.
Commits do **not** automatically trigger a version bump.

### Version bumps

A version bump marks a **stable, reviewed state** — not a commit count.
Bump once per step, **after** any Codex review is resolved and the step is complete.

Guidelines:
- `patch` — a step is done and reviewed: a new command, a new feature, a targeted fix. Most steps qualify.
- `minor` — a meaningful milestone is crossed: multiple steps combine into something a user would describe as a cohesive capability (e.g. "CLI fully usable", "language core complete"). Explicitly agreed with the user, not automatic.
- `major` — `1.0.0` marks a mature, stable implementation of Weave v1. Reserved for when the language and toolchain are considered complete and solid.

When bumping:
1. Update `package.json` version
2. Add a `CHANGELOG.md` entry — describe what the step **delivers to users**, not implementation details or review fixes
3. Commit version + changelog together (code may be in prior commits)

Never bump without a changelog entry, and never update the changelog without bumping.

### Codex Reviews

After completing a step (before the version bump), suggest a Codex review to the user.

- **Standard review** (`/codex:review`) — CLI, tooling, infrastructure
- **Adversarial review** (`/codex:adversarial-review`) — core semantics (typechecker, elaborator, interpreter, IR)

Do **not** invoke the review automatically. Instead:
1. State which review type is appropriate and why
2. Present the suggested prompt for the user to run

Always include this preamble in the prompt:

```
Read CLAUDE.md for architectural constraints and invariants that apply to this codebase.
Read docs/weave-implementation-notes-v1.md for canonical decisions not in the spec.
The spec documents in docs/spec/ are the source of truth if anything in the code conflicts with them.
```

Address Codex findings in follow-up commits before bumping. Spec always wins over implementation decisions.

---

## Tooling Layers

The compiler core (`parser`, `typechecker`, `elaborator`, `ir`, `interpreter`)
is the foundation.

Higher-level layers (CLI, module system, language service, editor tooling)
must be built **on top**, without breaking core invariants.

Do not entangle:
- CLI logic with compiler internals
- editor concerns with core phases

---

## What to Avoid

* Do not introduce:

  * hidden implicit behavior
  * magical transformations
  * shortcuts that bypass IR structure
* Do not reinterpret the spec into a different paradigm
* Do not “functionalize” the language (no accidental currying model)

---

## Guiding Principle

Weave is a **typed graph language with explicit structure**.

If something feels like:

* implicit control flow
* hidden state
* runtime function passing

…it is probably wrong for v1.

--

## Implementation Notes

See `docs/weave-implementation-notes-v1.md` for decisions that are not specified in the spec but must be treated as canonical for this codebase.

These decisions override ambiguity in the spec and must be followed consistently.

After completing each major implementation step (type system, surface AST, typechecker, elaborator, interpreter), append any non-obvious decisions made during that step to `docs/weave-implementation-notes-v1.md` under the appropriate section. Record:

* choices that could reasonably have gone another way
* surprising constraints discovered during implementation (e.g. import locations, pre-scan requirements)
* invariants the next phase depends on
* anything a future reader would need to know to avoid re-making the same mistakes

Do not record things already derivable from the code or spec.
