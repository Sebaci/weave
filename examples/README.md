# Weave Examples

Runnable programs that demonstrate the core language constructs.

Run with `npm run cli -- check <file>` and `npm run cli -- run <file> --def <name>`.

---

## Overview

| File | Demonstrates |
|------|-------------|
| `hello.weave` | Unit-input def, sequential effect |
| `sum.weave` | Recursive fold over a list |
| `length.weave` | Two folds on the same type (`length`, `isEmpty`) |
| `pipeline.weave` | Multi-step pipeline with `fanout` and `case` |
| `maybe.weave` | ADT `case` matching, higher-order def |
| `safeHead.weave` | `case` with `Maybe` output |
| `map.weave` | Higher-order `fold` (schema param), concrete `doubleAll` instantiation |
| `filter.weave` | `fold` + `let` + `case .field`, concrete `keepPositives` instantiation |
| `fanout.weave` | Parallel field computation via `fanout` |
| `build.weave` | Closed record construction via `build` |
| `let.weave` | `let` binding inside `fold` |
| `over.weave` | Field-focused transform via `over` |
| `caseField.weave` | `case .field` with surrounding context propagation |
| `effects.weave` | Sequential effect composition |
| `treeFold.weave` | Catamorphism on a binary tree (`size`, `treeSum`) |
| `getenv.weave` | Parallel-safe `getEnv` effect |
| `fileio.weave` | Sequential `readFile` / `writeFile` / `print` |
| `bad.weave` | Intentional type error (undefined name) |
| `parse-error.weave` | Intentional syntax error |

---

## Running examples

### Hello world

```
npm run cli -- run examples/hello.weave --def greet --effect print=print
```

### Sum a list of integers

ADT encoding: `{"tag":"Cons","head":1,"tail":{"tag":"Cons","head":2,"tail":{"tag":"Nil"}}}` represents `[1, 2]`.

```
npm run cli -- run examples/sum.weave --def sum \
  --input '{"tag":"Cons","head":1,"tail":{"tag":"Cons","head":2,"tail":{"tag":"Nil"}}}'
```

Output: `3`

### Map over a list

`map` is a schema — `doubleAll` is a concrete instantiation (`map(f: double)`):

```
npm run cli -- run examples/map.weave --def doubleAll \
  --input '{"tag":"Cons","head":{"tag":"Nat","value":3},"tail":{"tag":"Cons","head":{"tag":"Nat","value":5},"tail":{"tag":"Nil"}}}'
```

Output: `Cons({ head: Nat({ value: 6 }), tail: Cons({ head: Nat({ value: 10 }), tail: Nil }) })`

### Filter a list

`filter` is a schema — `keepPositives` is a concrete instantiation (`filter(pred: isPositive)`):

```
npm run cli -- run examples/filter.weave --def keepPositives \
  --input '{"tag":"Cons","head":{"tag":"Elem","value":3},"tail":{"tag":"Cons","head":{"tag":"Elem","value":-1},"tail":{"tag":"Cons","head":{"tag":"Elem","value":5},"tail":{"tag":"Nil"}}}}'
```

Output: `Cons({ head: Elem({ value: 3 }), tail: Cons({ head: Elem({ value: 5 }), tail: Nil }) })`

### Multi-step pipeline

```
npm run cli -- run examples/pipeline.weave --def sumMinusLength \
  --input '{"tag":"Cons","head":10,"tail":{"tag":"Cons","head":3,"tail":{"tag":"Nil"}}}'
```

Output: `11` (sum=13, length=2, 13−2=11)

### Binary tree fold

A tree `Node { left: Leaf, value: 5, right: Node { left: Leaf, value: 3, right: Leaf } }`:

```
npm run cli -- run examples/treeFold.weave --def treeSum \
  --input '{"tag":"Node","left":{"tag":"Leaf"},"value":5,"right":{"tag":"Node","left":{"tag":"Leaf"},"value":3,"right":{"tag":"Leaf"}}}'
```

Output: `8`

```
npm run cli -- run examples/treeFold.weave --def size \
  --input '{"tag":"Node","left":{"tag":"Leaf"},"value":5,"right":{"tag":"Node","left":{"tag":"Leaf"},"value":3,"right":{"tag":"Leaf"}}}'
```

Output: `2`

### Parallel-safe effect: read an environment variable

```
npm run cli -- run examples/getenv.weave --def home --effect getEnv=getEnv
npm run cli -- run examples/getenv.weave --def user --effect getEnv=getEnv
```

### Sequential file I/O

Read a file and print its contents:

```
npm run cli -- run examples/fileio.weave --def echoFile \
  --input '"examples/hello.weave"' \
  --effect readFile=readFile --effect print=print
```

Write to a file:

```
npm run cli -- run examples/fileio.weave --def saveContent \
  --input '{"path":"/tmp/out.txt","content":"Hello from Weave!"}' \
  --effect writeFile=writeFile
```

### Effect composition

```
npm run cli -- run examples/effects.weave --def pipeline --effect print=print
```

### Intentional error examples

These files are designed to produce errors — useful for exploring diagnostics:

```
npm run cli -- check examples/bad.weave        # type error: undefined name
npm run cli -- check examples/parse-error.weave # syntax error
```

---

## ADT JSON encoding

Weave uses a flat tagged-object encoding for ADT values:

| Weave value | JSON |
|-------------|------|
| `Nil` | `{"tag":"Nil"}` |
| `Cons { head: 1, tail: Nil }` | `{"tag":"Cons","head":1,"tail":{"tag":"Nil"}}` |
| `None` | `{"tag":"None"}` |
| `Some { value: 42 }` | `{"tag":"Some","value":42}` |
| `Unit` | `null` |
| `"hello"` | `"hello"` |
| `42` | `42` |

The field name `"tag"` is reserved and may not appear as a payload field in any constructor.

---

## Built-in effects

| Name | Type | Effect level |
|------|------|-------------|
| `print` | `Text -> Unit` | `sequential` |
| `readFile` | `Text -> Text` | `sequential` |
| `writeFile` | `{ path: Text, content: Text } -> Unit` | `sequential` |
| `getEnv` | `Text -> Text` | `parallel-safe` |

Bind a built-in with `--effect <op>=<builtin>` on the CLI, or `:effect <op>=<builtin>` in the REPL.
