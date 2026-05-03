import { readFileSync, writeFileSync } from "node:fs";
import { VUnit, vText, type Value } from "../interpreter/value.ts";
import type { EffectHandlers } from "../interpreter/eval.ts";

export class EffectBindError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, EffectBindError.prototype);
  }
}

type Handler = (v: Value) => Value;

const BUILTINS: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  ["print", (v) => {
    if (v.tag !== "text") throw new Error(`print: expected Text, got ${v.tag}`);
    process.stdout.write(v.value + "\n");
    return VUnit;
  }],
  ["readFile", (v) => {
    if (v.tag !== "text") throw new Error(`readFile: expected Text (path), got ${v.tag}`);
    return vText(readFileSync(v.value, "utf-8"));
  }],
  ["writeFile", (v) => {
    if (v.tag !== "record") throw new Error(`writeFile: expected { path: Text, content: Text }, got ${v.tag}`);
    const path = v.fields.get("path");
    const content = v.fields.get("content");
    if (!path || path.tag !== "text") throw new Error(`writeFile: field 'path' must be Text`);
    if (!content || content.tag !== "text") throw new Error(`writeFile: field 'content' must be Text`);
    writeFileSync(path.value, content.value, "utf-8");
    return VUnit;
  }],
  ["getEnv", (v) => {
    if (v.tag !== "text") throw new Error(`getEnv: expected Text (variable name), got ${v.tag}`);
    return vText(process.env[v.value] ?? "");
  }],
]);

export const BUILTIN_NAMES: ReadonlyArray<string> = [...BUILTINS.keys()];

export function resolveBuiltin(name: string): Handler {
  const h = BUILTINS.get(name);
  if (!h) {
    throw new EffectBindError(
      `unknown built-in '${name}'; available: ${BUILTIN_NAMES.join(", ")}`,
    );
  }
  return h;
}

// Build initial effects map: print is auto-bound under bare and qualified names.
export function buildEffects(modulePrefix: string): EffectHandlers {
  const print = BUILTINS.get("print")!;
  const m: EffectHandlers = new Map();
  m.set("print", print);
  if (modulePrefix) m.set(`${modulePrefix}.print`, print);
  return m;
}
