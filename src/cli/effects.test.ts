import { test, expect } from "vitest";
import { validateBinding, resolveBuiltin, EffectBindError } from "./effects.ts";
import { TText, TUnit, TInt, record, field } from "../types/type.ts";
import type { OmegaEntry } from "../typechecker/typed-ast.ts";

function omega(inputTy: typeof TText, outputTy: typeof TUnit, eff: OmegaEntry["eff"]): OmegaEntry {
  return { qualifiedName: "test.op", inputTy, outputTy, eff, sourceId: 0 as never };
}

// ---------------------------------------------------------------------------
// resolveBuiltin
// ---------------------------------------------------------------------------

test("resolveBuiltin: known names succeed", () => {
  expect(() => resolveBuiltin("print")).not.toThrow();
  expect(() => resolveBuiltin("readFile")).not.toThrow();
  expect(() => resolveBuiltin("writeFile")).not.toThrow();
  expect(() => resolveBuiltin("getEnv")).not.toThrow();
});

test("resolveBuiltin: unknown name throws EffectBindError", () => {
  expect(() => resolveBuiltin("nonexistent")).toThrow(EffectBindError);
  expect(() => resolveBuiltin("nonexistent")).toThrow(/available/);
});

// ---------------------------------------------------------------------------
// validateBinding — type compatibility
// ---------------------------------------------------------------------------

test("validateBinding: print vs matching declaration is valid", () => {
  const spec = resolveBuiltin("print");
  const entry = omega(TText, TUnit, "sequential");
  expect(validateBinding(spec, entry)).toBeNull();
});

test("validateBinding: input type mismatch is an error", () => {
  const spec = resolveBuiltin("print");       // Text -> Unit
  const entry = omega(TInt, TUnit, "sequential");
  expect(validateBinding(spec, entry)).toMatch(/input type mismatch/);
});

test("validateBinding: output type mismatch is an error", () => {
  const spec = resolveBuiltin("readFile");    // Text -> Text
  const entry = omega(TText, TUnit, "sequential");
  expect(validateBinding(spec, entry)).toMatch(/output type mismatch/);
});

test("validateBinding: writeFile input type is a record", () => {
  const spec = resolveBuiltin("writeFile");
  const correctInput = record([field("path", TText), field("content", TText)]);
  const entry = omega(correctInput, TUnit, "sequential");
  expect(validateBinding(spec, entry)).toBeNull();
});

test("validateBinding: writeFile with wrong record fields is an error", () => {
  const spec = resolveBuiltin("writeFile");
  const wrongInput = record([field("src", TText), field("dst", TText)]);
  const entry = omega(wrongInput, TUnit, "sequential");
  expect(validateBinding(spec, entry)).toMatch(/input type mismatch/);
});

// ---------------------------------------------------------------------------
// validateBinding — effect level compatibility
// ---------------------------------------------------------------------------

test("validateBinding: getEnv (parallel-safe) vs parallel-safe is valid", () => {
  const spec = resolveBuiltin("getEnv");      // parallel-safe
  const entry = omega(TText, TText, "parallel-safe");
  expect(validateBinding(spec, entry)).toBeNull();
});

test("validateBinding: getEnv (parallel-safe) vs sequential is valid", () => {
  const spec = resolveBuiltin("getEnv");      // parallel-safe ≤ sequential
  const entry = omega(TText, TText, "sequential");
  expect(validateBinding(spec, entry)).toBeNull();
});

test("validateBinding: sequential built-in bound to parallel-safe declaration is an error", () => {
  const spec = resolveBuiltin("print");       // sequential
  const entry = omega(TText, TUnit, "parallel-safe");
  expect(validateBinding(spec, entry)).toMatch(/effect level mismatch/);
});
