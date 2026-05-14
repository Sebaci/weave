/**
 * Spec §Effect System — effect propagation rules:
 *   - >>> composition: effect(f >>> g) = effect(f) ⊔ effect(g)
 *   - Effect lattice: pure ⊑ parallel-safe ⊑ sequential
 *   - per-construct join rules (build, fanout, case, fold, let) are
 *     tested in their respective test files; this file focuses on
 *     >>> pipeline composition and the parallel-safe lattice level.
 */

import { test, expect } from "vitest";
import { checkModule } from "../../src/typechecker/check.ts";
import {
  pipeline, stepName, stepLit,
  mkModule, mkDefDecl,
  stBase, stArrow,
  type TopDecl, type DefDecl,
} from "../../src/surface/ast.ts";

function topDef(d: DefDecl): TopDecl { return { tag: "DefDecl", decl: d }; }

// def seqOp : Unit -> Int ! sequential = 0
const seqOpDecl = mkDefDecl(
  "seqOp", [], stArrow(stBase("Unit"), stBase("Int"), "sequential"), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

// def parOp : Unit -> Int ! parallel-safe = 0
// Pure body (rank 0) satisfies the parallel-safe (rank 1) declaration.
const parOpDecl = mkDefDecl(
  "parOp", [], stArrow(stBase("Unit"), stBase("Int"), "parallel-safe"), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

// def pureId : Int -> Int = 0  (pure pipeline stage for chaining)
const pureIdDecl = mkDefDecl(
  "pureId", [], stArrow(stBase("Int"), stBase("Int")), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

// def seqId : Int -> Int ! sequential = 0  (sequential pipeline stage)
const seqIdDecl = mkDefDecl(
  "seqId", [], stArrow(stBase("Int"), stBase("Int"), "sequential"), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

// ---------------------------------------------------------------------------
// parallel-safe lattice level
// ---------------------------------------------------------------------------

test("parallel-safe: pure body satisfies parallel-safe declaration", () => {
  // parOp declares ! parallel-safe; its body is a pure literal.
  // pure (rank 0) ≤ parallel-safe (rank 1) → ok.
  const r = checkModule(mkModule([], [], [topDef(parOpDecl)]));
  expect(r.ok).toBe(true);
});

test("parallel-safe: sequential body exceeds parallel-safe declaration (E_EFFECT_MISMATCH)", () => {
  // Body calls seqOp (sequential, rank 2); declared parallel-safe (rank 1) → fail.
  const def = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), stBase("Int"), "parallel-safe"), null,
    pipeline(stepName("seqOp")),
  );
  const r = checkModule(mkModule([], [], [topDef(seqOpDecl), topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_EFFECT_MISMATCH")).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// >>> composition: pure ⊔ sequential = sequential
// ---------------------------------------------------------------------------

test(">>>: sequential step then pure step → sequential (E_EFFECT_MISMATCH if declared pure)", () => {
  // seqOp >>> pureId : Unit -> Int; effect = sequential ⊔ pure = sequential.
  const defFail = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), stBase("Int"), "pure"), null,
    pipeline(stepName("seqOp"), stepName("pureId")),
  );
  const rFail = checkModule(mkModule([], [], [topDef(seqOpDecl), topDef(pureIdDecl), topDef(defFail)]));
  expect(rFail.ok).toBe(false);
  if (!rFail.ok) {
    expect(rFail.errors.some((e) => e.code === "E_EFFECT_MISMATCH")).toBe(true);
  }

  const defOk = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), stBase("Int"), "sequential"), null,
    pipeline(stepName("seqOp"), stepName("pureId")),
  );
  const rOk = checkModule(mkModule([], [], [topDef(seqOpDecl), topDef(pureIdDecl), topDef(defOk)]));
  expect(rOk.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// >>> composition: pure ⊔ parallel-safe = parallel-safe
// ---------------------------------------------------------------------------

test(">>>: pure step then parallel-safe step → parallel-safe (E_EFFECT_MISMATCH if declared pure)", () => {
  // parOp : Unit -> Int ! parallel-safe; pureId : Int -> Int ! pure
  // Wait, we need pure >>> parallel-safe. Use a pure-sourced step first:
  // seqOp is Unit -> Int so it doesn't chain after parOp.
  // Instead: parOp >>> pureId: parallel-safe ⊔ pure = parallel-safe.
  const defFail = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), stBase("Int"), "pure"), null,
    pipeline(stepName("parOp"), stepName("pureId")),
  );
  const rFail = checkModule(mkModule([], [], [topDef(parOpDecl), topDef(pureIdDecl), topDef(defFail)]));
  expect(rFail.ok).toBe(false);
  if (!rFail.ok) {
    expect(rFail.errors.some((e) => e.code === "E_EFFECT_MISMATCH")).toBe(true);
  }

  const defOk = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), stBase("Int"), "parallel-safe"), null,
    pipeline(stepName("parOp"), stepName("pureId")),
  );
  const rOk = checkModule(mkModule([], [], [topDef(parOpDecl), topDef(pureIdDecl), topDef(defOk)]));
  expect(rOk.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// >>> composition: parallel-safe ⊔ sequential = sequential
// ---------------------------------------------------------------------------

test(">>>: parallel-safe step then sequential step → sequential (E_EFFECT_MISMATCH if declared parallel-safe)", () => {
  // parOp >>> seqId : Unit -> Int; effect = parallel-safe ⊔ sequential = sequential.
  const defFail = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), stBase("Int"), "parallel-safe"), null,
    pipeline(stepName("parOp"), stepName("seqId")),
  );
  const rFail = checkModule(mkModule([], [], [topDef(parOpDecl), topDef(seqIdDecl), topDef(defFail)]));
  expect(rFail.ok).toBe(false);
  if (!rFail.ok) {
    expect(rFail.errors.some((e) => e.code === "E_EFFECT_MISMATCH")).toBe(true);
  }

  const defOk = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), stBase("Int"), "sequential"), null,
    pipeline(stepName("parOp"), stepName("seqId")),
  );
  const rOk = checkModule(mkModule([], [], [topDef(parOpDecl), topDef(seqIdDecl), topDef(defOk)]));
  expect(rOk.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// >>> composition: three-step chain
// ---------------------------------------------------------------------------

test(">>>: three-step chain inherits highest effect level", () => {
  // pureId >>> parOp >>> seqId would require pureId: Int -> Int, parOp: Int -> Int,
  // seqId: Int -> Int. But parOp is Unit -> Int. Instead test:
  // seqOp (Unit->Int, seq) >>> pureId (Int->Int, pure) >>> seqId (Int->Int, seq)
  // effect = sequential ⊔ pure ⊔ sequential = sequential.
  const def = mkDefDecl(
    "test", [], stArrow(stBase("Unit"), stBase("Int"), "sequential"), null,
    pipeline(stepName("seqOp"), stepName("pureId"), stepName("seqId")),
  );
  const r = checkModule(mkModule([], [], [topDef(seqOpDecl), topDef(pureIdDecl), topDef(seqIdDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});
