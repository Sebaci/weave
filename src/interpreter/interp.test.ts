import { test, expect } from "vitest";
import { interpret } from "./eval.ts";
import { vInt, vRecord, vVariant, VUnit, showValue, type Value } from "./value.ts";
import {
  pipeline, stepFold, stepFanout, stepInfix, stepName, stepCtor,
  stepLit, branch, nullaryHandler, recordHandler, bindBinder, wildcardBinder,
  fanoutField, stBase, stTyVar, stNamed, stArrow, stField, stRecord,
  mkModule, mkDefDecl, mkEffectDecl,
  type Module,
} from "../surface/ast.ts";
import { makeAndElab, listTypeDecl, maybeTypeDecl, mkList } from "../test-utils.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("literal: fortyTwo() = 42", () => {
  const mod: Module = mkModule([], [], [{
    tag: "DefDecl",
    decl: mkDefDecl(
      "fortyTwo", [],
      stArrow(stBase("Unit"), stBase("Int")),
      null,
      pipeline(stepLit({ tag: "int", value: 42 })),
    ),
  }]);
  const elabMod = makeAndElab(mod, "fortyTwo");
  expect(showValue(interpret(elabMod, "fortyTwo", VUnit))).toBe(showValue(vInt(42)));
});

test("fanout: pair(99) = {l:1, r:2}", () => {
  const mod: Module = mkModule([], [], [{
    tag: "DefDecl",
    decl: mkDefDecl(
      "pair", [],
      stArrow(stBase("Int"), stRecord([stField("l", stBase("Int")), stField("r", stBase("Int"))])),
      null,
      pipeline(
        stepFanout([
          fanoutField("l", pipeline(stepLit({ tag: "int", value: 1 }))),
          fanoutField("r", pipeline(stepLit({ tag: "int", value: 2 }))),
        ]),
      ),
    ),
  }]);
  const elabMod = makeAndElab(mod, "pair");
  expect(showValue(interpret(elabMod, "pair", vInt(99)))).toBe(showValue(vRecord({ l: vInt(1), r: vInt(2) })));
});

test("fold: sum([]) = 0, sum([1,2,3]) = 6", () => {
  const mod: Module = mkModule([], [], [
    { tag: "TypeDecl", decl: listTypeDecl },
    {
      tag: "DefDecl",
      decl: mkDefDecl(
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
      ),
    },
  ]);
  const elabMod = makeAndElab(mod, "sum");
  expect(showValue(interpret(elabMod, "sum", mkList([])))).toBe(showValue(vInt(0)));
  expect(showValue(interpret(elabMod, "sum", mkList([1, 2, 3])))).toBe(showValue(vInt(6)));
  expect(showValue(interpret(elabMod, "sum", mkList([10, 20])))).toBe(showValue(vInt(30)));
});

test("fold: length([]) = 0, length([5,5,5,5]) = 4", () => {
  const mod: Module = mkModule([], [], [
    { tag: "TypeDecl", decl: listTypeDecl },
    {
      tag: "DefDecl",
      decl: mkDefDecl(
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
      ),
    },
  ]);
  const elabMod = makeAndElab(mod, "length");
  expect(showValue(interpret(elabMod, "length", mkList([])))).toBe(showValue(vInt(0)));
  expect(showValue(interpret(elabMod, "length", mkList([5, 5, 5, 5])))).toBe(showValue(vInt(4)));
});

test("fold: safeHead([]) = None, safeHead([7,8,9]) = Some(7)", () => {
  const mod: Module = mkModule([], [], [
    { tag: "TypeDecl", decl: listTypeDecl },
    { tag: "TypeDecl", decl: maybeTypeDecl },
    {
      tag: "DefDecl",
      decl: mkDefDecl(
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
      ),
    },
  ]);
  const elabMod = makeAndElab(mod, "safeHead");

  const nilResult = interpret(elabMod, "safeHead", mkList([]));
  expect(nilResult.tag).toBe("variant");
  expect((nilResult as Extract<Value, { tag: "variant" }>).ctor).toBe("None");

  const consResult = interpret(elabMod, "safeHead", mkList([7, 8, 9]));
  expect(consResult.tag).toBe("variant");
  const consVariant = consResult as Extract<Value, { tag: "variant" }>;
  expect(consVariant.ctor).toBe("Some");
  const inner = consVariant.payload as Extract<Value, { tag: "record" }>;
  expect(showValue(inner.fields.get("value")!)).toBe(showValue(vInt(7)));
});

test("effect: perform double(5) = 10", () => {
  const mod: Module = mkModule([], [], [
    { tag: "EffectDecl", decl: mkEffectDecl("double", stBase("Int"), stBase("Int"), "sequential") },
    {
      tag: "DefDecl",
      decl: mkDefDecl(
        "applyDouble", [],
        stArrow(stBase("Int"), stBase("Int"), "sequential"),
        null,
        pipeline({
          tag: "Perform",
          op: ["double"],
          meta: { id: "perf1", span: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } },
        }),
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
  expect(showValue(interpret(elabMod, "applyDouble", vInt(5), effects))).toBe(showValue(vInt(10)));
});
