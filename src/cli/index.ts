import { resolve } from "node:path";
import { showType } from "../typechecker/index.ts";
import { elaborateAll } from "../elaborator/index.ts";
import { interpret, MissingEffectHandlerError, type EffectHandlers } from "../interpreter/eval.ts";
import { showValue, VUnit, type Value } from "../interpreter/value.ts";
import { buildModuleGraph, type ModuleGraph } from "../module/resolver.ts";
import { checkAll } from "../module/loader.ts";
import { renderLoadError, renderResolverError } from "./diagnostics.ts";

// ---------------------------------------------------------------------------
// Host effect bindings supplied by the CLI runtime
// ---------------------------------------------------------------------------

const HOST_EFFECTS: EffectHandlers = new Map([
  ["print", (v: Value) => {
    if (v.tag !== "text") throw new Error(`print: expected Text, got ${v.tag}`);
    process.stdout.write(v.value + "\n");
    return VUnit;
  }],
]);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const [,, command, filePath, ...rest] = process.argv;

if (command === "check") {
  if (!filePath || rest.length > 0) {
    die("Usage: npm run cli -- check <file>");
  }
  runCheck(filePath);
} else if (command === "run") {
  if (!filePath || rest.length !== 2 || rest[0] !== "--def" || !rest[1]) {
    die("Usage: npm run cli -- run <file> --def <name>");
  }
  runRun(filePath, rest[1]);
} else {
  console.error("Usage:");
  console.error("  npm run cli -- check <file>");
  console.error("  npm run cli -- run <file> --def <name>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function runCheck(file: string): void {
  const graphResult = buildModuleGraph(file);
  if (!graphResult.ok) {
    for (const err of graphResult.errors) {
      console.error(renderResolverError(err, graphResult.sources));
    }
    process.exit(1);
  }

  const sources = graphSources(graphResult.graph);
  const loadResult = checkAll(graphResult.graph, file);
  if (!loadResult.ok) {
    for (const err of loadResult.errors) {
      console.error(renderLoadError(err, sources.get(err.filePath)));
    }
    process.exit(1);
  }

  console.log(`${file}: OK`);
}

function runRun(file: string, defName: string): void {
  // --- Resolve + Parse + Typecheck (all modules) ---
  const graphResult = buildModuleGraph(file);
  if (!graphResult.ok) {
    for (const err of graphResult.errors) {
      console.error(renderResolverError(err, graphResult.sources));
    }
    process.exit(1);
  }

  const sources = graphSources(graphResult.graph);
  const loadResult = checkAll(graphResult.graph, file);
  if (!loadResult.ok) {
    for (const err of loadResult.errors) {
      console.error(renderLoadError(err, sources.get(err.filePath)));
    }
    process.exit(1);
  }

  const absFile  = resolve(file);
  const typedMod = loadResult.modules.get(absFile);
  if (!typedMod) die(`weave run: internal error: entry module not found after check`);
  const mod = graphResult.graph.get(absFile)!.mod;

  // --- Check def exists and takes Unit input ---
  const typedDef = typedMod.typedDefs.get(defName);
  if (!typedDef) {
    die(`weave run: no def '${defName}' in ${file}`);
  }
  if (typedDef.morphTy.input.tag !== "Unit") {
    die(
      `weave run: def '${defName}' expects input type ${showType(typedDef.morphTy.input)}, ` +
      `but CLI execution currently supplies Unit`,
    );
  }

  // --- Elaborate (all modules, so cross-module refs resolve at runtime) ---
  const elabResult = elaborateAll(loadResult.modules);
  if (!elabResult.ok) {
    for (const err of elabResult.errors) {
      console.error(`${file}: elaboration error: ${err.message}`);
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

  const effects: EffectHandlers = new Map(HOST_EFFECTS);
  for (const [bare, handler] of HOST_EFFECTS) {
    effects.set(`${modulePrefix}.${bare}`, handler);
  }

  // --- Interpret ---
  try {
    const result = interpret(elabMod, qualDefName, VUnit, effects);
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

function die(message: string): never {
  console.error(message);
  process.exit(1);
}
