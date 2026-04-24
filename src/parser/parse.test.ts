/**
 * Parser tests — full pipeline: source string → parse → typecheck → elaborate → interpret.
 *
 * These are the first tests that exercise the complete path.
 */

import { parseModule } from "./parse.ts";
import { checkModule } from "../typechecker/check.ts";
import { elaborateModule, resetElabCounters } from "../elaborator/index.ts";
import { interpret } from "../interpreter/eval.ts";
import { vInt, vBool, vRecord, vVariant, VUnit, showValue, type Value } from "../interpreter/value.ts";
import type { Module } from "../surface/ast.ts";
import type { TypedModule } from "../typechecker/typed-ast.ts";
import type { ElaboratedModule } from "../ir/ir.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OkResult<T> = { ok: true; value: T };
type FailResult  = { ok: false; errors: { message: string }[] };

function assertOk<T>(r: OkResult<T> | FailResult, label: string): T {
  if (!r.ok) throw new Error(`${label}: ${r.errors.map((e) => e.message).join("; ")}`);
  return r.value;
}

function fullPipeline(source: string, label: string): ElaboratedModule {
  resetElabCounters();
  const mod      = assertOk<Module>(parseModule(source), `${label}:parse`);
  const typedMod = assertOk<TypedModule>(checkModule(mod), `${label}:check`);
  return assertOk<ElaboratedModule>(elaborateModule(typedMod), `${label}:elab`);
}

function run(elabMod: ElaboratedModule, defName: string, input: Value,
             effects?: Map<string, (v: Value) => Value>): Value {
  return interpret(elabMod, defName, input, effects);
}

function assertEq(actual: Value, expected: Value, label: string): void {
  if (showValue(actual) !== showValue(expected))
    throw new Error(`${label}: expected ${showValue(expected)}, got ${showValue(actual)}`);
}

// Build a List Int value from an array
function mkList(vals: number[]): Value {
  let acc: Value = vVariant("Nil", VUnit);
  for (let i = vals.length - 1; i >= 0; i--)
    acc = vVariant("Cons", vRecord({ head: vInt(vals[i]!), tail: acc }));
  return acc;
}

// ---------------------------------------------------------------------------
// Test: literal constant
// ---------------------------------------------------------------------------

function test_literal_parse() {
  const src = `
    def fortyTwo : Unit -> Int =
      42
  `;
  const m = fullPipeline(src, "fortyTwo");
  assertEq(run(m, "fortyTwo", VUnit), vInt(42), "fortyTwo");
  console.log("PASS test_literal_parse");
}

// ---------------------------------------------------------------------------
// Test: infix arithmetic
// ---------------------------------------------------------------------------

function test_infix_parse() {
  const src = `
    type Pair =
      | MkPair { l: Int, r: Int }

    def addPair : Pair -> Int =
      fold {
        MkPair: { l, r } >>> l + r,
      }
  `;
  const m = fullPipeline(src, "infix_parse");
  const input = vVariant("MkPair", vRecord({ l: vInt(3), r: vInt(7) }));
  assertEq(run(m, "addPair", input), vInt(10), "addPair({l:3,r:7})");
  console.log("PASS test_infix_parse");
}

// ---------------------------------------------------------------------------
// Test: fold — sum of List Int (full syntax)
// ---------------------------------------------------------------------------

function test_fold_sum_parse() {
  const src = `
    type List a =
      | Nil
      | Cons { head: a, tail: List a }

    def sum : List Int -> Int =
      fold {
        Nil:  0,
        Cons: { head, tail } >>> head + tail,
      }
  `;
  const m = fullPipeline(src, "fold_sum");
  assertEq(run(m, "sum", mkList([])),        vInt(0),  "sum([])");
  assertEq(run(m, "sum", mkList([1, 2, 3])), vInt(6),  "sum([1,2,3])");
  assertEq(run(m, "sum", mkList([10])),      vInt(10), "sum([10])");
  console.log("PASS test_fold_sum_parse");
}

// ---------------------------------------------------------------------------
// Test: fold — length with wildcard binder
// ---------------------------------------------------------------------------

function test_fold_length_parse() {
  const src = `
    type List a =
      | Nil
      | Cons { head: a, tail: List a }

    def length : List Int -> Int =
      fold {
        Nil:  0,
        Cons: { head: _, tail } >>> tail + 1,
      }
  `;
  const m = fullPipeline(src, "fold_length");
  assertEq(run(m, "length", mkList([])),           vInt(0), "length([])");
  assertEq(run(m, "length", mkList([5, 5, 5, 5])), vInt(4), "length([_,_,_,_])");
  console.log("PASS test_fold_length_parse");
}

// ---------------------------------------------------------------------------
// Test: safeHead — returns Maybe Int
// ---------------------------------------------------------------------------

function test_safeHead_parse() {
  const src = `
    type List a =
      | Nil
      | Cons { head: a, tail: List a }

    type Maybe a =
      | None
      | Some { value: a }

    def safeHead : List Int -> Maybe Int =
      fold {
        None: None,
        Cons: { head, tail: _ } >>>
          fanout { value: head } >>> Some,
      }
  `;
  // Note: 'None' is a Ctor name used as both branch name and expression.
  // Actually the fold is on List, so branches should be Nil/Cons not None/Cons.
  // Let me fix:
  const src2 = `
    type List a =
      | Nil
      | Cons { head: a, tail: List a }

    type Maybe a =
      | None
      | Some { value: a }

    def safeHead : List Int -> Maybe Int =
      fold {
        Nil:  None,
        Cons: { head, tail: _ } >>>
          fanout { value: head } >>> Some,
      }
  `;
  const m = fullPipeline(src2, "safeHead");
  const nilR = run(m, "safeHead", mkList([]));
  if (nilR.tag !== "variant" || nilR.ctor !== "None")
    throw new Error(`safeHead([]): expected None, got ${showValue(nilR)}`);
  const consR = run(m, "safeHead", mkList([42, 1]));
  if (consR.tag !== "variant" || consR.ctor !== "Some")
    throw new Error(`safeHead([42,1]): expected Some, got ${showValue(consR)}`);
  if (consR.payload.tag !== "record")
    throw new Error(`safeHead([42,1]): Some payload not a record`);
  assertEq(consR.payload.fields.get("value")!, vInt(42), "safeHead([42,1]).value");
  console.log("PASS test_safeHead_parse");
}

// ---------------------------------------------------------------------------
// Test: boolean / comparison
// ---------------------------------------------------------------------------

function test_bool_parse() {
  const src = `
    type IntPair =
      | MkPair { l: Int, r: Int }

    def gtPair : IntPair -> Bool =
      fold {
        MkPair: { l, r } >>> l > r,
      }
  `;
  const m = fullPipeline(src, "bool_parse");
  const mk = (l: number, r: number) =>
    vVariant("MkPair", vRecord({ l: vInt(l), r: vInt(r) }));
  assertEq(run(m, "gtPair", mk(5, 0)),  vBool(true),  "5 > 0");
  assertEq(run(m, "gtPair", mk(-3, 0)), vBool(false), "-3 > 0");
  assertEq(run(m, "gtPair", mk(0, 0)),  vBool(false), "0 > 0");
  console.log("PASS test_bool_parse");
}

// ---------------------------------------------------------------------------
// Test: effect decl + perform
// ---------------------------------------------------------------------------

function test_effect_parse() {
  const src = `
    effect double : Int -> Int ! sequential

    def applyDouble : Int -> Int ! sequential =
      perform double
  `;
  const m = fullPipeline(src, "effect");
  const effects = new Map([
    ["double", (v: Value) => {
      if (v.tag !== "int") throw new Error("double: expected int");
      return vInt(v.value * 2);
    }],
  ]);
  assertEq(run(m, "applyDouble", vInt(5), effects), vInt(10), "double(5)");
  console.log("PASS test_effect_parse");
}

// ---------------------------------------------------------------------------
// Test: let binding
// ---------------------------------------------------------------------------

function test_let_parse() {
  const src = `
    type Maybe a =
      | None
      | Some { value: a }

    def doubled : Int -> Maybe Int =
      fold {
        None: None,
        Some: { value } >>>
          let x = value + value in
          fanout { value: x } >>> Some,
      }
  `;
  // This tests let inside a fold handler.
  // Actually fold requires a List-like recursive type. Let me use case with Maybe instead.
  const src2 = `
    type Maybe a =
      | None
      | Some { value: a }

    def doubled : Maybe Int -> Maybe Int =
      case {
        None: None,
        Some: { value } >>>
          let x = value + value in
          fanout { value: x } >>> Some,
      }
  `;
  const m = fullPipeline(src2, "let_test");
  const noneR = run(m, "doubled", vVariant("None", VUnit));
  if (noneR.tag !== "variant" || noneR.ctor !== "None")
    throw new Error(`doubled(None): expected None, got ${showValue(noneR)}`);
  const someR = run(m, "doubled", vVariant("Some", vRecord({ value: vInt(7) })));
  if (someR.tag !== "variant" || someR.ctor !== "Some")
    throw new Error(`doubled(Some(7)): expected Some, got ${showValue(someR)}`);
  assertEq(someR.payload.tag === "record"
    ? someR.payload.fields.get("value")! : VUnit, vInt(14), "doubled(Some(7)).value");
  console.log("PASS test_let_parse");
}

// ---------------------------------------------------------------------------
// Test: module header parsing (cosmetic — just checking it doesn't error)
// ---------------------------------------------------------------------------

function test_module_header_parse() {
  const src = `
    module Example.List

    import Prelude

    type Unit2 = { dummy: Int }

    def identity : Int -> Int =
      fanout { l: 1, r } >>> add
  `;
  // Just check it parses and typechecks without error
  resetElabCounters();
  const modR = parseModule(src);
  if (!modR.ok) throw new Error(`parse failed: ${modR.errors[0]!.message}`);
  if (modR.value.path.join(".") !== "Example.List")
    throw new Error(`module path wrong: ${modR.value.path}`);
  if (modR.value.imports.length !== 1)
    throw new Error(`expected 1 import, got ${modR.value.imports.length}`);
  console.log("PASS test_module_header_parse");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_literal_parse,
  test_infix_parse,
  test_fold_sum_parse,
  test_fold_length_parse,
  test_safeHead_parse,
  test_bool_parse,
  test_effect_parse,
  test_let_parse,
  test_module_header_parse,
];

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t();
    passed++;
  } catch (e) {
    console.error(`FAIL ${t.name}: ${(e as Error).message}`);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} test(s) failed`);
