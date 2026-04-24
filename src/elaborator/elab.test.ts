/**
 * Elaborator sanity tests.
 * Re-uses the same modules from the typechecker tests and verifies that
 * elaboration produces valid, structurally correct Graph IR.
 */

import { checkModule } from "../typechecker/check.ts";
import { elaborateModule, resetElabCounters } from "./index.ts";
import { validateGraph } from "../ir/validate.ts";
import type { Graph, Node } from "../ir/ir.ts";

import {
  pipeline, stepFold, stepFanout, stepInfix, stepName, stepCtor,
  branch, nullaryHandler, recordHandler, bindBinder, wildcardBinder,
  fanoutField, stepLit,
  stBase, stTyVar, stNamed, stArrow, stField, stRecord,
  mkModule, mkTypeDeclVariant, mkDefDecl, mkCtorDecl,
  type Module, type TopDecl,
} from "../surface/ast.ts";
import type { TypedModule } from "../typechecker/typed-ast.ts";
import type { ElaboratedModule } from "../ir/ir.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OkResult<T> = { ok: true; value: T };
type FailResult  = { ok: false; errors: { message: string }[] };

function assertOk<T>(r: OkResult<T> | FailResult, label: string): T {
  if (!r.ok) {
    throw new Error(`${label}: expected ok, got errors:\n${r.errors.map((e) => `  - ${e.message}`).join("\n")}`);
  }
  return r.value;
}

function hasKind(g: Graph, kind: Node["kind"]): boolean {
  return g.nodes.some((n: Node) => n.kind === kind);
}

function countKind(g: Graph, kind: Node["kind"]): number {
  return g.nodes.filter((n: Node) => n.kind === kind).length;
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

function makeAndElab(mod: Module, label: string): ElaboratedModule {
  resetElabCounters();
  const typedMod = assertOk<TypedModule>(checkModule(mod), `${label}:typecheck`);
  const elabMod  = assertOk<ElaboratedModule>(elaborateModule(typedMod), `${label}:elab`);
  return elabMod;
}

// ---------------------------------------------------------------------------
// Test: def sum — fold produces CataNode
// ---------------------------------------------------------------------------

function test_sum_graph() {
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
  if (!graph) throw new Error("sum: no graph");

  // Must have a CataNode (fold)
  if (!hasKind(graph, "cata")) throw new Error("sum: expected CataNode");

  // Graph-level validation
  const vr = validateGraph(graph);
  if (!vr.ok) throw new Error(`sum: IR invalid: ${vr.errors.map((e) => e.message).join("; ")}`);

  // CataNode's input port type must be List Int
  const cata = graph.nodes.find((n) => n.kind === "cata")!;
  if (cata.kind !== "cata") throw new Error("sum: cata node wrong kind");
  if (cata.input.ty.tag !== "Named" || cata.input.ty.name !== "List")
    throw new Error(`sum: CataNode input should be List, got ${cata.input.ty.tag}`);
  if (cata.output.ty.tag !== "Int")
    throw new Error(`sum: CataNode output should be Int, got ${cata.output.ty.tag}`);

  // Algebra branch for Cons must have input type { head: Int, tail: Int } (Pi[Int/List Int])
  const consBranch = cata.algebra.find((b: { tag: string }) => b.tag === "Cons");
  if (!consBranch) throw new Error("sum: no Cons algebra branch");
  const branchInTy = consBranch.graph.inPort.ty;
  if (branchInTy.tag !== "Record") throw new Error("sum: Cons branch input should be record");
  const tailField = branchInTy.fields.find((f: { name: string }) => f.name === "tail");
  if (!tailField) throw new Error("sum: Cons branch missing tail field");
  if (tailField.ty.tag !== "Int")
    throw new Error(`sum: Cons branch tail field should be Int (substituted), got ${tailField.ty.tag}`);

  console.log("PASS test_sum_graph");
}

// ---------------------------------------------------------------------------
// Test: def length — fold with wildcard, produces CataNode
// ---------------------------------------------------------------------------

function test_length_graph() {
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
  if (!graph) throw new Error("length: no graph");

  if (!hasKind(graph, "cata")) throw new Error("length: expected CataNode");

  const vr = validateGraph(graph);
  if (!vr.ok) throw new Error(`length: IR invalid: ${vr.errors.map((e) => e.message).join("; ")}`);

  console.log("PASS test_length_graph");
}

// ---------------------------------------------------------------------------
// Test: def safeHead — case produces CaseNode (non-recursive ADT)
// ---------------------------------------------------------------------------

function test_safeHead_graph() {
  const safeHeadDef = mkDefDecl(
    "safeHead", [],
    stArrow(stNamed("List", stBase("Int")), stNamed("Maybe", stBase("Int"))),
    null,
    pipeline(
      stepFold([  // The typechecker promotes this to fold because List is recursive
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
  if (!graph) throw new Error("safeHead: no graph");

  // List is recursive, so case on List → CataNode
  if (!hasKind(graph, "cata")) throw new Error("safeHead: expected CataNode for List");

  const vr = validateGraph(graph);
  if (!vr.ok) throw new Error(`safeHead: IR invalid: ${vr.errors.map((e) => e.message).join("; ")}`);

  console.log("PASS test_safeHead_graph");
}

// ---------------------------------------------------------------------------
// Test: fanout produces DupNode + TupleNode
// ---------------------------------------------------------------------------

function test_fanout_graph() {
  // def pair : Int -> { l: Int, r: Int } =
  //   fanout { l: id, r: id }  (using stepName which resolves... hmm)
  // Actually: fanout { l: ..., r: ... } with a literal
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
  if (!graph) throw new Error("pair: no graph");

  if (!hasKind(graph, "dup")) throw new Error("pair: expected DupNode");
  if (!hasKind(graph, "tuple")) throw new Error("pair: expected TupleNode");

  const vr = validateGraph(graph);
  if (!vr.ok) throw new Error(`pair: IR invalid: ${vr.errors.map((e) => e.message).join("; ")}`);

  console.log("PASS test_fanout_graph");
}

// ---------------------------------------------------------------------------
// Test: literal produces ConstNode
// ---------------------------------------------------------------------------

function test_literal_graph() {
  const fortyTwoDef = mkDefDecl(
    "fortyTwo", [],
    stArrow(stBase("Unit"), stBase("Int")),
    null,
    pipeline(stepLit({ tag: "int", value: 42 })),
  );

  const mod: Module = mkModule([], [], [{ tag: "DefDecl", decl: fortyTwoDef }]);
  const elabMod = makeAndElab(mod, "fortyTwo");
  const graph = elabMod.defs.get("fortyTwo")!;
  if (!graph) throw new Error("fortyTwo: no graph");

  if (!hasKind(graph, "const")) throw new Error("fortyTwo: expected ConstNode");
  const cn = graph.nodes.find((n) => n.kind === "const")!;
  if (cn.kind !== "const" || cn.value.tag !== "int" || cn.value.value !== 42)
    throw new Error("fortyTwo: wrong const value");

  const vr = validateGraph(graph);
  if (!vr.ok) throw new Error(`fortyTwo: IR invalid: ${vr.errors.map((e) => e.message).join("; ")}`);

  console.log("PASS test_literal_graph");
}

// ---------------------------------------------------------------------------
// Test: all graphs are validated (provenance, concrete types, etc.)
// ---------------------------------------------------------------------------

function test_all_valid() {
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
    const vr = validateGraph(graph);
    if (!vr.ok) throw new Error(`all_valid: graph '${name}' invalid: ${vr.errors.map((e) => e.message).join("; ")}`);
  }
  console.log("PASS test_all_valid");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_sum_graph,
  test_length_graph,
  test_safeHead_graph,
  test_fanout_graph,
  test_literal_graph,
  test_all_valid,
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
