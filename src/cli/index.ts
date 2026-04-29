import { readFileSync } from "node:fs";
import { parseModule } from "../parser/parse.ts";
import { checkModule } from "../typechecker/check.ts";
import { showType } from "../typechecker/index.ts";
import { elaborateModule } from "../elaborator/index.ts";
import { interpret, MissingEffectHandlerError, type EffectHandlers } from "../interpreter/eval.ts";
import { showValue, VUnit, type Value } from "../interpreter/value.ts";
import { buildSpanMap } from "../surface/span-map.ts";
import { buildModuleGraph } from "../module/resolver.ts";

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
  // Resolve and parse the full import graph first.
  const graphResult = buildModuleGraph(file);
  if (!graphResult.ok) {
    for (const err of graphResult.errors) {
      if (err.tag === "not-found") {
        console.error(`${err.importedBy}: error: cannot find imported module '${err.filePath}'`);
      } else if (err.tag === "parse-error") {
        console.error(`${err.filePath}:${err.line}:${err.column}: error: ${err.message}`);
      } else {
        console.error(`error: import cycle detected: ${err.cycle.join(" -> ")}`);
      }
    }
    process.exit(1);
  }

  // Typecheck each module in the graph (entry file only for now; Step 7 merges envs).
  const source = readSource(file);
  const parseResult = parseModule(source);
  if (!parseResult.ok) {
    for (const err of parseResult.errors) {
      const { line, column } = err.span.start;
      console.error(`${file}:${line}:${column}: error: ${err.message}`);
    }
    process.exit(1);
  }
  const mod = parseResult.value;
  const spanMap = buildSpanMap(mod);

  const checkResult = checkModule(mod);
  if (!checkResult.ok) {
    for (const err of checkResult.errors) {
      const span = err.span ?? spanMap.get(err.sourceId);
      if (span) {
        const { line, column } = span.start;
        console.error(`${file}:${line}:${column}: error: ${err.message}`);
      } else {
        console.error(`${file}: error: ${err.message}`);
      }
    }
    process.exit(1);
  }

  console.log(`${file}: OK`);
}

function runRun(file: string, defName: string): void {
  const source = readSource(file);

  // --- Parse ---
  const parseResult = parseModule(source);
  if (!parseResult.ok) {
    for (const err of parseResult.errors) {
      const { line, column } = err.span.start;
      console.error(`${file}:${line}:${column}: error: ${err.message}`);
    }
    process.exit(1);
  }
  const mod = parseResult.value;
  const spanMap = buildSpanMap(mod);

  // --- Typecheck ---
  const checkResult = checkModule(mod);
  if (!checkResult.ok) {
    for (const err of checkResult.errors) {
      const span = err.span ?? spanMap.get(err.sourceId);
      if (span) {
        const { line, column } = span.start;
        console.error(`${file}:${line}:${column}: error: ${err.message}`);
      } else {
        console.error(`${file}: error: ${err.message}`);
      }
    }
    process.exit(1);
  }
  const typedMod = checkResult.value;

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

  // --- Elaborate ---
  const elabResult = elaborateModule(typedMod);
  if (!elabResult.ok) {
    for (const err of elabResult.errors) {
      console.error(`${file}: elaboration error: ${err.message}`);
    }
    process.exit(1);
  }
  const elabMod = elabResult.value;

  // Guard: schema/polymorphic defs are omitted from the elaborated graph map.
  if (!elabMod.defs.has(defName)) {
    die(`weave run: def '${defName}' is polymorphic and cannot be run directly`);
  }

  // Augment host effects with qualified names (e.g. "Examples.Hello.print")
  // so that `perform Examples.Hello.print` and `perform print` both resolve.
  const modulePrefix = mod.path.join(".");
  const effects: EffectHandlers = new Map(HOST_EFFECTS);
  for (const [bare, handler] of HOST_EFFECTS) {
    effects.set(`${modulePrefix}.${bare}`, handler);
  }

  // --- Interpret ---
  try {
    const result = interpret(elabMod, defName, VUnit, effects);
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

function readSource(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    die(`weave: ${path}: ${(e as NodeJS.ErrnoException).message}`);
  }
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}
