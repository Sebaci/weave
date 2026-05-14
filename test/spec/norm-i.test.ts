/**
 * Spec §5 (norm_I) — let RHS branch normalization:
 *   Case A: RHS has domain I → used directly (Γ_local projections)
 *   Case B: RHS has domain 1 → lifted via ! >>> (literals, build, unit-sourced globals)
 *   Case C: RHS has domain X ≠ I and X ≠ 1 → type error
 *
 * fanout norm_I cases are covered in build-fanout.test.ts.
 * This file tests norm_I exclusively in the let-binding context.
 */

import { test, expect } from "vitest";
import { checkModule } from "../../src/typechecker/check.ts";
import {
  pipeline, stepName, stepLit, stepCase, stepFanout, stepLet, stepBuild,
  fanoutField, fanoutShorthand, buildField,
  branch, recordHandler, bindBinder,
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

// def g : Int -> Int = 0  (domain = Int, for Case C test)
const gDecl = mkDefDecl(
  "g", [], stArrow(stBase("Int"), stBase("Int")), null,
  pipeline(stepLit({ tag: "int", value: 0 })),
);

const recordABInt = stRecord([stField("a", stBase("Int")), stField("b", stBase("Int"))]);

// ---------------------------------------------------------------------------
// Case A — RHS has domain I (Γ_local projection)
// ---------------------------------------------------------------------------

test("norm_I/let Case A: Γ_local projection as RHS accepted", () => {
  // Inside Wrap handler (I = { x: Int }): let y = x in y
  // x is a Γ_local projection with domain I → Case A, used directly.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Wrap"), stBase("Int")), null,
    pipeline(stepCase([
      branch("Wrap", recordHandler(
        [bindBinder("x")],
        pipeline(stepLet("y", pipeline(stepName("x")), pipeline(stepName("y")))),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(wrapDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Case B — RHS has domain 1 (unit-sourced, lifted via !)
// ---------------------------------------------------------------------------

test("norm_I/let Case B: literal RHS accepted (lifted via !)", () => {
  // Inside Wrap handler (I = { x: Int }): let y = 42 in fanout { a: x, b: y }
  // 42 has domain 1 → Case B, lifted via ! >>>.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Wrap"), recordABInt), null,
    pipeline(stepCase([
      branch("Wrap", recordHandler(
        [bindBinder("x")],
        pipeline(stepLet(
          "y",
          pipeline(stepLit({ tag: "int", value: 42 })),
          pipeline(stepFanout([
            fanoutField("a", pipeline(stepName("x"))),
            fanoutField("b", pipeline(stepName("y"))),
          ])),
        )),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(wrapDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

test("norm_I/let Case B: build expression as RHS accepted (unit-sourced, lifted via !)", () => {
  // Inside Wrap handler: let y = build { b: 0 } in y
  // build { b: 0 } : 1 -> { b: Int } → Case B (lifted via !).
  const recordBInt = stRecord([stField("b", stBase("Int"))]);
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Wrap"), recordBInt), null,
    pipeline(stepCase([
      branch("Wrap", recordHandler(
        [bindBinder("x")],
        pipeline(stepLet(
          "y",
          pipeline(stepBuild([buildField("b", pipeline(stepLit({ tag: "int", value: 0 })))])),
          pipeline(stepName("y")),
        )),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(wrapDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Case C — RHS has wrong domain (X ≠ I and X ≠ 1) → type error
// ---------------------------------------------------------------------------

test("norm_I/let Case C: RHS with domain X ≠ I and X ≠ 1 rejected", () => {
  // Inside Wrap handler (I = { x: Int }): let y = g in y
  // g : Int -> Int; domain Int ≠ { x: Int } (I) and Int ≠ Unit (1) → Case C → type error.
  const def = mkDefDecl(
    "test", [], stArrow(stNamed("Wrap"), stBase("Int")), null,
    pipeline(stepCase([
      branch("Wrap", recordHandler(
        [bindBinder("x")],
        pipeline(stepLet("y", pipeline(stepName("g")), pipeline(stepName("y")))),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(wrapDecl), topDef(gDecl), topDef(def)]));
  expect(r.ok).toBe(false);
});
