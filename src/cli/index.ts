import { readFileSync } from "node:fs";
import { parseModule } from "../parser/parse.ts";
import { checkModule } from "../typechecker/check.ts";
import { buildSpanMap } from "../surface/span-map.ts";

const [,, command, filePath, ...rest] = process.argv;

if (command !== "check" || !filePath || rest.length > 0) {
  console.error("Usage: npm run cli -- check <file>");
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
const spanMap = buildSpanMap(mod);

// --- Typecheck ---
const checkResult = checkModule(mod);
if (!checkResult.ok) {
  for (const err of checkResult.errors) {
    const span = err.span ?? spanMap.get(err.sourceId);
    if (span) {
      const { line, column } = span.start;
      console.error(`${filePath}:${line}:${column}: error: ${err.message}`);
    } else {
      console.error(`${filePath}: error: ${err.message}`);
    }
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
