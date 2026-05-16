# Weave

**Weave** is a typed, composition-first programming language where programs are built as explicit dataflow graphs.

Instead of writing sequences of instructions, you describe **how data flows** through transformations. The structure of computation is not hidden — it is the program.

---

## ✨ What is Weave?

Weave is inspired by ideas from category theory (especially symmetric monoidal categories), but designed to be **practical, readable, and tool-friendly**.

Every program is a composition of morphisms:

```weave
xs >>> fold {
  Nil:  0,
  Cons: { head, tail } >>> head + tail,
}
```

This is not just syntax — it directly corresponds to a **dataflow structure**:

* inputs flow through transformations
* structure is explicit
* effects are visible and controlled

---

## 🧠 Mental Model

If you’re coming from other languages:

* Think **function composition as the default**
* Think **data pipelines, but fully typed**
* Think **graphs instead of control flow**

In Weave:

* Every expression is a morphism `A -> B`
* Values are morphisms from unit: `1 -> A`
* Composition (`>>>`) is the central operator
* Effects are explicit and tracked

---

## 🧱 Core Primitives

Weave has a small set of orthogonal building blocks:

| Construct | Meaning                                       |
| --------- | --------------------------------------------- |
| `>>>`     | Sequential composition                        |
| `fanout`  | Duplicate input into parallel branches        |
| `build`   | Construct values from independent expressions |
| `over`    | Transform a specific field                    |
| `case`    | Branch on variants                            |
| `fold`    | Structural recursion                          |
| `perform` | Invoke effects explicitly                     |
| `let`     | Local binding (graph-based)                   |

---

## ⚡ Effects

Effects are explicit and part of the type system:

* `pure`
* `parallel-safe`
* `sequential`

They are:

* propagated statically
* never implicit
* separate from structural dataflow

---

## 📐 Under the Hood

Weave programs are compiled into a **typed graph IR**:

* Nodes = operations
* Edges = dataflow
* Duplication is explicit
* No hidden evaluation order

Pipeline:

```text
Parse → Typecheck → Elaborate → Graph IR → Interpret
```

---

## 💻 Getting Started

### Prerequisites

* Node.js 18+
* npm

### Setup

```bash
git clone <repo>
cd weave
npm install   # also compiles the weave binary → dist/weave.js
npm link      # make 'weave' available globally
```

After `npm link`, the `weave` command is available in any terminal.

If you prefer not to install globally, you can also run `npm run cli -- <args>` in place of `weave <args>`.

### CLI

```bash
weave check <file>                                    # parse + typecheck (all imported modules)
weave check <file> --json                             # machine-readable JSON diagnostics
weave run   <file> --def <name>                       # run a Unit-input def
weave run   <file> --def <name> --input '<json>'      # run any monomorphic def with structured input
weave run   <file> --def <name> --effect <op>=<builtin>  # bind effect ops to host implementations
weave ir    <file> --def <name>                       # export the elaborated graph IR as JSON
weave repl                                            # interactive REPL
```

Examples:

```bash
weave check examples/hello.weave
weave run   examples/build.weave --def origin
weave run   examples/sum.weave   --def sum --input '{"tag":"Cons","head":1,"tail":{"tag":"Cons","head":2,"tail":{"tag":"Nil"}}}'
weave ir    examples/filter.weave --def keepPositives
```

### REPL

```bash
weave repl
```

Inside the REPL:

```
weave> :load examples/sum.weave
Loaded .../examples/sum.weave

weave> :type sum
sum : List Int -> Int

weave> :run sum --input '{"tag":"Cons","head":1,"tail":{"tag":"Cons","head":2,"tail":{"tag":"Nil"}}}'
3

weave> :load examples/hello.weave
Loaded .../examples/hello.weave

weave> :effect print=print
Bound print = print

weave> :run greet
Hello, Weave!
```

After loading a file, you can also type expressions directly at the prompt:

```
weave> 1 + 2
3
```

Type `:help` for a full command list, `:quit` or `:q` to exit.

### VS Code Extension

The extension provides syntax highlighting and live diagnostics (via LSP) on save.

**Install from a packaged `.vsix`** (recommended for teammates):

```bash
npm run build:ext     # install extension deps + compile
npm run package:ext   # produces editors/vscode/weave-language-*.vsix
```

Then in VS Code: **Extensions → ⋯ → Install from VSIX** and select the generated file.

Or from the terminal:

```bash
code --install-extension editors/vscode/weave-language-*.vsix
```

**Development install** (load the extension directly from source):

1. Run `npm run build:ext` once to compile.
2. Open `editors/vscode/` as a workspace in VS Code.
3. Press `F5` to launch an Extension Development Host with the extension loaded.

---

## 📁 Repository Structure

```text
docs/
  ├── spec/          # language specification (v1)
  └── weave-implementation-notes-v1.md  # canonical decisions not in the spec

editors/
  └── vscode/        # VS Code extension (syntax highlighting + LSP client)

examples/            # runnable Weave programs

src/
  ├── compiler.ts         # public compiler API (browser-safe; no Node.js deps)
  ├── compiler-host.ts    # host abstraction interface (I/O, file resolution)
  ├── parser/             # surface syntax → AST
  ├── surface/            # AST definitions & surface-level structures
  ├── typechecker/        # typing rules, unification, effect checking
  ├── elaborator/         # typed AST → graph IR
  ├── ir/                 # graph IR definitions & validation
  ├── interpreter/        # graph IR evaluation
  ├── module/             # import resolution, module graph, multi-module loader
  ├── types/              # shared type representations
  ├── cli/                # command-line interface (weave check / run / repl)
  └── lsp/                # LSP server (diagnostics-on-save for editors)

test/
  ├── spec/        # spec-driven tests (one test file per language rule)
  └── golden/      # IR snapshot tests (lock graph shape, wiring, provenance)
```

This structure mirrors the language pipeline:

* **parser + surface** → syntax
* **typechecker** → correctness
* **elaborator** → semantics (key phase)
* **ir** → canonical representation
* **interpreter** → execution
* **module** → import resolution and multi-module coordination
* **compiler.ts** → public API consumed by CLI, LSP, and future browser targets
* **cli** → user-facing tooling (built on top of the compiler core)

---

## 🤖 AI-Assisted Development

Weave is also an experiment in **AI-assisted language design and implementation**.

### Design

The language was designed through iterative discussions using:

* ChatGPT
* Claude

These were used to:

* explore design alternatives
* refine semantics and invariants
* stress-test edge cases
* shape the specification

### Implementation

The TypeScript implementation is being developed using:

* Claude Code — primary implementation partner, translating the spec into working code while preserving architectural consistency
* Codex — adversarial reviewer, auditing the implementation against the spec for semantic drift, IR invariant violations, and elaboration correctness

Claude Code and Codex operate as complementary roles: Claude Code implements, Codex challenges. Findings from Codex reviews are cross-checked against the spec (spec always wins), and non-obvious resolution decisions are recorded in `docs/weave-implementation-notes-v1.md`.

---

## 🚧 Status

Current stage: **v1.2.0** — Browser playground with graph view and Core notation.

* ✅ Language specification (v1)
* ✅ Surface syntax & parser
* ✅ Typechecker (unification, effect checking)
* ✅ Elaboration rules & elaborator (typed AST → Graph IR)
* ✅ Graph IR with IR validator
* ✅ Interpreter (graph IR evaluation)
* ✅ CLI (`weave check`, `weave run`, `weave run --input`, `weave ir`, `weave repl`) — installable via `npm link`
* ✅ Example programs (`let`, `over`, `build`, `fold`, `fanout`, effects, higher-order, `case .field`, tree fold, file I/O)
* ✅ Module system — import resolution, cycle detection, multi-module typechecking
* ✅ Qualified name resolution in pipelines (`Foo.Bar.myDef`)
* ✅ `weave run` with imports (multi-module elaboration + interpretation)
* ✅ Structured diagnostics — error codes, source spans, source snippets with caret, `--json` output
* ✅ VS Code extension — syntax highlighting + LSP server with diagnostics-on-save
* ✅ Builtin morphisms: `id`, `not`, `concat`, `<>` operator
* ✅ `--input '<json>'` — type-directed JSON input for any monomorphic def
* ✅ `--effect <op>=<builtin>` — bind declared effect ops to host I/O (`readFile`, `writeFile`, `getEnv`, `print`)
* ✅ `weave repl` — interactive session: load files, run defs, evaluate inline expressions, manage effect bindings
* ✅ Spec-driven test suite and golden IR snapshot tests
* ✅ Public compiler API (`src/compiler.ts`) — browser-safe core, no Node.js dependencies
* ✅ `weave ir` — export elaborated graph IR as stable JSON (normalized IDs, source-map provenance)
* ✅ Browser playground — live editor with SVG graph view (Dagre layout, hover tooltips, provenance highlighting) and Core panel (categorical notation: `>>>`, `dup`, `***`, `drop`, `case`, `cata`)

---

## 🔮 Future Directions

Near-term (1.x):

* **1.3** — Pan/zoom graph, collapsed subgraphs for `case`/`fold`, expandable `ref` nodes
* **1.4+** — Rewrite system; visual rewrite exploration

Language extensions (later):

* Open variants (row types for unions)
* Advanced recursion schemes
* General recursion (`trace`)
* Algebraic effect handlers
* Optimization & rewrite engine

---

## 🎯 Why Weave?

Weave explores a simple idea:

> Programs should look like the structure of computation they describe.

The goal is a language that is:

* easier to reason about
* easier to transform
* easier to visualize
* naturally aligned with tooling and AI

---

## 📜 License

MIT License
