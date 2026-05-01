# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.7.0] - 2026-05-01

### Added
- LSP server (`src/lsp/server.ts`): diagnostics are published to the editor on file open and save. Parse errors, type errors, and import-resolution errors all appear as squiggles with correct file/line/column locations.
- VS Code extension now activates as a language client: launches the bundled LSP server (`editors/vscode/out/server.mjs`) via IPC and streams diagnostics for all `.weave` files.
- `npm run bundle:lsp` produces a self-contained ESM bundle of the LSP server at `editors/vscode/out/server.mjs`, usable without `tsx`.
- Diagnostics track the full module graph: when a file is saved, all files in its import closure are checked and their diagnostics updated. Files that leave the graph (e.g. after an import is removed) are cleared automatically, including in multi-entry and shared-dependency scenarios.

---

## [0.6.0] - 2026-05-01

### Added
- VS Code extension skeleton (`editors/vscode/`): registers `.weave` files as the Weave language and provides TextMate grammar for syntax highlighting.
- TextMate grammar covers all keywords (`module`, `import`, `type`, `def`, `effect`, `case`, `fold`, `build`, `fanout`, `over`, `let`, `in`, `perform`, `pure`, `parallel-safe`, `sequential`), type/constructor names, `def` function names, boolean and numeric literals, string literals, line comments (`--`), and all v1 operators (`>>>`, `->`, `==`, `!=`, `<=`, `>=`, `&&`, `||`, `/`, and single-character operators).
- Language configuration: comment toggling (`--`), bracket matching and auto-close for `{}` and `()`.

---

## [0.5.0] - 2026-05-01

### Added
- Structured diagnostics: `weave check --json` emits machine-readable errors with `code`, `phase`, `file`, `span`, and `message` fields.
- Error codes: every diagnostic now carries a stable code (`E_TYPE`, `E_PARSE`, `E_UNDEFINED_NAME`, `E_MODULE_NOT_FOUND`, etc.) for use by tooling and scripts.
- Full source spans on errors: each error carries `span.start` and `span.end` (line/column), not just a point location.
- Source snippets with caret (`^^^`) pointing at the offending token, with correct alignment for tab-indented source (8-stop tab expansion).

---

## [0.4.1] - 2026-05-01

### Changed
- Error messages now include a source snippet with a `^^^` caret pointing at the offending column. Applies to parse errors, type errors, and import-resolution errors.

---

## [0.4.0] - 2026-05-01

### Added
- `weave run` now works across multiple modules. A def in the entry file can call defs imported from other modules; the full import graph is elaborated and executed together.
- Qualified def names (`Foo.Bar.baz`) are now the canonical form inside the IR. `Ref` and `SchemaInst` nodes always carry the fully-qualified def ID, eliminating bare-name collisions between unrelated modules during elaboration.
- Builtin infix operator morphisms (`+`, `-`, `*`, etc.) now use reserved `builtin.*` def IDs in the IR, preventing any user-defined def from shadowing them regardless of name or module structure.

---

## [0.3.1] - 2026-04-30

### Added
- Qualified name resolution: `Foo.Bar.baz` in a pipeline body is now parsed as a single `Name` reference and resolved against the imported module's exported defs. Both qualified (`Foo.Bar.baz`) and bare (`baz`) access continue to work when unambiguous.

---

## [0.3.0] - 2026-04-30

### Added
- Module system: `import Foo.Bar` resolves to `Foo/Bar.weave` relative to the entry file's directory.
- Module graph: full transitive import closure is parsed and cycle-detected before typechecking begins. Import cycles produce a clear error showing the full cycle path.
- Multi-module type environment: imported modules are typechecked in dependency order; their exported type declarations, constructors, effect operations, and defs are seeded into the importing module's `CheckEnv`. `weave check` now works end-to-end across multiple files.
- Unqualified def access: defs from imported modules are available under their bare name (e.g. `origin` from `module Shapes`). Qualified names (e.g. `Shapes.origin`) are also seeded, ready for qualified-access resolution in a future step.
- Ambiguity detection: importing two modules that export the same bare constructor, type, or def name is a hard error with a descriptive message.
- Type errors in any module in the import graph are reported with the correct file path and source location.

---

## [0.2.0] - 2026-04-29

### Added
- `case .field` — field-focused coproduct eliminator: eliminates a variant-typed field from a record while exposing the surrounding context to each branch handler. Type: `{ k: Σ | ρ } -> A`. Nullary branches receive `ρ`; record-payload branches receive `merge(Pi, ρ)`.
- `case .field` fully wired through all phases: parser, typechecker, typed AST, IR (`CaseNode.field` / `CaseNode.contextTy`), elaborator, and interpreter.
- `filter.weave` — `let` + `case .field` pattern: keeps elements satisfying a predicate without explicit fanout threading of surrounding fields.
- `caseField.weave` — `case .field` branching on a record-payload variant with context row access.
- Bug fix: `collectFreeLocalNames` now correctly tracks fanout shorthand fields (`{ head, tail }`) in the live set for `let` elaboration. Previously, shorthand fanout in let-body was invisible to the live set computation, causing the filter pattern to be inexpressible.
- Bool (`True` / `False`) may now be used as the discriminant type in `case .field`; it is treated as a builtin two-constructor variant.

---

## [0.1.9] - 2026-04-28

### Added
- `let.weave` — let binding inside a fold branch (`sumOfDoubles`)
- `over.weave` — field-local transform with chained `over` (`widen`, `scale`, `area`)
- `build.weave` — unit-sourced record construction, runnable with `weave run` (`origin`, `unitBox`)

### Fixed
- `build` fields that reference a named def (e.g. `build { topLeft: origin }`) now elaborate correctly; the elaborator was creating a raw port ID with no producer node, causing IR-1 validation failures
- `NullaryHandler` branch bodies now receive the constructor's payload type as input, not `Unit`; this lets `over`, projections, and other record-typed steps work directly in binderless case branches (e.g. `Rect: over .width f >>> Rect`)
- Elaborator branch graphs for binderless record-payload handlers now carry the correct input port type in the IR, consistent with the spec

---

## [0.1.8] - 2026-04-26

### Added
- Seven example programs covering the core language surface:
  `sum.weave` (fold), `length.weave` (fold + Bool carrier), `pipeline.weave` (fanout + `>>>` composition),
  `maybe.weave` (Maybe ADT + schema param), `safeHead.weave` (non-recursive `case`),
  `map.weave` (higher-order fold with type variables), `fanout.weave` (parallel field construction),
  `effects.weave` (effect declaration + `perform` + sequential composition),
  `hello.weave` (minimal effectful entry point)

---

## [0.1.7] - 2026-04-26

### Fixed
- `weave run` now rejects polymorphic/schema defs with a clear diagnostic instead of crashing with an internal interpreter error
- `weave run` now registers host effect bindings under both bare and module-qualified names so `perform print` and `perform Examples.Hello.print` both resolve
- `weave run` no longer prints `()` when the result is `Unit` — effects write their own output; the Unit return value is not displayed

---

## [0.1.6] - 2026-04-26

### Added
- `weave run <file> --def <name>` CLI command: parses, typechecks, elaborates, and interprets a named def that takes `Unit` input
- `MissingEffectHandlerError` in `src/interpreter/eval.ts`: explicit typed error when an `EffectNode` op has no runtime binding
- `HOST_EFFECTS` in CLI: provides a `print : Text -> Unit` binding to `process.stdout`
- `examples/hello.weave`: minimal runnable program exercising the `print` effect end-to-end
- `weave run` rejects defs whose input type is not `Unit` with a clear message showing the actual expected type

---

## [0.1.5] - 2026-04-26

### Fixed
- CLI now rejects extra positional arguments and exits 1 (previously silently ignored them)
- Usage string corrected to `npm run cli -- check <file>` to reflect actual invocation

---

## [0.1.4] - 2026-04-26

### Added
- `src/surface/span-map.ts`: recursive walker over the full surface AST that collects every `NodeMeta.id → NodeMeta.span` into a `ReadonlyMap`
- Type errors in `weave check` now show `file:line:col` via span map lookup (previously showed `file: error: message` with no location)

---

## [0.1.3] - 2026-04-26

### Added
- `weave check <file>` CLI command (`src/cli/index.ts`): reads a `.weave` file, parses it, typechecks it, prints diagnostics, and exits 0 (OK) or 1 (errors)
- Parse errors show `file:line:col:` prefix
- `examples/sum.weave`, `examples/bad.weave`, `examples/parse-error.weave` as manual test fixtures
- `@types/node` dev dependency; `"types": ["node"]` added to `tsconfig.json`

---

## [0.1.2] - 2026-04-26

### Changed
- Migrated test suite from hand-rolled runner to [Vitest](https://vitest.dev/)
- `npm test` now runs `vitest run` with glob-based discovery — no hardcoded file paths
- Extracted shared test fixtures into `src/test-utils.ts` (`listTypeDecl`, `maybeTypeDecl`, `mkList`, `makeAndElab`, `assertOk`, `assertValid`)
- `skipLibCheck: true` added to `tsconfig.json`

### Fixed
- Two parse tests were using `fold` on non-recursive types — corrected to `case`
- Typechecker test `map` was using effect variable `ε` (not supported in v1) — corrected to `pure`

---

## [0.1.1] - 2026-04-26

### Fixed
- `case` and `fold` are now keyword-directed, not type-directed: `fold` on a non-recursive ADT is a type error
- `foldPayload` in the interpreter is now type-directed using `rawPayloadTy` per algebra branch, fixing incorrect recursion for parametric recursive types
- `elabNormI` Case B now wires the DropNode output port correctly
- `checkBuild` now records the real input type (not `Unit`) so `elabBuild` emits a DropNode
- `paramPorts` queue changed from `PortId` to `PortId[]` with DupNode allocation for multi-use params
- `collectLocalNames` now visits `SchemaInst` argument expressions
- `resolveEffLevelFinal` now returns a type error on unresolved `EffVar` (previously silently coerced to `pure`)
- `CaseNode` now carries `variantTy` and `outTy` fields as required by the spec
- IR-6 validation strengthened with `typeStructurallyContains` check

---

## [0.1.0] - 2026-04-25

### Added
- Initial implementation of the Weave v1 compiler core:
  - Parser (`src/parser/`) — surface syntax → AST
  - Surface AST (`src/surface/`) — AST definitions and source identity
  - Typechecker (`src/typechecker/`) — unification, inference, effect checking
  - Elaborator (`src/elaborator/`) — typed AST → Graph IR
  - Graph IR (`src/ir/`) — typed port-based directed graph with validation
  - Interpreter (`src/interpreter/`) — evaluation of Graph IR
  - Type system (`src/types/`) — shared type representations
- Language specification documents (`docs/spec/`)
- Implementation notes (`docs/weave-implementation-notes-v1.md`)
