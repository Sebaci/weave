import { test, expect } from "vitest";
import { parseModule } from "./parse.ts";
import { checkModule } from "../typechecker/check.ts";
import { elaborateModule, resetElabCounters } from "../elaborator/index.ts";
import { interpret } from "../interpreter/eval.ts";
import { vInt, vBool, vRecord, vVariant, VUnit, showValue, type Value } from "../interpreter/value.ts";
import type { Module } from "../surface/ast.ts";
import type { TypedModule } from "../typechecker/typed-ast.ts";
import type { ElaboratedModule } from "../ir/ir.ts";
import { assertOk, mkList } from "../test-utils.ts";

// ---------------------------------------------------------------------------
// Helpers (parse-test-specific)
// ---------------------------------------------------------------------------

function fullPipeline(source: string, label: string): ElaboratedModule {
  resetElabCounters();
  const mod      = assertOk<Module>(parseModule(source), `${label}:parse`);
  const typedMod = assertOk<TypedModule>(checkModule(mod), `${label}:check`);
  return assertOk<ElaboratedModule>(elaborateModule(typedMod), `${label}:elab`);
}

function run(
  elabMod: ElaboratedModule,
  defName: string,
  input: Value,
  effects?: Map<string, (v: Value) => Value>,
): Value {
  return interpret(elabMod, defName, input, effects);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("literal: fortyTwo() = 42", () => {
  const m = fullPipeline(`
    def fortyTwo : Unit -> Int =
      42
  `, "fortyTwo");
  expect(showValue(run(m, "fortyTwo", VUnit))).toBe(showValue(vInt(42)));
});

test("infix arithmetic: addPair(3, 7) = 10", () => {
  const m = fullPipeline(`
    type Pair =
      | MkPair { l: Int, r: Int }

    def addPair : Pair -> Int =
      case {
        MkPair: { l, r } >>> l + r,
      }
  `, "infix_parse");
  const input = vVariant("MkPair", vRecord({ l: vInt(3), r: vInt(7) }));
  expect(showValue(run(m, "addPair", input))).toBe(showValue(vInt(10)));
});

test("fold: sum of List Int", () => {
  const m = fullPipeline(`
    type List a =
      | Nil
      | Cons { head: a, tail: List a }

    def sum : List Int -> Int =
      fold {
        Nil:  0,
        Cons: { head, tail } >>> head + tail,
      }
  `, "fold_sum");
  expect(showValue(run(m, "sum", mkList([])))).toBe(showValue(vInt(0)));
  expect(showValue(run(m, "sum", mkList([1, 2, 3])))).toBe(showValue(vInt(6)));
  expect(showValue(run(m, "sum", mkList([10])))).toBe(showValue(vInt(10)));
});

test("fold: length with wildcard binder", () => {
  const m = fullPipeline(`
    type List a =
      | Nil
      | Cons { head: a, tail: List a }

    def length : List Int -> Int =
      fold {
        Nil:  0,
        Cons: { head: _, tail } >>> tail + 1,
      }
  `, "fold_length");
  expect(showValue(run(m, "length", mkList([])))).toBe(showValue(vInt(0)));
  expect(showValue(run(m, "length", mkList([5, 5, 5, 5])))).toBe(showValue(vInt(4)));
});

test("fold: safeHead returns None for [] and Some for [42, 1]", () => {
  const m = fullPipeline(`
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
  `, "safeHead");

  const nilR = run(m, "safeHead", mkList([]));
  expect(nilR.tag).toBe("variant");
  expect((nilR as Extract<Value, { tag: "variant" }>).ctor).toBe("None");

  const consR = run(m, "safeHead", mkList([42, 1]));
  expect(consR.tag).toBe("variant");
  const consVariant = consR as Extract<Value, { tag: "variant" }>;
  expect(consVariant.ctor).toBe("Some");
  expect(consVariant.payload.tag).toBe("record");
  const rec = consVariant.payload as Extract<Value, { tag: "record" }>;
  expect(showValue(rec.fields.get("value")!)).toBe(showValue(vInt(42)));
});

test("boolean comparison: gtPair", () => {
  const m = fullPipeline(`
    type IntPair =
      | MkPair { l: Int, r: Int }

    def gtPair : IntPair -> Bool =
      case {
        MkPair: { l, r } >>> l > r,
      }
  `, "bool_parse");
  const mk = (l: number, r: number) =>
    vVariant("MkPair", vRecord({ l: vInt(l), r: vInt(r) }));
  expect(showValue(run(m, "gtPair", mk(5, 0)))).toBe(showValue(vBool(true)));
  expect(showValue(run(m, "gtPair", mk(-3, 0)))).toBe(showValue(vBool(false)));
  expect(showValue(run(m, "gtPair", mk(0, 0)))).toBe(showValue(vBool(false)));
});

test("effect: perform double", () => {
  const m = fullPipeline(`
    effect double : Int -> Int ! sequential

    def applyDouble : Int -> Int ! sequential =
      perform double
  `, "effect");
  const effects = new Map([
    ["double", (v: Value) => {
      if (v.tag !== "int") throw new Error("double: expected int");
      return vInt(v.value * 2);
    }],
  ]);
  expect(showValue(run(m, "applyDouble", vInt(5), effects))).toBe(showValue(vInt(10)));
});

test("let binding inside case", () => {
  const m = fullPipeline(`
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
  `, "let_test");

  const noneR = run(m, "doubled", vVariant("None", VUnit));
  expect(noneR.tag).toBe("variant");
  expect((noneR as Extract<Value, { tag: "variant" }>).ctor).toBe("None");

  const someR = run(m, "doubled", vVariant("Some", vRecord({ value: vInt(7) })));
  expect(someR.tag).toBe("variant");
  const someVariant = someR as Extract<Value, { tag: "variant" }>;
  expect(someVariant.ctor).toBe("Some");
  const rec = someVariant.payload as Extract<Value, { tag: "record" }>;
  expect(showValue(rec.fields.get("value")!)).toBe(showValue(vInt(14)));
});

test("module header: path and imports parse correctly", () => {
  resetElabCounters();
  const modR = parseModule(`
    module Example.List

    import Prelude

    type Unit2 = { dummy: Int }

    def identity : Int -> Int =
      fanout { l: 1, r } >>> add
  `);
  expect(modR.ok).toBe(true);
  if (!modR.ok) return;
  expect(modR.value.path.join(".")).toBe("Example.List");
  expect(modR.value.imports.length).toBe(1);
});

test("qualified name: single module component Foo.bar parses as Name", () => {
  const r = parseModule(`def foo : Int = Foo.bar`);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const decl = r.value.decls[0];
  if (decl?.tag !== "DefDecl") return;
  const step = decl.decl.body.steps[0];
  expect(step?.tag).toBe("Name");
  if (step?.tag !== "Name") return;
  expect(step.name).toBe("Foo.bar");
});

test("qualified name: two module components Foo.Bar.baz parses as Name", () => {
  const r = parseModule(`def foo : Int = Foo.Bar.baz`);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const decl = r.value.decls[0];
  if (decl?.tag !== "DefDecl") return;
  const step = decl.decl.body.steps[0];
  expect(step?.tag).toBe("Name");
  if (step?.tag !== "Name") return;
  expect(step.name).toBe("Foo.Bar.baz");
});

test("qualified name: bare UPPER still parses as Ctor", () => {
  const r = parseModule(`
    type T = | A
    def foo : T = A
  `);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const decl = r.value.decls[1];
  if (decl?.tag !== "DefDecl") return;
  const step = decl.decl.body.steps[0];
  expect(step?.tag).toBe("Ctor");
  if (step?.tag !== "Ctor") return;
  expect(step.name).toBe("A");
});
