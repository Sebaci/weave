/**
 * Spec §9 (let) rules:
 *   - let is valid only inside a { fields } >>> scope or another let (E_LET_INVALID_SCOPE)
 *   - Duplication constraint: non-pure RHS used more than once → E_LET_DUPLICATE_USE
 *   - Pure RHS may be used any number of times
 *   - Effect: rhs.eff ⊔ body.eff
 */

import { test, expect } from "vitest";
import { checkModule } from "../../src/typechecker/check.ts";
import {
  pipeline, stepName, stepLit, stepFanout, stepCase, stepLet,
  fanoutField,
  branch, nullaryHandler, recordHandler, bindBinder,
  mkModule, mkTypeDeclVariant, mkCtorDecl, mkDefDecl,
  stBase, stArrow, stNamed, stRecord, stField,
  type TopDecl, type TypeDecl, type DefDecl,
} from "../../src/surface/ast.ts";

function topTy(d: TypeDecl): TopDecl { return { tag: "TypeDecl", decl: d }; }
function topDef(d: DefDecl): TopDecl { return { tag: "DefDecl", decl: d }; }

// type Wrap = Wrap { x: Int }
const wrapDecl = mkTypeDeclVariant("Wrap", [], [
  mkCtorDecl("Wrap", [stField("x", stBase("Int"))]),
]);

// def seqOp : Unit -> Int ! sequential = 0
// Effect annotation goes inside stArrow, not in the mkDefDecl eff arg.
const seqOpDecl = mkDefDecl(
  "seqOp", [], stArrow(stBase("Unit"), stBase("Int"), "sequential"), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

const recordPQInt = stRecord([stField("p", stBase("Int")), stField("q", stBase("Int"))]);
const recordRInt   = stRecord([stField("r", stBase("Int"))]);

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("let: invalid outside Γ_local scope (E_LET_INVALID_SCOPE)", () => {
  // def test : Int -> Int — no handler, so no Γ_local.
  // let x = 0 in x is invalid here.
  const def = mkDefDecl(
    "test", [], stArrow(stBase("Int"), stBase("Int")), null,
    pipeline(stepLet("x", pipeline(stepLit({ tag: "int", value: 0 })), pipeline(stepName("x")))),
  );
  const r = checkModule(mkModule([], [], [topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_LET_INVALID_SCOPE")).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Duplication constraint
// ---------------------------------------------------------------------------

test("let: pure RHS used multiple times (ok — no duplication constraint)", () => {
  // Inside Wrap handler: let y = x in fanout { p: y, q: y }
  // x is a LocalRef projection (pure). Using y twice is ok.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Wrap"), recordPQInt), null,
    pipeline(stepCase([
      branch("Wrap", recordHandler(
        [bindBinder("x")],
        pipeline(stepLet(
          "y",
          pipeline(stepName("x")),
          pipeline(stepFanout([
            fanoutField("p", pipeline(stepName("y"))),
            fanoutField("q", pipeline(stepName("y"))),
          ])),
        )),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(wrapDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

test("let: non-pure RHS used twice (E_LET_DUPLICATE_USE)", () => {
  // Inside Wrap handler: let y = seqOp in fanout { p: y, q: y }
  // seqOp : Unit -> Int ! sequential. y is used twice → E_LET_DUPLICATE_USE.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Wrap"), recordPQInt), null,
    pipeline(stepCase([
      branch("Wrap", recordHandler(
        [bindBinder("x")],
        pipeline(stepLet(
          "y",
          pipeline(stepName("seqOp")),
          pipeline(stepFanout([
            fanoutField("p", pipeline(stepName("y"))),
            fanoutField("q", pipeline(stepName("y"))),
          ])),
        )),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(wrapDecl), topDef(seqOpDecl), topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_LET_DUPLICATE_USE")).toBe(true);
  }
});

test("let: non-pure RHS used once (ok)", () => {
  // Inside Wrap handler: let y = seqOp in fanout { r: y }
  // y is sequential but used only once → no duplication constraint fires.
  // Body effect = sequential (from seqOp), so declare ! sequential.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Wrap"), recordRInt, "sequential"), null,
    pipeline(stepCase([
      branch("Wrap", recordHandler(
        [bindBinder("x")],
        pipeline(stepLet(
          "y",
          pipeline(stepName("seqOp")),
          pipeline(stepFanout([
            fanoutField("r", pipeline(stepName("y"))),
          ])),
        )),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(wrapDecl), topDef(seqOpDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Effect propagation
// ---------------------------------------------------------------------------

test("let: effect is rhs.eff ⊔ body.eff", () => {
  // let y = seqOp in fanout { r: y } → let eff = sequential ⊔ pure = sequential.
  // Declaring ! pure (in stArrow) should fail with E_EFFECT_MISMATCH.
  const defFail = mkDefDecl(
    "test", [], stArrow(stNamed("Wrap"), recordRInt, "pure"), null,
    pipeline(stepCase([
      branch("Wrap", recordHandler(
        [bindBinder("x")],
        pipeline(stepLet(
          "y",
          pipeline(stepName("seqOp")),
          pipeline(stepFanout([fanoutField("r", pipeline(stepName("y")))])),
        )),
      )),
    ])),
  );
  const rFail = checkModule(mkModule([], [], [topTy(wrapDecl), topDef(seqOpDecl), topDef(defFail)]));
  expect(rFail.ok).toBe(false);
  if (!rFail.ok) {
    expect(rFail.errors.some((e) => e.code === "E_EFFECT_MISMATCH")).toBe(true);
  }

  const defOk = mkDefDecl(
    "test", [], stArrow(stNamed("Wrap"), recordRInt, "sequential"), null,
    pipeline(stepCase([
      branch("Wrap", recordHandler(
        [bindBinder("x")],
        pipeline(stepLet(
          "y",
          pipeline(stepName("seqOp")),
          pipeline(stepFanout([fanoutField("r", pipeline(stepName("y")))])),
        )),
      )),
    ])),
  );
  const rOk = checkModule(mkModule([], [], [topTy(wrapDecl), topDef(seqOpDecl), topDef(defOk)]));
  expect(rOk.ok).toBe(true);
});
