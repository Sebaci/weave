/**
 * Spec §7 (build) and §8 (fanout) rules:
 *   - build: all field expressions must be closed (no Γ_local refs)
 *   - fanout: field expressions may reference Γ_local via norm_I Case A or be unit-sourced (Case B)
 *   - norm_I Case C: expression with domain X ≠ I and X ≠ 1 is rejected
 *   - effect = join of field expression effects
 *
 * Note: stArrow(from, to, eff) carries the declared effect; the mkDefDecl eff arg is
 * only used for unit-sourced (non-Arrow) defs and is ignored when ty is an Arrow.
 */

import { test, expect } from "vitest";
import { checkModule } from "../../src/typechecker/check.ts";
import {
  pipeline, stepName, stepLit, stepBuild, stepFanout, stepFold,
  buildField, fanoutField, fanoutShorthand,
  branch, nullaryHandler, recordHandler, bindBinder,
  mkModule, mkTypeDeclVariant, mkCtorDecl, mkDefDecl,
  stBase, stArrow, stNamed, stRecord, stField,
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

// def seqOp : Unit -> Int ! sequential = 0
// Effect annotation goes in stArrow, not in mkDefDecl (which ignores it for Arrow-typed defs).
const seqOpDecl = mkDefDecl(
  "seqOp", [], stArrow(stBase("Unit"), stBase("Int"), "sequential"), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

// def g : Int -> Int = 0   (domain = Int, for norm_I Case C test)
const gDecl = mkDefDecl(
  "g", [], stArrow(stBase("Int"), stBase("Int")), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

const recordAInt = stRecord([stField("a", stBase("Int"))]);

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

test("build: unit-sourced literal field is valid (ok)", () => {
  // def test : Unit -> { a: Int } = build { a: 0 }
  const def = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), recordAInt), null,
    pipeline(stepBuild([buildField("a", pipeline(stepLit({ tag: "int", value: 0 })))])),
  );
  const r = checkModule(mkModule([], [], [topDef(def)]));
  expect(r.ok).toBe(true);
});

test("build: rejects Γ_local reference (E_BUILD_AMBIENT_REF)", () => {
  // In the Cons handler, head is in Γ_local.
  // build { head: head } must be rejected regardless of declared output type.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), stBase("Int")), null,
    pipeline(stepFold([
      branch("Nil",  nullaryHandler(pipeline(stepLit({ tag: "int", value: 0 })))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepBuild([buildField("head", pipeline(stepName("head")))])),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(intListDecl), topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_BUILD_AMBIENT_REF")).toBe(true);
  }
});

test("build: effect is join of field expression effects", () => {
  // build { a: 0, b: seqOp } — a is pure, b is sequential → build eff = sequential.
  // Declaring ! pure (in the Arrow type) should fail; declaring ! sequential should succeed.
  const recordABInt = stRecord([stField("a", stBase("Int")), stField("b", stBase("Int"))]);

  const defFail = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), recordABInt, "pure"), null,
    pipeline(stepBuild([
      buildField("a", pipeline(stepLit({ tag: "int", value: 0 }))),
      buildField("b", pipeline(stepName("seqOp"))),
    ])),
  );
  const rFail = checkModule(mkModule([], [], [topDef(seqOpDecl), topDef(defFail)]));
  expect(rFail.ok).toBe(false);
  if (!rFail.ok) {
    expect(rFail.errors.some((e) => e.code === "E_EFFECT_MISMATCH")).toBe(true);
  }

  const defOk = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), recordABInt, "sequential"), null,
    pipeline(stepBuild([
      buildField("a", pipeline(stepLit({ tag: "int", value: 0 }))),
      buildField("b", pipeline(stepName("seqOp"))),
    ])),
  );
  const rOk = checkModule(mkModule([], [], [topDef(seqOpDecl), topDef(defOk)]));
  expect(rOk.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// fanout
// ---------------------------------------------------------------------------

test("fanout: accepts Γ_local reference via norm_I Case A (ok)", () => {
  // In the Cons handler, fanout { head } uses head (LocalRef, domain I) — Case A.
  // Both Nil and Cons produce { head: Int } so the fold is type-consistent.
  const recordHeadInt = stRecord([stField("head", stBase("Int"))]);
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), recordHeadInt), null,
    pipeline(stepFold([
      branch("Nil",  nullaryHandler(pipeline(stepBuild([buildField("head", pipeline(stepLit({ tag: "int", value: 0 })))])))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepFanout([fanoutShorthand("head")])),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(intListDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

test("fanout: accepts unit-sourced expression via norm_I Case B (lifted via !)", () => {
  // fanout { a: 42 } — 42 has domain 1, lifted via ! to domain I (Case B).
  const recordAInt = stRecord([stField("a", stBase("Int"))]);
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), recordAInt), null,
    pipeline(stepFold([
      branch("Nil",  nullaryHandler(pipeline(stepBuild([buildField("a", pipeline(stepLit({ tag: "int", value: 0 })))])))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepFanout([fanoutField("a", pipeline(stepLit({ tag: "int", value: 42 })))])),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(intListDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

test("fanout: rejects expression with domain X ≠ I and X ≠ 1 (norm_I Case C)", () => {
  // g : Int -> Int; inside Cons handler, input I = { head: Int, tail: A }.
  // g has domain Int; Int ≠ I and Int ≠ Unit → Case C → type error.
  const recordAInt = stRecord([stField("a", stBase("Int"))]);
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), recordAInt), null,
    pipeline(stepFold([
      branch("Nil",  nullaryHandler(pipeline(stepBuild([buildField("a", pipeline(stepLit({ tag: "int", value: 0 })))])))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepFanout([fanoutField("a", pipeline(stepName("g")))])),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(intListDecl), topDef(gDecl), topDef(def)]));
  expect(r.ok).toBe(false);
});

test("fanout: effect is join of field expression effects", () => {
  // Nil: 0 (pure); Cons: fanout { r: head (pure), s: seqOp (sequential) }.
  // Fold eff = pure ⊔ sequential = sequential.
  // Declaring ! pure (in stArrow) should fail.
  const recordRSInt = stRecord([stField("r", stBase("Int")), stField("s", stBase("Int"))]);

  const defFail = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), recordRSInt, "pure"), null,
    pipeline(stepFold([
      branch("Nil",  nullaryHandler(pipeline(stepBuild([
        buildField("r", pipeline(stepLit({ tag: "int", value: 0 }))),
        buildField("s", pipeline(stepLit({ tag: "int", value: 0 }))),
      ])))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepFanout([
          fanoutField("r", pipeline(stepName("head"))),
          fanoutField("s", pipeline(stepName("seqOp"))),
        ])),
      )),
    ])),
  );
  const rFail = checkModule(mkModule([], [], [topTy(intListDecl), topDef(seqOpDecl), topDef(defFail)]));
  expect(rFail.ok).toBe(false);
  if (!rFail.ok) {
    expect(rFail.errors.some((e) => e.code === "E_EFFECT_MISMATCH")).toBe(true);
  }

  const defOk = mkDefDecl(
    "test", [], stArrow(stNamed("IntList"), recordRSInt, "sequential"), null,
    pipeline(stepFold([
      branch("Nil",  nullaryHandler(pipeline(stepBuild([
        buildField("r", pipeline(stepLit({ tag: "int", value: 0 }))),
        buildField("s", pipeline(stepLit({ tag: "int", value: 0 }))),
      ])))),
      branch("Cons", recordHandler(
        [bindBinder("head"), bindBinder("tail")],
        pipeline(stepFanout([
          fanoutField("r", pipeline(stepName("head"))),
          fanoutField("s", pipeline(stepName("seqOp"))),
        ])),
      )),
    ])),
  );
  const rOk = checkModule(mkModule([], [], [topTy(intListDecl), topDef(seqOpDecl), topDef(defOk)]));
  expect(rOk.ok).toBe(true);
});
