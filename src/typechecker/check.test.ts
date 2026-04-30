import { test, expect } from "vitest";
import { checkModule, type ModuleExports } from "./check.ts";
import {
  pipeline, stepFold, stepFanout, stepInfix, stepName, stepCtor, stepCase,
  branch, nullaryHandler, recordHandler, bindBinder, wildcardBinder,
  fanoutField, fanoutShorthand,
  stepLit,
  stBase, stTyVar, stNamed, stArrow, stRecord, stField,
  mkModule, mkTypeDeclVariant, mkDefDecl, mkCtorDecl, mkDefParam,
  type Module, type TopDecl,
} from "../surface/ast.ts";
import { assertOk, listTypeDecl, maybeTypeDecl } from "../test-utils.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function topTypeDecl(decl: ReturnType<typeof mkTypeDeclVariant>): TopDecl {
  return { tag: "TypeDecl", decl };
}

function topDefDecl(decl: ReturnType<typeof mkDefDecl>): TopDecl {
  return { tag: "DefDecl", decl };
}

// type Bool = | True | False  (local — not shared with other test files)
const boolTypeDecl = mkTypeDeclVariant("Bool", [], [
  mkCtorDecl("True", null),
  mkCtorDecl("False", null),
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("sum: List Int -> Int, pure", () => {
  const sumDef = mkDefDecl(
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

  const mod: Module = mkModule([], [], [topTypeDecl(listTypeDecl), topDefDecl(sumDef)]);
  const r = assertOk(checkModule(mod), "sum");

  const def = r.typedDefs.get("sum");
  expect(def).toBeDefined();
  expect(def!.morphTy.input).toMatchObject({ tag: "Named", name: "List" });
  expect(def!.morphTy.output).toMatchObject({ tag: "Int" });
  expect(def!.morphTy.eff).toBe("pure");
});

test("length: List a -> Int", () => {
  const lengthDef = mkDefDecl(
    "length", [],
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

  const mod: Module = mkModule([], [], [topTypeDecl(listTypeDecl), topDefDecl(lengthDef)]);
  const r = assertOk(checkModule(mod), "length");

  const def = r.typedDefs.get("length");
  expect(def).toBeDefined();
  expect(def!.morphTy.output).toMatchObject({ tag: "Int" });
});

test("map: List a -> List b with pure f", () => {
  const mapDef = mkDefDecl(
    "map",
    [mkDefParam("f", stArrow(stTyVar("a"), stTyVar("b"), "pure"))],
    stArrow(stNamed("List", stTyVar("a")), stNamed("List", stTyVar("b")), "pure"),
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

  const mod: Module = mkModule([], [], [topTypeDecl(listTypeDecl), topDefDecl(mapDef)]);
  const r = assertOk(checkModule(mod), "map");

  const def = r.typedDefs.get("map");
  expect(def).toBeDefined();
  expect(def!.morphTy.input).toMatchObject({ tag: "Named", name: "List" });
  expect(def!.morphTy.output).toMatchObject({ tag: "Named", name: "List" });
});

test("safeHead: List a -> Maybe a", () => {
  const safeHeadDef = mkDefDecl(
    "safeHead", [],
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
  expect(def).toBeDefined();
  expect(def!.morphTy.output).toMatchObject({ tag: "Named", name: "Maybe" });
});

test("type error: infix + on Bool operands", () => {
  const badDef = mkDefDecl(
    "bad", [],
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
  expect(checkModule(mod).ok).toBe(false);
});

test("type error: unknown infix operator **", () => {
  const badDef = mkDefDecl(
    "bad", [],
    stArrow(stBase("Int"), stBase("Int")),
    null,
    pipeline(stepInfix("**", stepName("bad"), stepLit({ tag: "int", value: 2 }))),
  );
  const mod: Module = mkModule([], [], [topDefDecl(badDef)]);
  expect(checkModule(mod).ok).toBe(false);
});

test("qualified name: Foo.bar resolves when seeded as qualified def", () => {
  const seeds: ModuleExports = {
    defs: new Map([
      ["Foo.bar", {
        name:     "Foo.bar",
        params:   [],
        morphTy:  { input: { tag: "Unit" }, output: { tag: "Int" }, eff: "pure" },
        body:     pipeline(stepName("Foo.bar")),
        sourceId: "seed_1",
      }],
    ]),
    ctors:     new Map(),
    typeDecls: new Map(),
    omega:     new Map(),
  };

  const mod: Module = mkModule([], [], [
    topDefDecl(mkDefDecl("result", [], stBase("Int"), null, pipeline(stepName("Foo.bar")))),
  ]);

  const r = assertOk(checkModule(mod, seeds), "qualified name resolution");
  const def = r.typedDefs.get("result");
  expect(def).toBeDefined();
  expect(def?.morphTy.output).toMatchObject({ tag: "Int" });
});
