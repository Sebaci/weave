import readline from "node:readline";
import { resolve } from "node:path";
import { showType } from "../typechecker/index.ts";
import { elaborateAll } from "../elaborator/index.ts";
import { interpret, MissingEffectHandlerError } from "../interpreter/eval.ts";
import { showValue, VUnit } from "../interpreter/value.ts";
import { buildModuleGraph, type ModuleGraph, type ResolverError } from "../module/resolver.ts";
import { checkAll, type LoadError } from "../module/loader.ts";
import { renderLoadError, renderResolverError } from "./diagnostics.ts";
import { decodeInput, InputDecodeError } from "./input.ts";
import {
  buildEffects, bindBothAliases, BUILTIN_NAMES,
} from "./effects.ts";
import type { ElaboratedModule } from "../ir/ir.ts";
import type { TypedModule, MorphTy } from "../typechecker/typed-ast.ts";
import type { EffectHandlers } from "../interpreter/eval.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// _repl_ is a valid Weave identifier reserved for the inline eval wrapper.
// evalExpr checks for collisions before augmenting.
const REPL_DEF_NAME = "_repl_";
const REPL_SENTINEL = "<repl>";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

type Session = {
  filePath:       string;                   // absolute path of entry file
  entrySource:    string;                   // raw source text of the entry file
  graph:          ModuleGraph;
  sources:        ReadonlyMap<string, string>;
  typedMod:       TypedModule;
  elabMod:        ElaboratedModule;
  modulePrefix:   string;                   // e.g. "Examples.Hello"
  sessionEffects: Map<string, string>;      // op → builtin name (persistent)
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runRepl(): void {
  let session: Session | null = null;
  let lastFilePath: string | null = null;
  let pasteMode = false;
  const pasteBuffer: string[] = [];

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: "weave> ",
  });

  printHelp();
  console.log();
  rl.prompt();

  rl.on("line", (rawLine) => {
    const line = rawLine.trim();

    // Paste mode: collect lines until :end
    if (pasteMode) {
      if (line === ":end") {
        pasteMode = false;
        rl.setPrompt("weave> ");
        const exprText = pasteBuffer.join("\n");
        pasteBuffer.length = 0;
        if (!session) {
          console.error("No file loaded. Use :load <file> first.");
        } else if (exprText.trim()) {
          evalExpr(exprText, session);
        }
      } else {
        pasteBuffer.push(rawLine); // preserve original indentation
      }
      rl.prompt();
      return;
    }

    if (!line) { rl.prompt(); return; }

    // Non-command line: evaluate as expression
    if (!line.startsWith(":")) {
      if (!session) {
        console.error("No file loaded. Use :load <file> first.");
      } else {
        evalExpr(line, session);
      }
      rl.prompt();
      return;
    }

    const tokens = tokenize(line.slice(1));
    const cmd  = tokens[0] ?? "";
    const args = tokens.slice(1);

    switch (cmd) {
      case "load": {
        if (args.length !== 1) { console.error(":load requires a file path"); break; }
        const attempted = resolve(args[0]!);
        const newSession = cmdLoad(attempted, session);
        // Only update lastFilePath on successful load so :reload retries the
        // last successfully loaded file, not the last attempted one.
        if (newSession !== session) {
          lastFilePath = attempted;
          session = newSession;
        }
        break;
      }
      case "reload": {
        if (!lastFilePath) { console.error("No file loaded. Use :load <file> first."); break; }
        const newSession = cmdLoad(lastFilePath, session);
        if (newSession !== session) session = newSession;
        break;
      }
      case "run": {
        if (!session) { console.error("No file loaded. Use :load <file> first."); break; }
        cmdRun(args, session);
        break;
      }
      case "type": {
        if (!session) { console.error("No file loaded. Use :load <file> first."); break; }
        if (args.length !== 1) { console.error(":type requires a def name"); break; }
        cmdType(args[0]!, session);
        break;
      }
      case "show": {
        if (!session) { console.error("No file loaded. Use :load <file> first."); break; }
        if (args.length !== 1) { console.error(":show requires a def name"); break; }
        cmdShow(args[0]!, session);
        break;
      }
      case "defs": {
        if (!session) { console.error("No file loaded. Use :load <file> first."); break; }
        cmdDefs(session);
        break;
      }
      case "effects": {
        if (!session) { console.error("No file loaded. Use :load <file> first."); break; }
        cmdEffects(session);
        break;
      }
      case "effect": {
        if (!session) { console.error("No file loaded. Use :load <file> first."); break; }
        if (args.length !== 1) { console.error(":effect requires op=builtin (e.g. :effect App.log=print)"); break; }
        cmdEffect(args[0]!, session);
        break;
      }
      case "paste": {
        pasteMode = true;
        pasteBuffer.length = 0;
        rl.setPrompt("... ");
        console.log("Entering paste mode. Type :end on a new line to evaluate.");
        break;
      }
      case "end":
        console.error(":end is only valid inside :paste mode");
        break;
      case "help":
        printHelp();
        break;
      case "quit":
      case "q":
        rl.close();
        process.exit(0);
        break;
      default:
        console.error(`Unknown command ':${cmd}'. Type :help for available commands.`);
    }

    rl.prompt();
  });

  rl.on("close", () => { process.exit(0); });
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function cmdLoad(absPath: string, current: Session | null): Session | null {
  const graphResult = buildModuleGraph(absPath);
  if (!graphResult.ok) {
    for (const err of graphResult.errors) {
      console.error(renderResolverError(err, graphResult.sources));
    }
    return current;
  }

  const sources = graphSources(graphResult.graph);
  const loadResult = checkAll(graphResult.graph, absPath);
  if (!loadResult.ok) {
    for (const err of loadResult.errors) {
      console.error(renderLoadError(err, sources.get(err.filePath)));
    }
    return current;
  }

  const typedMod = loadResult.modules.get(absPath);
  if (!typedMod) {
    console.error("internal error: entry module missing after typecheck");
    return current;
  }

  const elabResult = elaborateAll(loadResult.modules);
  if (!elabResult.ok) {
    for (const err of elabResult.errors) {
      console.error(`elaborate: ${err.message}`);
    }
    return current;
  }

  const entryNode = graphResult.graph.get(absPath)!;
  const modulePrefix = entryNode.mod.path.join(".");

  const sessionEffects = (current?.filePath === absPath)
    ? new Map(current.sessionEffects)
    : new Map<string, string>();

  console.log(`Loaded ${absPath}`);
  return {
    filePath: absPath,
    entrySource: entryNode.source,
    graph: graphResult.graph,
    sources,
    typedMod,
    elabMod: elabResult.value,
    modulePrefix,
    sessionEffects,
  };
}

function evalExpr(exprText: string, session: Session): void {
  // Guard: if the user's module already defines _repl_, we can't safely inject it.
  if (session.typedMod.typedDefs.has(REPL_DEF_NAME)) {
    console.error(`'${REPL_DEF_NAME}' is defined in the loaded module; cannot evaluate expression`);
    return;
  }

  // Wrap the expression as an unannotated def at the end of the entry source.
  // The typechecker infers the output type; input is assumed Unit.
  const prefix = `${session.entrySource}\n\ndef ${REPL_DEF_NAME} =\n`;
  const augmented = `${prefix}${exprText}\n`;
  const prefixLineCount = (prefix.match(/\n/g) ?? []).length;

  const graphResult = buildModuleGraph(session.filePath, augmented);
  if (!graphResult.ok) {
    for (const err of graphResult.errors) {
      if (err.tag === "parse-error" && err.filePath === session.filePath) {
        console.error(renderReplParseError(err, prefixLineCount));
      } else {
        console.error(renderResolverError(err, graphResult.sources));
      }
    }
    return;
  }

  const sources = graphSources(graphResult.graph);
  const loadResult = checkAll(graphResult.graph, session.filePath);
  if (!loadResult.ok) {
    for (const err of loadResult.errors) {
      if (err.filePath === session.filePath && err.span && err.span.start.line > prefixLineCount) {
        console.error(renderReplTypeError(err, prefixLineCount));
      } else {
        console.error(renderLoadError(err, sources.get(err.filePath)));
      }
    }
    return;
  }

  const typedMod = loadResult.modules.get(session.filePath);
  if (!typedMod) { console.error("internal: entry module missing"); return; }

  const replDef = typedMod.typedDefs.get(REPL_DEF_NAME);
  if (!replDef) { console.error("internal: $repl def missing after typecheck"); return; }

  // REPL eval always supplies Unit input; non-Unit expressions must use :run.
  if (replDef.morphTy.input.tag !== "Unit") {
    console.error(
      `expression has type ${formatMorphTy(replDef.morphTy)}; ` +
      `REPL eval supplies Unit input — use :run for non-Unit defs`,
    );
    return;
  }

  const elabResult = elaborateAll(loadResult.modules);
  if (!elabResult.ok) {
    for (const err of elabResult.errors) {
      console.error(`elaborate: ${err.message}`);
    }
    return;
  }

  const elabMod = elabResult.value;
  const qualName = session.modulePrefix
    ? `${session.modulePrefix}.${REPL_DEF_NAME}`
    : REPL_DEF_NAME;

  if (!elabMod.defs.has(qualName)) {
    console.error("expression is polymorphic; supply type arguments to evaluate");
    return;
  }

  // Auto-bind print, then apply session effects.
  const effects = buildEffects(elabMod.omega, REPL_SENTINEL);
  if (!effects) return;
  for (const [op, builtinName] of session.sessionEffects) {
    if (!elabMod.omega.has(op)) continue;
    if (!bindBothAliases(effects, op, builtinName, elabMod.omega, REPL_SENTINEL)) return;
  }

  try {
    const result = interpret(elabMod, qualName, VUnit, effects);
    if (result.tag !== "unit") console.log(showValue(result));
  } catch (e) {
    if (e instanceof MissingEffectHandlerError) {
      console.error(`no binding for effect '${e.op}'; use :effect ${e.op}=<builtin>`);
      return;
    }
    throw e;
  }
}

function cmdRun(args: string[], session: Session): void {
  if (args.length === 0) {
    console.error(":run <name> [--input '<json>'] [--effect op=builtin ...]");
    return;
  }

  const defName = args[0]!;
  let inputJson: string | undefined;
  const cmdEffectPairs: Array<[string, string]> = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--input" && i + 1 < args.length) {
      inputJson = args[++i];
    } else if (args[i] === "--effect" && i + 1 < args.length) {
      const spec = args[++i]!;
      const eq = spec.indexOf("=");
      if (eq < 1 || eq === spec.length - 1) {
        console.error(":run: --effect must be op=builtin");
        return;
      }
      cmdEffectPairs.push([spec.slice(0, eq), spec.slice(eq + 1)]);
    } else {
      console.error(`:run: unexpected argument '${args[i]}'`);
      return;
    }
  }

  const { elabMod, typedMod, modulePrefix } = session;

  const typedDef = typedMod.typedDefs.get(defName);
  if (!typedDef) {
    console.error(`:run: no def '${defName}' in loaded module`);
    return;
  }

  const qualName = modulePrefix ? `${modulePrefix}.${defName}` : defName;
  if (!elabMod.defs.has(qualName)) {
    console.error(`:run: '${defName}' is polymorphic and cannot be run directly`);
    return;
  }

  // Build effect handlers: auto-bind print, then session effects, then per-command overrides.
  const effects = buildEffects(elabMod.omega, ":run");
  if (!effects) return;

  for (const [op, builtinName] of session.sessionEffects) {
    if (!elabMod.omega.has(op)) {
      console.error(`:run: session effect '${op}' is no longer declared; use :reload`);
      return;
    }
    if (!bindBothAliases(effects, op, builtinName, elabMod.omega, ":run")) return;
  }

  for (const [op, builtinName] of cmdEffectPairs) {
    if (!elabMod.omega.has(op)) {
      console.error(`:run: '${op}' is not a declared effect op`);
      return;
    }
    if (!bindBothAliases(effects, op, builtinName, elabMod.omega, ":run")) return;
  }

  // Decode input.
  const inputTy = typedDef.morphTy.input;
  let inputValue;
  if (inputJson !== undefined) {
    let raw: unknown;
    try { raw = JSON.parse(inputJson); }
    catch { console.error(":run: --input is not valid JSON"); return; }
    try {
      inputValue = decodeInput(raw, inputTy, elabMod.typeDecls);
    } catch (e) {
      if (e instanceof InputDecodeError) {
        console.error(`:run: --input type mismatch (expected ${showType(inputTy)})\n  ${e.message}`);
        return;
      }
      throw e;
    }
  } else if (inputTy.tag === "Unit") {
    inputValue = VUnit;
  } else {
    console.error(`:run: '${defName}' expects ${showType(inputTy)}; supply --input '<json>'`);
    return;
  }

  // Interpret.
  try {
    const result = interpret(elabMod, qualName, inputValue, effects);
    if (result.tag !== "unit") console.log(showValue(result));
  } catch (e) {
    if (e instanceof MissingEffectHandlerError) {
      console.error(`:run: no binding for effect '${e.op}'; use :effect ${e.op}=<builtin>`);
      return;
    }
    throw e;
  }
}

function cmdType(name: string, session: Session): void {
  const def = session.typedMod.typedDefs.get(name);
  if (!def) { console.error(`:type: no def '${name}' in loaded module`); return; }
  console.log(`${name} : ${formatMorphTy(def.morphTy)}`);
}

function cmdShow(name: string, session: Session): void {
  const def = session.typedMod.typedDefs.get(name);
  if (!def) { console.error(`:show: no def '${name}' in loaded module`); return; }
  const params = def.params
    .map((p) => `(${p.name}: ${formatMorphTy(p.morphTy)})`)
    .join(" ");
  const paramStr = params ? ` ${params}` : "";
  console.log(`def ${def.name}${paramStr} : ${formatMorphTy(def.morphTy)}`);
}

function cmdDefs(session: Session): void {
  const defs = [...session.typedMod.typedDefs.keys()];
  if (defs.length === 0) { console.log("(no defs)"); return; }
  for (const name of defs) {
    const qual = session.modulePrefix ? `${session.modulePrefix}.${name}` : name;
    const note = session.elabMod.defs.has(qual) ? "" : "  (polymorphic)";
    console.log(`  ${name}${note}`);
  }
}

function cmdEffects(session: Session): void {
  const { omega } = session.elabMod;
  if (omega.size === 0) { console.log("(no effect operations declared)"); return; }

  // Show each operation once using its qualified name when available. Also display
  // the bare op key in parentheses because EffectNode.op always carries the surface
  // spelling (e.g. `perform read` → op "read"), so `:effect` accepts either form.
  const hasQualified = [...omega.keys()].some((k) => k.includes("."));
  const seen = new Set<string>();

  for (const [key, entry] of omega) {
    if (hasQualified && !key.includes(".")) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    const bareName = key.includes(".") ? key.split(".").pop()! : key;
    const bareNote = key !== bareName ? `  (op: "${bareName}")` : "";
    const bound = session.sessionEffects.get(key) ?? session.sessionEffects.get(bareName);
    const bindTag = bound ? `  [= ${bound}]` : "";
    console.log(
      `  ${key} : ${showType(entry.inputTy)} -> ${showType(entry.outputTy)} ! ${entry.eff}${bareNote}${bindTag}`,
    );
  }
  console.log(`\nAvailable builtins: ${BUILTIN_NAMES.join(", ")}`);
}

function cmdEffect(spec: string, session: Session): void {
  const eq = spec.indexOf("=");
  if (eq < 1 || eq === spec.length - 1) {
    console.error(":effect requires op=builtin (e.g. :effect App.log=print)");
    return;
  }
  const op = spec.slice(0, eq);
  const builtinName = spec.slice(eq + 1);

  if (!session.elabMod.omega.has(op)) {
    console.error(`:effect: '${op}' is not a declared effect op in the loaded module`);
    return;
  }

  // Validate against all omega aliases now to give early error feedback.
  const tempEffects: EffectHandlers = new Map();
  if (!bindBothAliases(tempEffects, op, builtinName, session.elabMod.omega, ":effect")) return;

  session.sessionEffects.set(op, builtinName);
  console.log(`Bound ${op} = ${builtinName}`);
}

// ---------------------------------------------------------------------------
// REPL expression error rendering
// ---------------------------------------------------------------------------

function renderReplParseError(
  err: ResolverError & { tag: "parse-error" },
  prefixLineCount: number,
): string {
  const { line, column } = err.span.start;
  return `${REPL_SENTINEL}:${line - prefixLineCount}:${column}: error: ${err.message}`;
}

function renderReplTypeError(err: LoadError, prefixLineCount: number): string {
  if (!err.span) return `${REPL_SENTINEL}: error: ${err.message}`;
  const { line, column } = err.span.start;
  return `${REPL_SENTINEL}:${line - prefixLineCount}:${column}: error: ${err.message}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function formatMorphTy(m: MorphTy): string {
  const eff = m.eff !== "pure" ? ` ! ${m.eff}` : "";
  return m.input.tag === "Unit"
    ? `${showType(m.output)}${eff}`
    : `${showType(m.input)} -> ${showType(m.output)}${eff}`;
}

/** Shell-style tokenizer: handles single-quoted strings (for --input '{"x":1}'). */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    if (line[i] === "'") {
      i++;
      const start = i;
      while (i < line.length && line[i] !== "'") i++;
      tokens.push(line.slice(start, i));
      if (i < line.length) i++;
    } else {
      const start = i;
      while (i < line.length && !/\s/.test(line[i]!)) i++;
      tokens.push(line.slice(start, i));
    }
  }
  return tokens;
}

function graphSources(graph: ModuleGraph): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  for (const [p, node] of graph) m.set(p, node.source);
  return m;
}

function printHelp(): void {
  console.log(
    [
      "Weave REPL — available commands:",
      "  <expr>                             Evaluate an expression (Unit input)",
      "  :paste                             Enter multi-line paste mode",
      "  :end                               End paste mode and evaluate",
      "  :load <file>                       Load and compile a .weave file",
      "  :reload                            Reload the current file",
      "  :run <name>                        Run a def (Unit input)",
      "       [--input '<json>']            Supply structured input",
      "       [--effect <op>=<builtin>]     Bind an effect for this run (repeatable)",
      "  :type <name>                       Show the type of a def",
      "  :show <name>                       Show full def signature (incl. schema params)",
      "  :defs                              List all defs in the loaded module",
      "  :effects                           List declared effect ops and session bindings",
      "  :effect <op>=<builtin>             Bind an effect for all future :run calls",
      "  :help                              Show this message",
      "  :quit  :q                          Exit",
    ].join("\n"),
  );
}
