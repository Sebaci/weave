import { resolve } from "node:path";
import { showType } from "../typechecker/index.ts";
import { elaborateAll } from "../elaborator/index.ts";
import { runRepl } from "./repl.ts";
import { interpret, MissingEffectHandlerError } from "../interpreter/eval.ts";
import { showValue, VUnit, type Value } from "../interpreter/value.ts";
import { buildModuleGraph, type ModuleGraph } from "../module/resolver.ts";
import { checkAll, type LoadError } from "../module/loader.ts";
import {
  renderLoadError, renderResolverError,
  loadErrorToJson, resolverErrorToJson,
  type JsonOutput,
} from "./diagnostics.ts";
import { decodeInput, InputDecodeError } from "./input.ts";
import { buildEffects, bindBothAliases } from "./effects.ts";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const [,, command, filePath, ...rest] = process.argv;

if (command === "check") {
  const jsonFlag = rest.indexOf("--json");
  const jsonMode = jsonFlag !== -1;
  const remaining = rest.filter((_, i) => i !== jsonFlag);
  if (!filePath || remaining.length > 0) {
    die("Usage: weave check <file> [--json]");
  }
  runCheck(filePath, jsonMode);
} else if (command === "run") {
  let defName: string | undefined;
  let inputJson: string | undefined;
  const effectBindings: Array<[string, string]> = [];
  const USAGE = "Usage: weave run <file> --def <name> [--input '<json>'] [--effect <op>=<builtin>]...";
  const args = [...rest];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--def" && args[i + 1]) {
      defName = args[++i];
    } else if (args[i] === "--input" && args[i + 1] !== undefined) {
      inputJson = args[++i];
    } else if (args[i] === "--effect" && args[i + 1] !== undefined) {
      const spec = args[++i]!;
      const eq = spec.indexOf("=");
      if (eq < 1 || eq === spec.length - 1) die(`--effect must be in the form <op>=<builtin>\n${USAGE}`);
      effectBindings.push([spec.slice(0, eq), spec.slice(eq + 1)]);
    } else {
      die(USAGE);
    }
  }
  if (!filePath || !defName) {
    die(USAGE);
  }
  runRun(filePath, defName, inputJson, effectBindings);
} else if (command === "repl") {
  if (filePath !== undefined || rest.length > 0) {
    die("Usage: weave repl");
  }
  runRepl();
} else {
  console.error("Usage:");
  console.error("  weave check <file> [--json]");
  console.error("  weave run <file> --def <name> [--input '<json>'] [--effect <op>=<builtin>]...");
  console.error("  weave repl");
  console.error("");
  console.error("Note: effect ops named 'print' are automatically bound to the print builtin.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function runCheck(file: string, json: boolean): void {
  const graphResult = buildModuleGraph(file);
  if (!graphResult.ok) {
    if (json) {
      emitJson({ ok: false, errors: graphResult.errors.map(resolverErrorToJson) });
    } else {
      for (const err of graphResult.errors) {
        console.error(renderResolverError(err, graphResult.sources));
      }
    }
    process.exit(1);
  }

  const sources = graphSources(graphResult.graph);
  const loadResult = checkAll(graphResult.graph, resolve(file));
  if (!loadResult.ok) {
    if (json) {
      emitJson({ ok: false, errors: loadResult.errors.map(loadErrorToJson) });
    } else {
      for (const err of loadResult.errors) {
        console.error(renderLoadError(err, sources.get(err.filePath)));
      }
    }
    process.exit(1);
  }

  if (json) {
    emitJson({ ok: true });
  } else {
    console.log(`${file}: OK`);
  }
}

function runRun(file: string, defName: string, inputJson?: string, effectBindings: Array<[string, string]> = []): void {
  // --- Resolve + Parse + Typecheck (all modules) ---
  const graphResult = buildModuleGraph(file);
  if (!graphResult.ok) {
    for (const err of graphResult.errors) {
      console.error(renderResolverError(err, graphResult.sources));
    }
    process.exit(1);
  }

  const sources = graphSources(graphResult.graph);
  const absFile  = resolve(file);
  const loadResult = checkAll(graphResult.graph, absFile);
  if (!loadResult.ok) {
    for (const err of loadResult.errors) {
      console.error(renderLoadError(err, sources.get(err.filePath)));
    }
    process.exit(1);
  }

  const typedMod = loadResult.modules.get(absFile);
  if (!typedMod) die(`weave run: internal error: entry module not found after check`);
  const mod = graphResult.graph.get(absFile)!.mod;

  // --- Check def exists ---
  const typedDef = typedMod.typedDefs.get(defName);
  if (!typedDef) {
    die(`weave run: no def '${defName}' in ${file}`);
  }
  const inputTy = typedDef.morphTy.input;

  // --- Elaborate (all modules, so cross-module refs resolve at runtime) ---
  const elabResult = elaborateAll(loadResult.modules);
  if (!elabResult.ok) {
    for (const err of elabResult.errors) {
      const loadErr: LoadError = { code: err.code, phase: "elaborate", filePath: file, message: err.message, span: err.span };
      console.error(renderLoadError(loadErr, undefined));
    }
    process.exit(1);
  }
  const elabMod = elabResult.value;

  // Augment host effects with qualified names (e.g. "Examples.Hello.print")
  // so that `perform Examples.Hello.print` and `perform print` both resolve.
  const modulePrefix = mod.path.join(".");
  const qualDefName = modulePrefix ? `${modulePrefix}.${defName}` : defName;

  // Guard: schema/polymorphic defs are omitted from the elaborated graph map.
  if (!elabMod.defs.has(qualDefName)) {
    die(`weave run: def '${defName}' is polymorphic and cannot be run directly`);
  }

  // Auto-bind print across all omega entries whose canonical name has bare name "print".
  const effects = buildEffects(elabMod.omega, "weave run");
  if (!effects) process.exit(1);

  // Resolve and validate explicit --effect bindings.
  for (const [op, builtinName] of effectBindings) {
    if (!elabMod.omega.has(op)) {
      die(`weave run: --effect ${op}=${builtinName}: '${op}' is not a declared effect op in this program`);
    }
    if (!bindBothAliases(effects, op, builtinName, elabMod.omega, "weave run")) process.exit(1);
  }

  // --- Resolve input value ---
  let inputValue: Value;
  if (inputJson !== undefined) {
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(inputJson);
    } catch {
      die(`weave run: --input is not valid JSON`);
    }
    try {
      inputValue = decodeInput(rawJson, inputTy, elabMod.typeDecls);
    } catch (e) {
      if (e instanceof InputDecodeError) {
        die(
          `weave run: --input does not match expected type ${showType(inputTy)}\n  ${e.message}`,
        );
      }
      throw e;
    }
  } else if (inputTy.tag === "Unit") {
    inputValue = VUnit;
  } else {
    die(
      `weave run: def '${defName}' expects input type ${showType(inputTy)}; ` +
      `use --input '<json>' to supply a value`,
    );
  }

  // --- Interpret ---
  try {
    const result = interpret(elabMod, qualDefName, inputValue, effects);
    if (result.tag !== "unit") console.log(showValue(result));
  } catch (e) {
    if (e instanceof MissingEffectHandlerError) {
      die(`weave run: no runtime binding for effect operation '${e.op}'`);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function graphSources(graph: ModuleGraph): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  for (const [path, node] of graph) m.set(path, node.source);
  return m;
}

function emitJson(output: JsonOutput): void {
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}
