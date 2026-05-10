import { test, expect } from "vitest";
import { checkModule, type ModuleExports } from "./check.ts";
import { parseModule } from "../parser/index.ts";
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
        name:         "Foo.bar",
        params:       [],
        morphTy:      { input: { tag: "Unit" }, output: { tag: "Int" }, eff: "pure" },
        body:         pipeline(stepName("Foo.bar")),
        sourceId:     "seed_1",
        intrinsicEff: "pure" as const,
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

// ---------------------------------------------------------------------------
// Schema instantiation — effect precision
// ---------------------------------------------------------------------------

test("schema: declaration effect is upper bound, not instantiated effect", () => {
  // applySeq is declared `! sequential` but ALL sequential effect comes from the
  // param `f`. With a pure argument, the instantiated effect must be `pure`.
  // Before the fix, checkSchemaInst inherited the declaration's `sequential`,
  // causing `testPure` (declared `! pure`) to be falsely rejected.
  //
  // Unit -> Int is used so that a literal constant is the natural pure argument.
  // (Weave has no syntax for arithmetic on an anonymous non-record input, so
  // an Int -> Int function that adds one cannot be written without a record type.)
  const src = [
    "def applySeq (f: Unit -> Int ! sequential) : Unit -> Int ! sequential = f",
    "def five : Unit -> Int = 5",
    // Instantiate with a pure arg inside a def declared pure — must be accepted.
    "def testPure : Unit -> Int = applySeq(f: five)",
  ].join("\n");
  const mod = assertOk(parseModule(src), "parse");
  const r   = assertOk(checkModule(mod), "check");
  const def = r.typedDefs.get("testPure");
  expect(def).toBeDefined();
  // The instantiated effect is pure (not sequential), so the declared pure is met.
  expect(def!.morphTy.eff).toBe("pure");
});

test("schema: instantiated effect respects arg effect", () => {
  // With a sequential arg, the instantiated effect must be sequential.
  const src = [
    "effect io : Int -> Int ! sequential",
    "def applySeq (f: Int -> Int ! sequential) : Int -> Int ! sequential = f",
    "def testSeq : Int -> Int ! sequential = applySeq(f: perform io)",
  ].join("\n");
  const mod = assertOk(parseModule(src), "parse");
  const r   = assertOk(checkModule(mod), "check");
  const def = r.typedDefs.get("testSeq");
  expect(def).toBeDefined();
  expect(def!.morphTy.eff).toBe("sequential");
});

test("schema: instantiated effect cannot exceed declaration", () => {
  // The schema is declared `! pure`, but the arg is `! sequential`.
  // This must be rejected: the instantiated effect sequential > declared pure.
  const src = [
    "effect io : Int -> Int ! sequential",
    "def applyPure (f: Int -> Int ! pure) : Int -> Int ! pure = f",
    "def bad : Int -> Int ! sequential = applyPure(f: perform io)",
  ].join("\n");
  const mod = assertOk(parseModule(src), "parse");
  // checkModule should fail because perform io has sequential effect but param requires pure
  expect(checkModule(mod).ok).toBe(false);
});

test("schema: forward reference to schema sees correct intrinsicEff, not pure placeholder", () => {
  // 'use' instantiates 'applyIO' which is defined LATER in source order.
  // Without the two-sweep fix, 'use' would be checked before 'applyIO' is
  // processed, see applyIO.intrinsicEff = "pure" (placeholder), and wrongly
  // accept the instantiation as pure — masking an intrinsic sequential effect.
  const src = [
    "effect io : Unit -> Int ! sequential",
    "def use : Unit -> Int ! pure = applyIO(f: five)",  // forward ref to applyIO
    "def five : Unit -> Int = 5",
    "def applyIO (f: Unit -> Int ! sequential) : Unit -> Int ! sequential = perform io >>> f",
  ].join("\n");
  const mod = assertOk(parseModule(src), "parse");
  // applyIO has intrinsic sequential effect from `perform io`; even with a pure
  // arg, the instantiated effect is sequential — must be rejected as pure.
  expect(checkModule(mod).ok).toBe(false);
});

test("schema: schema-to-schema forward reference sees correct intrinsicEff", () => {
  // 'outer' instantiates 'inner' which is defined LATER in source order.
  // Without topological ordering in sweep 1, outer is checked before inner,
  // sees inner.intrinsicEff = "pure" (placeholder), records outer.intrinsicEff
  // = "pure", and wrongly accepts use : Unit -> Int ! pure = outer(f: five).
  const src = [
    "effect io : Unit -> Int ! sequential",
    "def outer (f: Unit -> Int ! sequential) : Unit -> Int ! sequential = inner(g: f)",
    "def use : Unit -> Int ! pure = outer(f: five)",  // must be rejected
    "def five : Unit -> Int = 5",
    "def inner (g: Unit -> Int ! sequential) : Unit -> Int ! sequential = perform io >>> g",
  ].join("\n");
  const mod = assertOk(parseModule(src), "parse");
  // inner has intrinsic sequential effect (from perform io); outer inherits it.
  // Instantiating outer with a pure arg still yields sequential — must be rejected.
  expect(checkModule(mod).ok).toBe(false);
});

test("schema: nested schema instantiation does not over-approximate intrinsic effect", () => {
  // outer(f) = inner(g: f): outer threads its own param into inner as an arg.
  // inner's intrinsicEff is "pure" (body is just g); outer's must also be "pure".
  // The old SchemaInst case returned step.morphTy.eff, which was "sequential"
  // because f had a sequential declared bound — causing outer(f: pure_arg) to be
  // wrongly rejected or inferred as sequential.
  const src = [
    "def inner (g: Unit -> Int ! sequential) : Unit -> Int ! sequential = g",
    "def outer (f: Unit -> Int ! sequential) : Unit -> Int ! sequential = inner(g: f)",
    "def five : Unit -> Int = 5",
    "def use : Unit -> Int = outer(f: five)",
  ].join("\n");
  const mod = assertOk(parseModule(src), "parse");
  const r   = assertOk(checkModule(mod), "check");
  const def = r.typedDefs.get("use");
  expect(def).toBeDefined();
  // With a pure arg, the instantiated effect must be pure, not sequential.
  expect(def!.morphTy.eff).toBe("pure");
});

test("schema: self-instantiation cycle is rejected (E_SCHEMA_CYCLE)", () => {
  // A schema whose body directly instantiates itself would unroll infinitely.
  // It must be rejected rather than checked with a stale pure placeholder.
  const src = [
    "def loop (f: Unit -> Int ! sequential) : Unit -> Int ! sequential = loop(f: f)",
  ].join("\n");
  const mod = assertOk(parseModule(src), "parse");
  const r = checkModule(mod);
  expect(r.ok).toBe(false);
  expect(r.ok ? null : r.errors[0]?.code).toBe("E_SCHEMA_CYCLE");
});

test("schema: mutual schema instantiation cycle is rejected (E_SCHEMA_CYCLE)", () => {
  // a instantiates b and b instantiates a — a two-node cycle.
  // Without cycle detection, one of them would be checked with the other's
  // pure placeholder, producing a soundness hole for effect inference.
  const src = [
    "effect io : Unit -> Int ! sequential",
    "def a (f: Unit -> Int ! sequential) : Unit -> Int ! sequential = b(g: f)",
    "def b (g: Unit -> Int ! sequential) : Unit -> Int ! sequential = perform io >>> a(f: g)",
  ].join("\n");
  const mod = assertOk(parseModule(src), "parse");
  const r = checkModule(mod);
  expect(r.ok).toBe(false);
  expect(r.ok ? null : r.errors[0]?.code).toBe("E_SCHEMA_CYCLE");
});
