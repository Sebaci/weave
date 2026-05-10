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
npm install
```

That's it for the CLI. No global install required.

### CLI

```bash
npm run cli -- check <file>                            # parse + typecheck (all imported modules)
npm run cli -- check <file> --json                     # machine-readable JSON diagnostics
npm run cli -- run   <file> --def <name>               # run a Unit-input def
npm run cli -- run   <file> --def <name> --input '<json>'  # run any monomorphic def with structured input
npm run cli -- run   <file> --def <name> [--effect <op>=<builtin>]...  # bind effect ops to host implementations
npm run cli -- repl                                    # interactive REPL
```

Examples:

```bash
npm run cli -- check examples/hello.weave
npm run cli -- run   examples/build.weave --def origin
npm run cli -- run   examples/sum.weave   --def sum --input '{"tag":"Cons","head":1,"tail":{"tag":"Cons","head":2,"tail":{"tag":"Nil"}}}'
```

Multi-module programs work as long as imported files are resolvable relative to the entry file:

```bash
npm run cli -- check examples/main.weave   # resolves import Foo.Bar → examples/Foo/Bar.weave
```

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
  ├── parser/        # surface syntax → AST
  ├── surface/       # AST definitions & surface-level structures
  ├── typechecker/   # typing rules, unification, effect checking
  ├── elaborator/    # typed AST → graph IR
  ├── ir/            # graph IR definitions & validation
  ├── interpreter/   # graph IR evaluation
  ├── module/        # import resolution, module graph, multi-module loader
  ├── types/         # shared type representations
  ├── cli/           # command-line interface
  └── lsp/           # LSP server (diagnostics-on-save for editors)
```

This structure mirrors the language pipeline:

* **parser + surface** → syntax
* **typechecker** → correctness
* **elaborator** → semantics (key phase)
* **ir** → canonical representation
* **interpreter** → execution
* **module** → import resolution and multi-module coordination
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

Current stage: **v0.10.4** — interactive REPL with inline expression evaluation.

* ✅ Language specification (v1)
* ✅ Surface syntax & parser
* ✅ Typechecker (unification, effect checking)
* ✅ Elaboration rules & elaborator (typed AST → Graph IR)
* ✅ Graph IR
* ✅ Interpreter (graph IR evaluation)
* ✅ CLI (`weave check`, `weave run`, `weave run --input`, `weave repl`)
* ✅ Example programs (`let`, `over`, `build`, `fold`, `fanout`, effects, higher-order, `case .field`)
* ✅ Module system — import resolution, cycle detection, multi-module typechecking
* ✅ Qualified name resolution in pipelines (`Foo.Bar.myDef`)
* ✅ `weave run` with imports (multi-module elaboration + interpretation)
* ✅ Structured diagnostics — error codes, source spans, source snippets with caret, `--json` output
* ✅ VS Code extension — syntax highlighting + LSP server with diagnostics-on-save
* ✅ `--input '<json>'` — type-directed JSON input for any monomorphic def
* ✅ `--effect <op>=<builtin>` — bind declared effect ops to host I/O (`readFile`, `writeFile`, `getEnv`, `print`)
* ✅ `weave repl` — interactive session: load files, run defs, evaluate inline expressions, manage effect bindings
* ✅ Spec-driven test suite and golden IR snapshot tests

**Toward 1.0.0:** diagnostics quality, expanded examples, newcomer usability pass.

---

## 🔮 Future Directions

Planned extensions:

* Open variants (row types for unions)
* Advanced recursion schemes
* General recursion (`trace`)
* Algebraic effect handlers
* Graph visualization tools
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
