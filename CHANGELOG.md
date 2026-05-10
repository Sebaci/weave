# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Golden IR snapshot tests (`test/golden/`) covering `fold`+`let`, `case .field`, `fanout`, and `build` constructs. Snapshots lock down graph shape, port types, node kinds, wiring, and provenance (including recursively through nested branch and algebra graphs). Exact def-key assertions guard against unexpected elaborated definitions leaking into the module.

---

## [0.10.3] - 2026-05-10

### Added
- Spec-driven test suite (`test/spec/`) covering §7–§11 of the Weave spec: `build`, `fanout`, `let`, `case`, `case .field`, and `fold`. 27 tests encoding the exact rules from the spec, including effect propagation, exhaustiveness, duplication constraints, field collision, carrier-type substitution, and the `case`/`fold` semantic distinction.

### Fixed
- `fold` over multi-recursive ADTs (e.g. `type Tree = Leaf | Node { left: Tree, right: Tree }`): the typechecker now correctly propagates the carrier type to all recursive field positions when the carrier is already concrete, so `left + right` in a `fold Tree → Int` handler type-checks correctly.

---

## [0.10.2] - 2026-05-10

### Fixed
- Schema instantiation effect precision: the typechecker now correctly computes the instantiated effect for higher-order defs, accounting for forward references and nested schema instantiation. Schema defs are checked in topological dependency order so that each schema's intrinsic body effect is known before any def that instantiates it is checked. Schema instantiation cycles (self or mutual) are now rejected with a clear `E_SCHEMA_CYCLE` error rather than silently accepted with an incorrect effect.

---

## [0.10.1] - 2026-05-07

### Fixed
- IR validation: `CataNode` branch input type is now checked with exact equality against the substituted payload type (IR-6), and `CaseNode` field branches are checked with exact equality against `merge(Pi, ρ)` (IR-6b)
- IR validation: `DupNode` outputs are no longer exempt from the one-outgoing-wire rule (IR-2)
- Elaborator: schema instantiation now inserts a `DupNode` when multiple arguments consume the same input port, preventing implicit sharing (IR-2)
- Parser: grouped multi-step pipelines now produce a clear error instead of silently emitting a malformed AST

### Changed
- `src/compiler.ts` is now a Node-free core entry point (parse, typecheck, elaborate, interpret); `src/compiler-host.ts` extends it with filesystem module resolution for Node.js consumers
- `applySubst` / `Subst` moved from `src/typechecker/unify.ts` to `src/types/subst.ts`

---

## [0.10.0] - 2026-05-04

### Added
- `weave repl`: interactive session for loading and exploring Weave programs. Commands: `:load <file>`, `:reload`, `:run <name> [--input '<json>'] [--effect op=builtin ...]`, `:type <name>`, `:show <name>`, `:defs`, `:effects`, `:effect <op>=<builtin>`, `:help`, `:quit` / `:q`. Session effect bindings persist across `:run` calls. `:effects` deduplicates ops across multi-module programs.
- Inline expression evaluation at the REPL prompt: type any unit-sourced expression directly (e.g. `build { x = 1 }`, a reference to a loaded def, a pipeline) and the REPL evaluates and prints the result. Expressions are wrapped as a synthetic unit-sourced def, run through the full pipeline (parse → typecheck → elaborate → interpret), and discarded — they do not persist in session state. Typing a top-level keyword (`def`, `type`, `effect`, `module`, `import`) at the prompt produces a clear error explaining that statement forms are not supported in inline eval.

---

## [0.9.0] - 2026-05-03

### Added
- `weave run --effect <op>=<builtin>`: explicitly bind a declared Weave effect operation to a named host implementation. Weave files declare effect signatures; the CLI binds them to real I/O at run time. Example: `--effect App.load=readFile --effect App.save=writeFile`.
- Built-in effect library: `print` (Text → Unit, sequential), `readFile` (Text → Text, sequential), `writeFile` ({path: Text, content: Text} → Unit, sequential), `getEnv` (Text → Text, parallel-safe).
- `print` remains auto-bound (backward compatibility). `readFile`, `writeFile`, and `getEnv` require explicit `--effect` to prevent silent capability grants.
- Binding validation: the CLI checks that the built-in's input type, output type, and effect level are compatible with the declared effect signature in the Weave file. Incompatible bindings are rejected with a clear error before interpretation starts.
- Unknown op names in `--effect` (typos, undeclared ops) are caught and reported.

---

## [0.8.0] - 2026-05-02

### Added
- `weave run --input '<json>'`: supply a structured input value to any monomorphic def, not just Unit-input ones. The decoder is type-directed — it walks the expected Weave type and validates the JSON simultaneously, so errors report both the expected Weave type and the exact JSON path where the mismatch occurred.
- ADT JSON encoding: flat tagged-object `{ "tag": "Ctor", ...payload-fields }`. Constructor payloads are always named records in Weave, so all payload fields appear alongside `"tag"` at the top level. Nullary constructors use `{ "tag": "Ctor" }` with no extra fields.
- Lists and all other ADTs are encoded the same way — no special syntax. `[1, 2, 3]` as `List Int` is `{"tag":"Cons","head":1,"tail":{"tag":"Cons","head":2,"tail":{"tag":"Cons","head":3,"tail":{"tag":"Nil"}}}}`.
- `"tag"` is reserved as the ADT discriminator. A constructor with a payload field named `"tag"` produces a clear decode error rather than silent corruption.
- Arity check: parameterized types with the wrong number of type arguments (unsaturated) are rejected before decoding rather than partially substituted.
- Defs that expect non-Unit input but receive no `--input` flag now produce a helpful error showing the expected type and the flag to use.

---

## [0.7.1] - 2026-05-01

### Fixed
- VS Code extension is now installable from a fresh clone without manual steps. `npm run build:ext` installs extension dependencies and compiles; `npm run package:ext` produces a self-contained `.vsix`. Teammates install via **Extensions: Install from VSIX...** in VS Code.
- Both the extension host and LSP server are now fully bundled (esbuild CJS), so the VSIX requires no `node_modules` at install time.
- `npm run lsp` (tsx dev path) works correctly: the `createRequire` pattern is preserved for Node ESM compatibility with the CJS `vscode-languageserver` package, while the CJS bundle suppresses the `import.meta` warning via `--define`.
- `.vscodeignore` ensures only the compiled outputs, grammar, and language configuration are shipped — no source, tsconfig, or stale build artefacts.

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
