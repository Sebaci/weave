/**
 * Spec §10a (case .field) rules:
 *   - k is eliminated: not present in any branch input type
 *   - Nullary branch input type = ρ (context row, R \ {k})
 *   - Record-payload branch input type = merge(Pi, ρ)
 *   - Field collision: fields(Pi) ∩ fields(ρ) = ∅ (E_FIELD_COLLISION)
 *   - Effect = join of branch effects
 */

import { test, expect } from "vitest";
import { checkModule } from "../../src/typechecker/check.ts";
import {
  pipeline, stepName, stepLit, stepCaseField,
  branch, nullaryHandler, recordHandler, bindBinder,
  mkModule, mkTypeDeclVariant, mkCtorDecl, mkDefDecl,
  stBase, stArrow, stNamed, stRecord, stField,
  type TopDecl, type TypeDecl, type DefDecl,
} from "../../src/surface/ast.ts";

function topTy(d: TypeDecl): TopDecl { return { tag: "TypeDecl", decl: d }; }
function topDef(d: DefDecl): TopDecl { return { tag: "DefDecl", decl: d }; }

// type Shape = Circle | Rect { w: Int, h: Int }   (no field collision with context x)
const shapeDecl = mkTypeDeclVariant("Shape", [], [
  mkCtorDecl("Circle", null),
  mkCtorDecl("Rect", [stField("w", stBase("Int")), stField("h", stBase("Int"))]),
]);

// type ShapeX = Circle | Rect { x: Int }   (Rect.x collides with context field x)
const shapeXDecl = mkTypeDeclVariant("ShapeX", [], [
  mkCtorDecl("Circle", null),
  mkCtorDecl("Rect", [stField("x", stBase("Int"))]),
]);

// Input type for tests: { x: Int, shape: Shape }
//   k = "shape", ρ = { x: Int }
const inputTy = stRecord([stField("x", stBase("Int")), stField("shape", stNamed("Shape"))]);
const inputTyX = stRecord([stField("x", stBase("Int")), stField("shapeX", stNamed("ShapeX"))]);

// ---------------------------------------------------------------------------
// Field collision
// ---------------------------------------------------------------------------

test("case .field: payload field colliding with context row (E_FIELD_COLLISION)", () => {
  // k = shapeX, ρ = { x: Int }.
  // Rect payload Pi = { x: Int }. fields(Pi) ∩ fields(ρ) = {x} → E_FIELD_COLLISION.
  const def = mkDefDecl(
    "test", [], stArrow(inputTyX, stBase("Int")), null,
    pipeline(stepCaseField("shapeX", [
      branch("Circle", nullaryHandler(pipeline(stepName("x")))),
      branch("Rect", recordHandler(
        [bindBinder("x")],
        pipeline(stepName("x")),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(shapeXDecl), topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_FIELD_COLLISION")).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Branch input types
// ---------------------------------------------------------------------------

test("case .field: nullary branch input type = ρ (context fields accessible)", () => {
  // k = shape, ρ = { x: Int }.
  // Circle is nullary: branch input = ρ. x is accessible inside Circle branch.
  const def = mkDefDecl(
    "test", [], stArrow(inputTy, stBase("Int")), null,
    pipeline(stepCaseField("shape", [
      branch("Circle", nullaryHandler(pipeline(stepName("x")))),
      branch("Rect", recordHandler(
        [bindBinder("w"), bindBinder("h")],
        pipeline(stepName("x")),  // x from ρ is accessible here too
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(shapeDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

test("case .field: record branch input type = merge(Pi, ρ) (Pi and ρ fields both accessible)", () => {
  // k = shape, ρ = { x: Int }, Rect Pi = { w: Int, h: Int }.
  // merge(Pi, ρ) = { w: Int, h: Int, x: Int }.
  // Both Pi fields (w, h) and ρ field (x) are accessible in Rect branch.
  const def = mkDefDecl(
    "test", [], stArrow(inputTy, stBase("Int")), null,
    pipeline(stepCaseField("shape", [
      branch("Circle", nullaryHandler(pipeline(stepName("x")))),
      branch("Rect", recordHandler(
        [bindBinder("w"), bindBinder("h")],
        pipeline(stepName("w")),  // Pi field accessible
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(shapeDecl), topDef(def)]));
  expect(r.ok).toBe(true);
});

test("case .field: eliminated field k is not in branch scope (E_UNDEFINED_NAME)", () => {
  // k = shape. Inside Circle branch, shape has been eliminated — referencing it is an error.
  const def = mkDefDecl(
    "test", [], stArrow(inputTy, stBase("Unit")), null,
    pipeline(stepCaseField("shape", [
      branch("Circle", nullaryHandler(pipeline(stepName("shape")))),  // shape not accessible
      branch("Rect", recordHandler(
        [bindBinder("w"), bindBinder("h")],
        pipeline(stepLit({ tag: "int", value: 0 })),
      )),
    ])),
  );
  const r = checkModule(mkModule([], [], [topTy(shapeDecl), topDef(def)]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.code === "E_UNDEFINED_NAME")).toBe(true);
  }
});
