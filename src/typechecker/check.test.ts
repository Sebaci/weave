/**
 * Typechecker sanity tests.
 * All examples are drawn from weave-surface-syntax-v1.md §worked-examples.
 *
 * These tests construct surface ASTs manually (no parser yet) and verify that
 * checkModule succeeds and produces the expected morphism types.
 */

import { checkModule } from "./check.ts";
import {
  pipeline, stepFold, stepFanout, stepInfix, stepName, stepCtor, stepCase,
  branch, nullaryHandler, recordHandler, bindBinder, wildcardBinder,
  fanoutField, fanoutShorthand,
  stepLit,
  stBase, stTyVar, stNamed, stArrow, stRecord, stField,
  mkModule, mkTypeDeclVariant, mkDefDecl, mkCtorDecl, mkDefParam,
  type Module, type TopDecl,
} from "../surface/ast.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function topTypeDecl(decl: ReturnType<typeof mkTypeDeclVariant>): TopDecl {
  return { tag: "TypeDecl", decl };
}

function topDefDecl(decl: ReturnType<typeof mkDefDecl>): TopDecl {
  return { tag: "DefDecl", decl };
}

function assertOk<T>(r: { ok: boolean; errors?: unknown[]; value?: T }, label: string): T {
  if (!r.ok) {
    const errs = (r as { errors: { message: string }[] }).errors;
    throw new Error(`${label}: expected ok, got errors:\n${errs.map((e) => `  - ${e.message}`).join("\n")}`);
  }
  return (r as { ok: true; value: T }).value;
}

function assertFail(r: { ok: boolean }, label: string): void {
  if (r.ok) throw new Error(`${label}: expected failure, got ok`);
}

// ---------------------------------------------------------------------------
// Shared: List a type declaration
// ---------------------------------------------------------------------------

// type List a = | Nil | Cons { head: a, tail: List a }
const listTypeDecl = mkTypeDeclVariant("List", ["a"], [
  mkCtorDecl("Nil", null),
  mkCtorDecl("Cons", [
    stField("head", stTyVar("a")),
    stField("tail", stNamed("List", stTyVar("a"))),
  ]),
]);

// type Bool = | True | False
const boolTypeDecl = mkTypeDeclVariant("Bool", [], [
  mkCtorDecl("True", null),
  mkCtorDecl("False", null),
]);

// type Maybe a = | None | Some { value: a }
const maybeTypeDecl = mkTypeDeclVariant("Maybe", ["a"], [
  mkCtorDecl("None", null),
  mkCtorDecl("Some", [stField("value", stTyVar("a"))]),
]);

// ---------------------------------------------------------------------------
// Test: def sum : List Int -> Int
// ---------------------------------------------------------------------------

// def sum : List Int -> Int =
//   fold {
//     Nil:  0,
//     Cons: { head, tail } >>> head + tail,
//   }
function test_sum() {
  const sumDef = mkDefDecl(
    "sum",
    [],
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
    topTypeDecl(listTypeDecl),
    topDefDecl(sumDef),
  ]);

  const r = assertOk(checkModule(mod), "sum");
  const def = r.typedDefs.get("sum");
  if (!def) throw new Error("sum: def not found");
  if (def.morphTy.input.tag !== "Named" || def.morphTy.input.name !== "List")
    throw new Error(`sum: expected List input, got ${JSON.stringify(def.morphTy.input)}`);
  if (def.morphTy.output.tag !== "Int")
    throw new Error(`sum: expected Int output, got ${JSON.stringify(def.morphTy.output)}`);
  if (def.morphTy.eff !== "pure")
    throw new Error(`sum: expected pure, got ${def.morphTy.eff}`);
  console.log("PASS test_sum");
}

// ---------------------------------------------------------------------------
// Test: def length : List a -> Int
// ---------------------------------------------------------------------------

// def length : List a -> Int =
//   fold {
//     Nil:  0,
//     Cons: { head: _, tail } >>> tail + 1,
//   }
function test_length() {
  const lengthDef = mkDefDecl(
    "length",
    [],
    stArrow(stNamed("List", stTyVar("a")), stBase("Int")),
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
    topTypeDecl(listTypeDecl),
    topDefDecl(lengthDef),
  ]);

  const r = assertOk(checkModule(mod), "length");
  const def = r.typedDefs.get("length");
  if (!def) throw new Error("length: def not found");
  if (def.morphTy.output.tag !== "Int")
    throw new Error(`length: expected Int output, got ${JSON.stringify(def.morphTy.output)}`);
  console.log("PASS test_length");
}

// ---------------------------------------------------------------------------
// Test: def map (f : a -> b ! ε) : List a -> List b ! ε
// ---------------------------------------------------------------------------

// def map (f : a -> b ! ε) : List a -> List b ! ε =
//   fold {
//     Nil:  Nil,
//     Cons: { head, tail } >>>
//       fanout { head: head >>> f, tail } >>> Cons,
//   }
function test_map() {
  const mapDef = mkDefDecl(
    "map",
    [mkDefParam("f", stArrow(stTyVar("a"), stTyVar("b"), { tag: "EffVar", name: "ε" }))],
    stArrow(stNamed("List", stTyVar("a")), stNamed("List", stTyVar("b")), { tag: "EffVar", name: "ε" }),
    null,
    pipeline(
      stepFold([
        branch("Nil",  nullaryHandler(pipeline(stepCtor("Nil")))),
        branch("Cons", recordHandler(
          [bindBinder("head"), bindBinder("tail")],
          pipeline(
            stepFanout([
              fanoutField("head", pipeline(stepName("head"), stepName("f"))),
              fanoutShorthand("tail"),
            ]),
            stepCtor("Cons"),
          ),
        )),
      ]),
    ),
  );

  const mod: Module = mkModule([], [], [
    topTypeDecl(listTypeDecl),
    topDefDecl(mapDef),
  ]);

  const r = assertOk(checkModule(mod), "map");
  const def = r.typedDefs.get("map");
  if (!def) throw new Error("map: def not found");
  if (def.morphTy.input.tag !== "Named" || def.morphTy.input.name !== "List")
    throw new Error(`map: expected List input`);
  if (def.morphTy.output.tag !== "Named" || def.morphTy.output.name !== "List")
    throw new Error(`map: expected List output, got ${JSON.stringify(def.morphTy.output)}`);
  console.log("PASS test_map");
}

// ---------------------------------------------------------------------------
// Test: def safeHead : List a -> Maybe a
// ---------------------------------------------------------------------------

// def safeHead : List a -> Maybe a =
//   case {
//     Nil:  None,
//     Cons: { head, tail: _ } >>> fanout { value: head } >>> Some,
//   }
function test_safeHead() {
  const safeHeadDef = mkDefDecl(
    "safeHead",
    [],
    stArrow(stNamed("List", stTyVar("a")), stNamed("Maybe", stTyVar("a"))),
    null,
    pipeline(
      stepCase([
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
    topTypeDecl(listTypeDecl),
    topTypeDecl(maybeTypeDecl),
    topDefDecl(safeHeadDef),
  ]);

  const r = assertOk(checkModule(mod), "safeHead");
  const def = r.typedDefs.get("safeHead");
  if (!def) throw new Error("safeHead: def not found");
  if (def.morphTy.output.tag !== "Named" || def.morphTy.output.name !== "Maybe")
    throw new Error(`safeHead: expected Maybe output, got ${JSON.stringify(def.morphTy.output)}`);
  console.log("PASS test_safeHead");
}

// ---------------------------------------------------------------------------
// Test: infix operators — type errors
// ---------------------------------------------------------------------------

function test_infix_type_error() {
  // def bad : Bool -> Int = x + y where x: Bool — should fail
  const boolListDecl = mkTypeDeclVariant("Bool2", [], [
    mkCtorDecl("T2", null),
    mkCtorDecl("F2", null),
  ]);

  // def bad : { x: Bool, y: Bool } -> Int = x + y  (Bool not numeric)
  const badDef = mkDefDecl(
    "bad",
    [],
    stArrow(
      stRecord([stField("x", stBase("Bool")), stField("y", stBase("Bool"))]),
      stBase("Int"),
    ),
    null,
    pipeline(
      stepFanout([fanoutShorthand("x"), fanoutShorthand("y")]),
      stepInfix("+", stepName("x"), stepName("y")),
    ),
  );

  const mod: Module = mkModule([], [], [topDefDecl(badDef)]);
  assertFail(checkModule(mod), "infix_type_error");
  console.log("PASS test_infix_type_error");
}

// ---------------------------------------------------------------------------
// Test: unknown operator
// ---------------------------------------------------------------------------

function test_unknown_op() {
  const badDef = mkDefDecl(
    "bad",
    [],
    stArrow(stBase("Int"), stBase("Int")),
    null,
    pipeline(stepInfix("**", stepName("bad"), stepLit({ tag: "int", value: 2 }))),
  );
  const mod: Module = mkModule([], [], [topDefDecl(badDef)]);
  assertFail(checkModule(mod), "unknown_op");
  console.log("PASS test_unknown_op");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: (() => void)[] = [
  test_sum,
  test_length,
  test_map,
  test_safeHead,
  test_infix_type_error,
  test_unknown_op,
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
