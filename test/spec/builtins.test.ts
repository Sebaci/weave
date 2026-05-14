/**
 * Spec tests for builtin morphisms (id, not, concat) and the <> operator.
 *
 * Covers:
 *   - id: identity wire, type variable instantiation
 *   - not: Bool → Bool, rejects non-Bool
 *   - concat / <>: Text operands only, rejects Int/Bool operands at typecheck time
 *   - module builtin: reserved namespace (E_RESERVED_NAME)
 *   - local def shadows builtin id
 */

import { test, expect } from "vitest";
import { parseModule } from "../../src/parser/index.ts";
import { checkModule } from "../../src/typechecker/check.ts";
import { elaborateModule, resetElabCounters } from "../../src/elaborator/index.ts";
import { interpret } from "../../src/interpreter/eval.ts";
import { vBool, vInt, vText, VUnit, showValue, type Value } from "../../src/interpreter/value.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function check(src: string) {
  const pr = parseModule(src);
  if (!pr.ok) throw new Error(`Parse: ${pr.errors.map((e) => e.message).join("; ")}`);
  return checkModule(pr.value);
}

function run(src: string, defName: string, input: Value): Value {
  resetElabCounters();
  const pr = parseModule(src);
  if (!pr.ok) throw new Error(`Parse: ${pr.errors.map((e) => e.message).join("; ")}`);
  const tr = checkModule(pr.value);
  if (!tr.ok) throw new Error(`Typecheck: ${tr.errors.map((e) => e.message).join("; ")}`);
  const er = elaborateModule(tr.value);
  if (!er.ok) throw new Error(`Elaborate: ${er.errors.map((e) => e.message).join("; ")}`);
  return interpret(er.value, defName, input);
}

// ---------------------------------------------------------------------------
// id
// ---------------------------------------------------------------------------

test("id: Int → Int passes through unchanged", () => {
  const result = run(`
    module Test.Builtins
    def passInt : Int -> Int ! pure = id
  `, "passInt", vInt(42));
  expect(showValue(result)).toBe(showValue(vInt(42)));
});

test("id: Bool → Bool passes through unchanged", () => {
  const result = run(`
    module Test.Builtins
    def passBool : Bool -> Bool ! pure = id
  `, "passBool", vBool(true));
  expect(showValue(result)).toBe(showValue(vBool(true)));
});

test("id: local def shadows builtin", () => {
  // A local def named 'id' that always returns 0 should override the builtin.
  const result = run(`
    module Test.Builtins
    def id : Int -> Int ! pure = 0
    def test : Int -> Int ! pure = id
  `, "test", vInt(99));
  expect(showValue(result)).toBe(showValue(vInt(0)));
});

// ---------------------------------------------------------------------------
// not
// ---------------------------------------------------------------------------

test("not: True → False", () => {
  const result = run(`
    module Test.Builtins
    def negate : Bool -> Bool ! pure = not
  `, "negate", vBool(true));
  expect(showValue(result)).toBe(showValue(vBool(false)));
});

test("not: False → True", () => {
  const result = run(`
    module Test.Builtins
    def negate : Bool -> Bool ! pure = not
  `, "negate", vBool(false));
  expect(showValue(result)).toBe(showValue(vBool(true)));
});

test("not: pipeline composition id >>> not", () => {
  const result = run(`
    module Test.Builtins
    def flipBool : Bool -> Bool ! pure = id >>> not
  `, "flipBool", vBool(true));
  expect(showValue(result)).toBe(showValue(vBool(false)));
});

// ---------------------------------------------------------------------------
// concat / <>
// ---------------------------------------------------------------------------

test("concat: two Text values joined", () => {
  const result = run(`
    module Test.Builtins
    def greet : { l: Text, r: Text } -> Text ! pure = concat
  `, "greet", { tag: "record", fields: new Map([["l", vText("hello ")], ["r", vText("world")]]) });
  expect(showValue(result)).toBe(showValue(vText("hello world")));
});

test("<>: Text <> Text succeeds and produces correct value", () => {
  const result = run(`
    module Test.Builtins
    def joinTwo : { l: Text, r: Text } -> Text ! pure =
      fanout { l: .l, r: .r } >>> concat
  `, "joinTwo", { tag: "record", fields: new Map([["l", vText("foo")], ["r", vText("bar")]]) });
  expect(showValue(result)).toBe(showValue(vText("foobar")));
});

// ---------------------------------------------------------------------------
// Type errors: <> rejects non-Text operands at typecheck time
// ---------------------------------------------------------------------------

test("<>: Int <> Int rejected at typecheck (E_TYPE_MISMATCH)", () => {
  const r = check(`
    module Test.Builtins
    def bad : Int -> Text ! pure = id <> id
  `);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_TYPE_MISMATCH")).toBe(true);
  }
});

test("<>: Bool <> Bool rejected at typecheck (E_TYPE_MISMATCH)", () => {
  const r = check(`
    module Test.Builtins
    def bad : Bool -> Text ! pure = id <> id
  `);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_TYPE_MISMATCH")).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Type errors: && / || reject non-Bool operands at typecheck time
// ---------------------------------------------------------------------------

test("&&: Int && Int rejected at typecheck (E_TYPE_MISMATCH)", () => {
  const r = check(`
    module Test.Builtins
    def bad : Int -> Bool ! pure = id && id
  `);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_TYPE_MISMATCH")).toBe(true);
  }
});

test("||: Int || Int rejected at typecheck (E_TYPE_MISMATCH)", () => {
  const r = check(`
    module Test.Builtins
    def bad : Int -> Bool ! pure = id || id
  `);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_TYPE_MISMATCH")).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Reserved namespace: module builtin
// ---------------------------------------------------------------------------

test("module builtin: reserved path rejected (E_RESERVED_NAME)", () => {
  const r = check(`
    module builtin
    def foo : Int -> Int ! pure = id
  `);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_RESERVED_NAME")).toBe(true);
  }
});

test("module builtin.Foo: reserved path component rejected (E_RESERVED_NAME)", () => {
  const r = check(`
    module builtin.Foo
    def foo : Int -> Int ! pure = id
  `);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_RESERVED_NAME")).toBe(true);
  }
});
