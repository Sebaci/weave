/**
 * Interpreter tests.
 *
 * Each test builds a Weave module (surface AST), typechecks it, elaborates
 * it, and then evaluates specific defs against known inputs.
 */

import { checkModule } from "../typechecker/check.ts";
import { elaborateModule, resetElabCounters } from "../elaborator/index.ts";
import { interpret } from "./eval.ts";
import { vInt, vBool, vText, vRecord, vVariant, VUnit, showValue, type Value } from "./value.ts";
import type { Module } from "../surface/ast.ts";
import type { TypedModule } from "../typechecker/typed-ast.ts";
import type { ElaboratedModule } from "../ir/ir.ts";

import {
  pipeline, stepFold, stepFanout, stepInfix, stepName, stepCtor,
  stepLit, branch, nullaryHandler, recordHandler, bindBinder, wildcardBinder,
  fanoutField, stBase, stTyVar, stNamed, stArrow, stField, stRecord,
  mkModule, mkTypeDeclVariant, mkDefDecl, mkCtorDecl, mkEffectDecl,
} from "../surface/ast.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OkResult<T> = { ok: true; value: T };
type FailResult  = { ok: false; errors: { message: string }[] };

function assertOk<T>(r: OkResult<T> | FailResult, label: string): T {
  if (!r.ok) {
    throw new Error(`${label}: expected ok:\n${r.errors.map((e) => `  - ${e.message}`).join("\n")}`);
  }
  return r.value;
}

function makeAndElab(mod: Module, label: string): ElaboratedModule {
  resetElabCounters();
  const typedMod = assertOk<TypedModule>(checkModule(mod), `${label}:typecheck`);
  return assertOk<ElaboratedModule>(elaborateModule(typedMod), `${label}:elab`);
}

function assertEq(actual: Value, expected: Value, label: string): void {
  if (showValue(actual) !== showValue(expected)) {
    throw new Error(`${label}: expected ${showValue(expected)}, got ${showValue(actual)}`);
  }
}

// Shared type declarations
const listTypeDecl = mkTypeDeclVariant("List", ["a"], [
  mkCtorDecl("Nil", null),
  mkCtorDecl("Cons", [stField("head", stTyVar("a")), stField("tail", stNamed("List", stTyVar("a")))]),
]);

const maybeTypeDecl = mkTypeDeclVariant("Maybe", ["a"], [
  mkCtorDecl("None", null),
  mkCtorDecl("Some", [stField("value", stTyVar("a"))]),
]);

// Build a List Int value from an array
function mkList(vals: number[]): Value {
  let acc: Value = vVariant("Nil", VUnit);
  for (let i = vals.length - 1; i >= 0; i--) {
    acc = vVariant("Cons", vRecord({ head: vInt(vals[i]!), tail: acc }));
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Test: literal constant
// ---------------------------------------------------------------------------

function test_literal() {
  const def = mkDefDecl(
    "fortyTwo", [],
    stArrow(stBase("Unit"), stBase("Int")),
    null,
    pipeline(stepLit({ tag: "int", value: 42 })),
  );
  const mod: Module = mkModule([], [], [{ tag: "DefDecl", decl: def }]);
  const elabMod = makeAndElab(mod, "fortyTwo");
  const result = interpret(elabMod, "fortyTwo", VUnit);
  assertEq(result, vInt(42), "fortyTwo");
  console.log("PASS test_literal");
}

// ---------------------------------------------------------------------------
// Test: fanout record construction
// ---------------------------------------------------------------------------

function test_fanout() {
  const def = mkDefDecl(
    "pair", [],
    stArrow(stBase("Int"), stRecord([stField("l", stBase("Int")), stField("r", stBase("Int"))])),
    null,
    pipeline(
      stepFanout([
        fanoutField("l", pipeline(stepLit({ tag: "int", value: 1 }))),
        fanoutField("r", pipeline(stepLit({ tag: "int", value: 2 }))),
      ]),
    ),
  );
  const mod: Module = mkModule([], [], [{ tag: "DefDecl", decl: def }]);
  const elabMod = makeAndElab(mod, "pair");
  const result = interpret(elabMod, "pair", vInt(99));
  assertEq(result, vRecord({ l: vInt(1), r: vInt(2) }), "pair");
  console.log("PASS test_fanout");
}

// ---------------------------------------------------------------------------
// Test: infix arithmetic via fold sum
// ---------------------------------------------------------------------------

function test_sum() {
  const def = mkDefDecl(
    "sum", [],
    stArrow(stNamed("List", stBase("Int")), stBase("Int")),
    null,
    pipeline(
      stepFold([
        branch("Nil",  nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
        branch("Cons", recordHandler(
          [bindBinder("head"), bindBinder("tail")],
          pipeline(stepInfix("+", stepName("head"), stepName("tail"))),
        )),
      ]),
    ),
  );
  const mod: Module = mkModule([], [], [
    { tag: "TypeDecl", decl: listTypeDecl },
    { tag: "DefDecl",  decl: def },
  ]);
  const elabMod = makeAndElab(mod, "sum");

  assertEq(interpret(elabMod, "sum", mkList([])),        vInt(0),  "sum([])");
  assertEq(interpret(elabMod, "sum", mkList([1, 2, 3])), vInt(6),  "sum([1,2,3])");
  assertEq(interpret(elabMod, "sum", mkList([10, 20])),  vInt(30), "sum([10,20])");
  console.log("PASS test_sum");
}

// ---------------------------------------------------------------------------
// Test: fold length (wildcard binder)
// ---------------------------------------------------------------------------

function test_length() {
  const def = mkDefDecl(
    "length", [],
    stArrow(stNamed("List", stBase("Int")), stBase("Int")),
    null,
    pipeline(
      stepFold([
        branch("Nil",  nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
        branch("Cons", recordHandler(
          [wildcardBinder("head"), bindBinder("tail")],
          pipeline(stepInfix("+", stepName("tail"), stepLit({ tag: "int", value: 1 }))),
        )),
      ]),
    ),
  );
  const mod: Module = mkModule([], [], [
    { tag: "TypeDecl", decl: listTypeDecl },
    { tag: "DefDecl",  decl: def },
  ]);
  const elabMod = makeAndElab(mod, "length");

  assertEq(interpret(elabMod, "length", mkList([])),           vInt(0), "length([])");
  assertEq(interpret(elabMod, "length", mkList([5, 5, 5, 5])), vInt(4), "length([5,5,5,5])");
  console.log("PASS test_length");
}

// ---------------------------------------------------------------------------
// Test: safeHead — fold on List returning Maybe Int
// ---------------------------------------------------------------------------

function test_safeHead() {
  const def = mkDefDecl(
    "safeHead", [],
    stArrow(stNamed("List", stBase("Int")), stNamed("Maybe", stBase("Int"))),
    null,
    pipeline(
      stepFold([
        branch("Nil",  nullaryHandler(pipeline(stepCtor("None")))),
        branch("Cons", recordHandler(
          [bindBinder("head"), wildcardBinder("tail")],
          pipeline(
            stepFanout([fanoutField("value", pipeline(stepName("head")))]),
            stepCtor("Some"),
          ),
        )),
      ]),
    ),
  );
  const mod: Module = mkModule([], [], [
    { tag: "TypeDecl", decl: listTypeDecl },
    { tag: "TypeDecl", decl: maybeTypeDecl },
    { tag: "DefDecl",  decl: def },
  ]);
  const elabMod = makeAndElab(mod, "safeHead");

  const nilResult = interpret(elabMod, "safeHead", mkList([]));
  if (nilResult.tag !== "variant" || nilResult.ctor !== "None")
    throw new Error(`safeHead([]): expected None, got ${showValue(nilResult)}`);

  const consResult = interpret(elabMod, "safeHead", mkList([7, 8, 9]));
  if (consResult.tag !== "variant" || consResult.ctor !== "Some")
    throw new Error(`safeHead([7,8,9]): expected Some, got ${showValue(consResult)}`);
  const inner = consResult.payload;
  if (inner.tag !== "record")
    throw new Error(`safeHead([7,8,9]): Some payload should be record, got ${showValue(inner)}`);
  const val = inner.fields.get("value");
  assertEq(val!, vInt(7), "safeHead([7,8,9]).value");

  console.log("PASS test_safeHead");
}

// ---------------------------------------------------------------------------
// Test: effect node
// ---------------------------------------------------------------------------

function test_effect() {
  // effect decl: double : Int -> Int ! sequential
  const mod: Module = mkModule([], [], [
    { tag: "EffectDecl", decl: mkEffectDecl("double", stBase("Int"), stBase("Int"), "sequential") },
    {
      tag: "DefDecl",
      decl: mkDefDecl(
        "applyDouble", [],
        stArrow(stBase("Int"), stBase("Int"), "sequential"),
        null,
        pipeline({ tag: "Perform", op: ["double"], meta: { id: "perf1", span: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } } }),
      ),
    },
  ]);
  const elabMod = makeAndElab(mod, "applyDouble");

  const effects = new Map([
    ["double", (v: Value) => {
      if (v.tag !== "int") throw new Error("double: expected int");
      return vInt(v.value * 2);
    }],
  ]);
  assertEq(interpret(elabMod, "applyDouble", vInt(5), effects), vInt(10), "double(5)");
  console.log("PASS test_effect");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_literal,
  test_fanout,
  test_sum,
  test_length,
  test_safeHead,
  test_effect,
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
