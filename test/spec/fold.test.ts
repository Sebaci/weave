/**
 * Spec §11 (fold) rules:
 *   - Recursive fields in branch handlers have carrier type A, not the original μF
 *   - Effect = join of all branch effects (static upper bound)
 *   - fold is only valid on recursive ADTs (E_NOT_RECURSIVE_ADT otherwise)
 */

import { test, expect } from "vitest";
import { checkModule } from "../../src/typechecker/check.ts";
import {
  pipeline, stepName, stepLit, stepFold, stepInfix,
  branch, nullaryHandler, recordHandler, bindBinder,
  mkModule, mkTypeDeclVariant, mkCtorDecl, mkDefDecl,
  stBase, stArrow, stNamed, stField,
  type TopDecl, type TypeDecl, type DefDecl,
} from "../../src/surface/ast.ts";

function topTy(d: TypeDecl): TopDecl { return { tag: "TypeDecl", decl: d }; }
function topDef(d: DefDecl): TopDecl { return { tag: "DefDecl", decl: d }; }

// type IntList = Nil | Cons { head: Int, tail: IntList }
const intListDecl = mkTypeDeclVariant("IntList", [], [
  mkCtorDecl("Nil", null),
  mkCtorDecl("Cons", [
    stField("head", stBase("Int")),
    stField("tail", stNamed("IntList")),
  ]),
]);

// type Tree = Leaf | Node { left: Tree, right: Tree }   (two recursive positions)
const treeDecl = mkTypeDeclVariant("Tree", [], [
  mkCtorDecl("Leaf", null),
  mkCtorDecl("Node", [
    stField("left", stNamed("Tree")),
    stField("right", stNamed("Tree")),
  ]),
]);

// type Coin = Heads | Tails   (non-recursive, for fold-rejection test)
// Do NOT use builtin-shadowing names like "Bool".
const coinDecl = mkTypeDeclVariant("Coin", [], [
  mkCtorDecl("Heads", null),
  mkCtorDecl("Tails", null),
]);

// def seqOp : Unit -> Int ! sequential = 0
const seqOpDecl = mkDefDecl(
  "seqOp", [], stArrow(stBase("Unit"), stBase("Int"), "sequential"), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

// ---------------------------------------------------------------------------
// Carrier type
// ---------------------------------------------------------------------------

test("fold: recursive field has carrier type A in branch (head + tail compiles)", () => {
  // def sum : IntList -> Int = fold { Nil: 0, Cons: { head, tail } >>> head + tail }
  // If tail had type IntList (not the Int carrier), head + tail would fail type checking.
  // Success means tail correctly has type Int (the carrier).
  const def = mkDefDecl(
    "sum", [], stArrow(stNamed("IntList"), stBase("Int")), null,
    pipeline(stepFold([
      branch("Nil",  nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepInfix("+", stepName("head"), stepName("tail"))),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(intListDecl), topDef(def)]));
  expect(r.ok).toBe(true);

  if (r.ok) {
    const def_ = r.value.typedDefs.get("sum");
    expect(def_?.morphTy.output).toMatchObject({ tag: "Int" });
    expect(def_?.morphTy.eff).toBe("pure");
  }
});

// ---------------------------------------------------------------------------
// Effect propagation
// ---------------------------------------------------------------------------

test("fold: effect is join of all branch effects", () => {
  // Nil branch uses seqOp (sequential); Cons uses head + tail (pure arithmetic).
  // fold eff = sequential ⊔ pure = sequential.
  // Declaring ! pure (in stArrow) should fail.
  const defFail = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), stBase("Int"), "pure"), null,
    pipeline(stepFold([
      branch("Nil",  nullaryHandler(pipeline(stepName("seqOp")))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepInfix("+", stepName("head"), stepName("tail"))),
      )),
    ])),
  );
  const rFail = checkModule(mkModule([], [], [
    topTy(intListDecl), topDef(seqOpDecl), topDef(defFail),
  ]));
  expect(rFail.ok).toBe(false);
  if (!rFail.ok) {
    expect(rFail.errors.some((e) => e.code === "E_EFFECT_MISMATCH")).toBe(true);
  }

  const defOk = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), stBase("Int"), "sequential"), null,
    pipeline(stepFold([
      branch("Nil",  nullaryHandler(pipeline(stepName("seqOp")))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepInfix("+", stepName("head"), stepName("tail"))),
      )),
    ])),
  );
  const rOk = checkModule(mkModule([], [], [
    topTy(intListDecl), topDef(seqOpDecl), topDef(defOk),
  ]));
  expect(rOk.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Nested recursive positions
// ---------------------------------------------------------------------------

test("fold: all recursive fields in multi-recursive ADT have carrier type A (left + right compiles)", () => {
  // def size : Tree -> Int = fold { Leaf: 1, Node: { left, right } >>> left + right }
  // Tree has two recursive positions (left, right). fold must substitute both to the
  // carrier Int. If either were left as Tree, left + right would be a type error.
  const def = mkDefDecl(
    "size", [], stArrow(stNamed("Tree"), stBase("Int")), null,
    pipeline(stepFold([
      branch("Leaf", nullaryHandler(pipeline(stepLit({ tag: "int", value: 1 })))),
      branch("Node", recordHandler(
        [bindBinder("left"), bindBinder("right")],
        pipeline(stepInfix("+", stepName("left"), stepName("right"))),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(treeDecl), topDef(def)]));
  expect(r.ok).toBe(true);

  if (r.ok) {
    const def_ = r.value.typedDefs.get("size");
    expect(def_?.morphTy.output).toMatchObject({ tag: "Int" });
    expect(def_?.morphTy.eff).toBe("pure");
  }
});

// ---------------------------------------------------------------------------
// Validity
// ---------------------------------------------------------------------------

test("fold: rejected on non-recursive ADT (E_NOT_RECURSIVE_ADT)", () => {
  // Coin is a non-recursive variant — fold on Coin is a type error.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Coin"), stBase("Int")), null,
    pipeline(stepFold([
      branch("Heads", nullaryHandler(pipeline(stepLit({ tag: "int", value: 1 })))),
      branch("Tails", nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(coinDecl), topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_NOT_RECURSIVE_ADT")).toBe(true);
  }
});
