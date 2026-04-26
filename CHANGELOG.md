# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
