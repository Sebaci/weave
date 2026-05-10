/**
 * Spec §10 (case) rules:
 *   - All branches must unify to the same output type (E_TYPE_MISMATCH on mismatch)
 *   - Effect = join of all branch effects (static upper bound, all branches count)
 *   - Exhaustiveness: all constructors must be covered (E_MISSING_BRANCH)
 *   - case does NOT carrier-substitute recursive fields (unlike fold) — tail: IntList stays IntList
 *
 * Note: "Bool" resolves to the builtin Bool type and cannot be used as a case input
 * through stNamed("Bool"). Use user-defined variant types with non-builtin names.
 */

import { test, expect } from "vitest";
import { checkModule } from "../../src/typechecker/check.ts";
import {
  pipeline, stepName, stepLit, stepCase, stepCtor, stepInfix,
  branch, nullaryHandler, recordHandler, bindBinder,
  mkModule, mkTypeDeclVariant, mkCtorDecl, mkDefDecl,
  stBase, stArrow, stNamed, stField,
  type TopDecl, type TypeDecl, type DefDecl,
} from "../../src/surface/ast.ts";

function topTy(d: TypeDecl): TopDecl { return { tag: "TypeDecl", decl: d }; }
function topDef(d: DefDecl): TopDecl { return { tag: "DefDecl", decl: d }; }

// type Coin = Heads | Tails   (non-builtin two-constructor variant)
const coinDecl = mkTypeDeclVariant("Coin", [], [
  mkCtorDecl("Heads", null),
  mkCtorDecl("Tails", null),
]);

// type IntList = Nil | Cons { head: Int, tail: IntList }
const intListDecl = mkTypeDeclVariant("IntList", [], [
  mkCtorDecl("Nil", null),
  mkCtorDecl("Cons", [
    stField("head", stBase("Int")),
    stField("tail", stNamed("IntList")),
  ]),
]);

// def seqOp : Unit -> Int ! sequential = 0
const seqOpDecl = mkDefDecl(
  "seqOp", [], stArrow(stBase("Unit"), stBase("Int"), "sequential"), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

// ---------------------------------------------------------------------------
// Branch type unification
// ---------------------------------------------------------------------------

test("case: all branches unify to same type (ok)", () => {
  // Both branches return Int.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Coin"), stBase("Int")), null,
    pipeline(stepCase([
      branch("Heads", nullaryHandler(pipeline(stepLit({ tag: "int", value: 1 })))),
      branch("Tails", nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(coinDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

test("case: branch type mismatch (E_TYPE_MISMATCH)", () => {
  // Heads returns Int (1), Tails returns Coin (Heads) → type mismatch.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Coin"), stBase("Int")), null,
    pipeline(stepCase([
      branch("Heads", nullaryHandler(pipeline(stepLit({ tag: "int", value: 1 })))),
      branch("Tails", nullaryHandler(pipeline(stepCtor("Heads")))),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(coinDecl), topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_TYPE_MISMATCH")).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Effect propagation
// ---------------------------------------------------------------------------

test("case: effect is join of all branch effects", () => {
  // Heads branch uses seqOp (sequential); Tails returns literal 0 (pure).
  // Join = sequential. Declaring ! pure (in stArrow) should fail.
  const defFail = mkDefDecl(
    "test", [], stArrow(stNamed("Coin"), stBase("Int"), "pure"), null,
    pipeline(stepCase([
      branch("Heads", nullaryHandler(pipeline(stepName("seqOp")))),
      branch("Tails", nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
    ])),
  );
  const rFail = checkModule(mkModule([], [], [topTy(coinDecl), topDef(seqOpDecl), topDef(defFail)]));
  expect(rFail.ok).toBe(false);
  if (!rFail.ok) {
    expect(rFail.errors.some((e) => e.code === "E_EFFECT_MISMATCH")).toBe(true);
  }

  const defOk = mkDefDecl(
    "test", [], stArrow(stNamed("Coin"), stBase("Int"), "sequential"), null,
    pipeline(stepCase([
      branch("Heads", nullaryHandler(pipeline(stepName("seqOp")))),
      branch("Tails", nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
    ])),
  );
  const rOk = checkModule(mkModule([], [], [topTy(coinDecl), topDef(seqOpDecl), topDef(defOk)]));
  expect(rOk.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// case vs fold: recursive ADT distinction
// ---------------------------------------------------------------------------

test("case: recursive ADT is valid input (Cons.tail retains raw IntList type)", () => {
  // case over IntList → Int. Cons handler returns head (Int), ignoring tail.
  // tail has type IntList (not carrier Int); using head alone is valid.
  // This confirms case accepts recursive ADTs without requiring carrier substitution.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), stBase("Int")), null,
    pipeline(stepCase([
      branch("Nil",  nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepName("head")),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(intListDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

test("case: Cons.tail is IntList, not carrier Int — head + tail fails (E_TYPE_MISMATCH)", () => {
  // fold substitutes tail: IntList → Int (carrier), making head + tail valid.
  // case does not substitute, so tail: IntList; Int + IntList → E_TYPE_MISMATCH.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), stBase("Int")), null,
    pipeline(stepCase([
      branch("Nil",  nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepInfix("+", stepName("head"), stepName("tail"))),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(intListDecl), topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_TYPE_MISMATCH")).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

test("case: missing branch (E_MISSING_BRANCH)", () => {
  // Only Heads branch provided; Tails is missing.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Coin"), stBase("Int")), null,
    pipeline(stepCase([
      branch("Heads", nullaryHandler(pipeline(stepLit({ tag: "int", value: 1 })))),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(coinDecl), topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_MISSING_BRANCH")).toBe(true);
  }
});
