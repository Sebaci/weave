import { test, expect } from "vitest";
import { checkModule, type ModuleExports } from "../typechecker/check.ts";
import { elaborateModule, elaborateAll, resetElabCounters } from "./index.ts";
import { parseModule } from "../parser/index.ts";
import { interpret } from "../interpreter/eval.ts";
import { VUnit, showValue, vInt } from "../interpreter/value.ts";
import { validateGraph } from "../ir/validate.ts";
import type { Graph, Node } from "../ir/ir.ts";
import {
  pipeline, stepFold, stepFanout, stepName, stepCtor,
  branch, nullaryHandler, recordHandler, bindBinder, wildcardBinder,
  fanoutField, stepLit, stepInfix,
  stBase, stTyVar, stNamed, stArrow, stField, stRecord,
  mkModule, mkDefDecl,
  type Module,
} from "../surface/ast.ts";
import type { TypedModule } from "../typechecker/typed-ast.ts";
import type { ElaboratedModule } from "../ir/ir.ts";
import { assertOk, assertValid, listTypeDecl, maybeTypeDecl } from "../test-utils.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAndElab(mod: Module, label: string): ElaboratedModule {
  resetElabCounters();
  const typedMod = assertOk<TypedModule>(checkModule(mod), `${label}:typecheck`);
  return assertOk<ElaboratedModule>(elaborateModule(typedMod), `${label}:elab`);
}

function hasKind(g: Graph, kind: Node["kind"]): boolean {
  return g.nodes.some((n) => n.kind === kind);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("fold: sum produces CataNode with substituted Cons payload", () => {
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

  const mod: Module = mkModule([], [], [
    { tag: "TypeDecl", decl: listTypeDecl },
    { tag: "DefDecl",  decl: sumDef },
  ]);

  const elabMod = makeAndElab(mod, "sum");
  const graph = elabMod.defs.get("sum")!;
  expect(graph).toBeDefined();
  expect(hasKind(graph, "cata")).toBe(true);

  assertValid(validateGraph(graph),"sum IR");

  const cata = graph.nodes.find((n) => n.kind === "cata")!;
  expect(cata.kind).toBe("cata");
  if (cata.kind !== "cata") return;
  expect(cata.input.ty).toMatchObject({ tag: "Named", name: "List" });
  expect(cata.output.ty).toMatchObject({ tag: "Int" });

  // Cons branch inPort must be { head: Int, tail: Int } — tail substituted to carrier
  const consBranch = cata.algebra.find((b) => b.tag === "Cons");
  expect(consBranch).toBeDefined();
  const branchInTy = consBranch!.graph.inPort.ty;
  expect(branchInTy.tag).toBe("Record");
  if (branchInTy.tag !== "Record") return;
  const tailField = branchInTy.fields.find((f) => f.name === "tail");
  expect(tailField).toBeDefined();
  expect(tailField!.ty).toMatchObject({ tag: "Int" });
});

test("fold: length with wildcard — CataNode, valid IR", () => {
  const lengthDef = mkDefDecl(
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
    { tag: "DefDecl",  decl: lengthDef },
  ]);

  const elabMod = makeAndElab(mod, "length");
  const graph = elabMod.defs.get("length")!;
  expect(graph).toBeDefined();
  expect(hasKind(graph, "cata")).toBe(true);
  assertValid(validateGraph(graph),"length IR");
});

test("fold: safeHead on List produces CataNode", () => {
  const safeHeadDef = mkDefDecl(
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
    { tag: "DefDecl",  decl: safeHeadDef },
  ]);

  const elabMod = makeAndElab(mod, "safeHead");
  const graph = elabMod.defs.get("safeHead")!;
  expect(graph).toBeDefined();
  expect(hasKind(graph, "cata")).toBe(true);
  assertValid(validateGraph(graph),"safeHead IR");
});

test("fanout: produces DupNode and TupleNode", () => {
  const pairDef = mkDefDecl(
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

  const mod: Module = mkModule([], [], [{ tag: "DefDecl", decl: pairDef }]);
  const elabMod = makeAndElab(mod, "pair");
  const graph = elabMod.defs.get("pair")!;
  expect(graph).toBeDefined();
  expect(hasKind(graph, "dup")).toBe(true);
  expect(hasKind(graph, "tuple")).toBe(true);
  assertValid(validateGraph(graph),"pair IR");
});

test("literal: produces ConstNode with value 42", () => {
  const fortyTwoDef = mkDefDecl(
    "fortyTwo", [],
    stArrow(stBase("Unit"), stBase("Int")),
    null,
    pipeline(stepLit({ tag: "int", value: 42 })),
  );

  const mod: Module = mkModule([], [], [{ tag: "DefDecl", decl: fortyTwoDef }]);
  const elabMod = makeAndElab(mod, "fortyTwo");
  const graph = elabMod.defs.get("fortyTwo")!;
  expect(graph).toBeDefined();
  expect(hasKind(graph, "const")).toBe(true);

  const cn = graph.nodes.find((n) => n.kind === "const")!;
  expect(cn.kind).toBe("const");
  if (cn.kind !== "const") return;
  expect(cn.value).toEqual({ tag: "int", value: 42 });

  assertValid(validateGraph(graph),"fortyTwo IR");
});

test("all elaborated graphs pass IR validation", () => {
  const sumDef = mkDefDecl(
    "sum2", [],
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
    { tag: "DefDecl",  decl: sumDef },
  ]);

  const elabMod = makeAndElab(mod, "all_valid");
  for (const [name, graph] of elabMod.defs) {
    assertValid(validateGraph(graph),`graph '${name}'`);
  }
});

// ---------------------------------------------------------------------------
// Multi-module: elaborateAll
// ---------------------------------------------------------------------------

test("elaborateAll: cross-module Ref resolves and interprets correctly", () => {
  resetElabCounters();

  // Module A: "module A; def origin : Int = 42"
  const srcA = `module A\ndef origin : Int = 42`;
  const modA  = assertOk(parseModule(srcA), "modA:parse");
  const typedA = assertOk(checkModule(modA), "modA:check");

  // Seeds for module B: extracted from A
  const prefix = "A";
  const defInfo = typedA.typedDefs.get("origin")!;
  const seeds: ModuleExports = {
    defs: new Map([
      ["origin",   { name: "A.origin", params: [], morphTy: defInfo.morphTy, body: defInfo.surfaceBody, sourceId: defInfo.sourceId }],
      ["A.origin", { name: "A.origin", params: [], morphTy: defInfo.morphTy, body: defInfo.surfaceBody, sourceId: defInfo.sourceId }],
    ]),
    ctors:     new Map(),
    typeDecls: new Map(),
    omega:     new Map(),
  };
  void prefix;

  // Module B: "module B; import A; def result : Int = A.origin"
  const srcB = `module B\nimport A\ndef result : Int = A.origin`;
  const modB   = assertOk(parseModule(srcB), "modB:parse");
  const typedB = assertOk(checkModule(modB, seeds), "modB:check");

  // elaborateAll over both modules
  const modules = new Map([
    ["/a.weave", typedA],
    ["/b.weave", typedB],
  ]);
  const elabMod = assertOk(elaborateAll(modules), "elaborateAll");

  // "B.result" must be in defs (qualified name — elaborateAll uses qualified keys only)
  expect(elabMod.defs.has("B.result")).toBe(true);
  // "A.origin" must be in defs (qualified name, needed by RefNode)
  expect(elabMod.defs.has("A.origin")).toBe(true);

  // Interpret "B.result": should produce Int 42
  const value = interpret(elabMod, "B.result", VUnit);
  expect(showValue(value)).toBe(showValue(vInt(42)));
});

test("builtin operator does not shadow user def with same bare name", () => {
  // A headerless module defines `def add : Int -> Int = 100`.
  // A second def uses `1 + 2` (the builtin +).
  // They must not collide: `callAdd` must return 100, `three` must return 3.
  resetElabCounters();

  const src = [
    "def add : Int -> Int = 100",
    "def callAdd : Int -> Int = add",
    "def three : Unit -> Int = 1 + 2",
  ].join("\n");

  const mod     = assertOk(parseModule(src), "parse");
  const typed   = assertOk(checkModule(mod), "check");
  const elabMod = assertOk(elaborateModule(typed), "elab");

  // `callAdd` must evaluate to 100 — calls the user def, not the builtin
  const callAddResult = interpret(elabMod, "callAdd", vInt(0));
  expect(showValue(callAddResult)).toBe(showValue(vInt(100)));

  // `three` must evaluate to 3 — uses the builtin + operator
  const threeResult = interpret(elabMod, "three", VUnit);
  expect(showValue(threeResult)).toBe(showValue(vInt(3)));
});
