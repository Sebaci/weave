import { readFileSync } from "node:fs";
import { parseModule } from "../parser/parse.ts";
import { checkModule } from "../typechecker/check.ts";

const [,, command, filePath] = process.argv;

if (command !== "check" || !filePath) {
  console.error("Usage: weave check <file>");
  process.exit(1);
}

const source = readSource(filePath);

// --- Parse ---
const parseResult = parseModule(source);
if (!parseResult.ok) {
  for (const err of parseResult.errors) {
    const { line, column } = err.span.start;
    console.error(`${filePath}:${line}:${column}: error: ${err.message}`);
  }
  process.exit(1);
}
const mod = parseResult.value;

// --- Typecheck ---
// Note: type errors carry sourceId but no span yet — location added in a later step.
const checkResult = checkModule(mod);
if (!checkResult.ok) {
  for (const err of checkResult.errors) {
    console.error(`${filePath}: error: ${err.message}`);
  }
  process.exit(1);
}

console.log(`${filePath}: OK`);

// ---------------------------------------------------------------------------

function readSource(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    console.error(`weave: ${path}: ${(e as NodeJS.ErrnoException).message}`);
    process.exit(1);
  }
}
