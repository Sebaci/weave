import { checkModule } from "./typechecker/check.ts";
import { elaborateModule, resetElabCounters } from "./elaborator/index.ts";
import {
  mkTypeDeclVariant, mkCtorDecl, stField, stTyVar, stNamed,
  type Module,
} from "./surface/ast.ts";
import { vInt, vVariant, vRecord, VUnit, type Value } from "./interpreter/value.ts";
import type { TypedModule } from "./typechecker/typed-ast.ts";
import type { ElaboratedModule } from "./ir/ir.ts";

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

export type OkResult<T> = { ok: true; value: T };
export type FailResult  = { ok: false; errors: { message: string }[] };

export function assertOk<T>(r: OkResult<T> | FailResult, label: string): T {
  if (!r.ok) {
    throw new Error(
      `${label}: expected ok, got errors:\n${r.errors.map((e) => `  - ${e.message}`).join("\n")}`,
    );
  }
  return r.value;
}

export function assertValid(
  r: { ok: boolean; errors?: { message: string }[] },
  label: string,
): void {
  if (!r.ok) {
    const errs = r.errors ?? [];
    throw new Error(
      `${label}: validation failed:\n${errs.map((e) => `  - ${e.message}`).join("\n")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pipeline helper
// ---------------------------------------------------------------------------

export function makeAndElab(mod: Module, label: string): ElaboratedModule {
  resetElabCounters();
  const typedMod = assertOk<TypedModule>(checkModule(mod), `${label}:typecheck`);
  return assertOk<ElaboratedModule>(elaborateModule(typedMod), `${label}:elab`);
}

// ---------------------------------------------------------------------------
// Shared type declarations
// ---------------------------------------------------------------------------

// type List a = | Nil | Cons { head: a, tail: List a }
export const listTypeDecl = mkTypeDeclVariant("List", ["a"], [
  mkCtorDecl("Nil", null),
  mkCtorDecl("Cons", [
    stField("head", stTyVar("a")),
    stField("tail", stNamed("List", stTyVar("a"))),
  ]),
]);

// type Maybe a = | None | Some { value: a }
export const maybeTypeDecl = mkTypeDeclVariant("Maybe", ["a"], [
  mkCtorDecl("None", null),
  mkCtorDecl("Some", [stField("value", stTyVar("a"))]),
]);

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

export function mkList(vals: number[]): Value {
  let acc: Value = vVariant("Nil", VUnit);
  for (let i = vals.length - 1; i >= 0; i--)
    acc = vVariant("Cons", vRecord({ head: vInt(vals[i]!), tail: acc }));
  return acc;
}
