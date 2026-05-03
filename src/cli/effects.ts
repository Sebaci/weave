import { readFileSync, writeFileSync } from "node:fs";
import { typeEq } from "../types/check.ts";
import { TText, TUnit, record, field, type Type, type ConcreteEffect } from "../types/type.ts";
import { showType } from "../typechecker/index.ts";
import { VUnit, vText, type Value } from "../interpreter/value.ts";
import type { EffectHandlers } from "../interpreter/eval.ts";
import type { OmegaEntry } from "../typechecker/typed-ast.ts";

export class EffectBindError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, EffectBindError.prototype);
  }
}

type Handler = (v: Value) => Value;

export type BuiltinSpec = {
  inputTy:  Type;
  outputTy: Type;
  eff:      ConcreteEffect;
  handler:  Handler;
};

const WRITE_FILE_INPUT: Type = record([field("path", TText), field("content", TText)]);

const BUILTINS: ReadonlyMap<string, BuiltinSpec> = new Map<string, BuiltinSpec>([
  ["print", {
    inputTy: TText, outputTy: TUnit, eff: "sequential",
    handler: (v) => {
      if (v.tag !== "text") throw new Error(`print: expected Text, got ${v.tag}`);
      process.stdout.write(v.value + "\n");
      return VUnit;
    },
  }],
  ["readFile", {
    inputTy: TText, outputTy: TText, eff: "sequential",
    handler: (v) => {
      if (v.tag !== "text") throw new Error(`readFile: expected Text (path), got ${v.tag}`);
      return vText(readFileSync(v.value, "utf-8"));
    },
  }],
  ["writeFile", {
    inputTy: WRITE_FILE_INPUT, outputTy: TUnit, eff: "sequential",
    handler: (v) => {
      if (v.tag !== "record") throw new Error(`writeFile: expected { path: Text, content: Text }, got ${v.tag}`);
      const path = v.fields.get("path");
      const content = v.fields.get("content");
      if (!path || path.tag !== "text") throw new Error(`writeFile: field 'path' must be Text`);
      if (!content || content.tag !== "text") throw new Error(`writeFile: field 'content' must be Text`);
      writeFileSync(path.value, content.value, "utf-8");
      return VUnit;
    },
  }],
  ["getEnv", {
    inputTy: TText, outputTy: TText, eff: "parallel-safe",
    handler: (v) => {
      if (v.tag !== "text") throw new Error(`getEnv: expected Text (variable name), got ${v.tag}`);
      return vText(process.env[v.value] ?? "");
    },
  }],
]);

export const BUILTIN_NAMES: ReadonlyArray<string> = [...BUILTINS.keys()];

const EFFECT_RANK: Record<ConcreteEffect, number> = {
  "pure": 0, "parallel-safe": 1, "sequential": 2,
};

export function resolveBuiltin(name: string): BuiltinSpec {
  const spec = BUILTINS.get(name);
  if (!spec) {
    throw new EffectBindError(
      `unknown built-in '${name}'; available: ${BUILTIN_NAMES.join(", ")}`,
    );
  }
  return spec;
}

// Returns a human-readable error string, or null if compatible.
export function validateBinding(spec: BuiltinSpec, entry: OmegaEntry): string | null {
  if (!typeEq(spec.inputTy, entry.inputTy)) {
    return `input type mismatch: declared ${showType(entry.inputTy)}, built-in provides ${showType(spec.inputTy)}`;
  }
  if (!typeEq(spec.outputTy, entry.outputTy)) {
    return `output type mismatch: declared ${showType(entry.outputTy)}, built-in provides ${showType(spec.outputTy)}`;
  }
  // The built-in must not be more effectful than what the declaration promises.
  if (EFFECT_RANK[spec.eff] > EFFECT_RANK[entry.eff]) {
    return `effect level mismatch: declared '${entry.eff}', built-in requires '${spec.eff}'`;
  }
  return null;
}

// Build initial effects map: print is auto-bound under bare and qualified names.
export function buildEffects(modulePrefix: string): EffectHandlers {
  const print = BUILTINS.get("print")!.handler;
  const m: EffectHandlers = new Map();
  m.set("print", print);
  if (modulePrefix) m.set(`${modulePrefix}.print`, print);
  return m;
}
