import { test, expect } from "vitest";
import { buildMemoryModuleGraph } from "./memory-resolver.ts";
import { checkAll } from "./loader.ts";
import { elaborateAll, resetElabCounters } from "../elaborator/index.ts";
import { interpret } from "../interpreter/eval.ts";
import { vInt, vText } from "../interpreter/value.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function single(src: string): Map<string, string> {
  return new Map([["/entry.weave", src]]);
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

test("single file: ok", () => {
  const r = buildMemoryModuleGraph(
    single(`def passInt : Int -> Int ! pure = id`),
    "/entry.weave",
  );
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.graph.size).toBe(1);
    expect(r.graph.has("/entry.weave")).toBe(true);
  }
});

test("single file: missing entry", () => {
  const r = buildMemoryModuleGraph(new Map(), "/entry.weave");
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors[0].tag).toBe("not-found");
  }
});

test("single file: parse error", () => {
  const r = buildMemoryModuleGraph(single(`def bad`), "/entry.weave");
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors[0].tag).toBe("parse-error");
  }
});

test("multi-file: resolves import", () => {
  const files = new Map([
    ["/entry.weave",  `import Lib\ndef main : Int -> Int ! pure = Lib.pass`],
    ["/Lib.weave",    `def pass : Int -> Int ! pure = id`],
  ]);
  const r = buildMemoryModuleGraph(files, "/entry.weave");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.graph.size).toBe(2);
    const entry = r.graph.get("/entry.weave");
    expect(entry?.depPaths).toEqual(["/Lib.weave"]);
  }
});

test("multi-file: missing dep", () => {
  const files = new Map([
    ["/entry.weave", `import Missing\ndef main : Int -> Int ! pure = id`],
  ]);
  const r = buildMemoryModuleGraph(files, "/entry.weave");
  expect(r.ok).toBe(false);
  if (!r.ok) {
    const err = r.errors[0];
    expect(err.tag).toBe("not-found");
    if (err.tag === "not-found") {
      expect(err.filePath).toBe("/Missing.weave");
      expect(err.importedBy).toBe("/entry.weave");
    }
  }
});

test("nested import: resolved against entry root, not importing file's dir", () => {
  // import Lib.Utils from /entry.weave → /Lib/Utils.weave (entry-root-relative)
  const files = new Map([
    ["/entry.weave",     `import Lib.Utils\ndef main : Int -> Int ! pure = Lib.Utils.pass`],
    ["/Lib/Utils.weave", `def pass : Int -> Int ! pure = id`],
  ]);
  const r = buildMemoryModuleGraph(files, "/entry.weave");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.graph.has("/Lib/Utils.weave")).toBe(true);
    expect(r.graph.get("/entry.weave")?.depPaths).toEqual(["/Lib/Utils.weave"]);
  }
});

test("second-level import resolves against entry root, not importer dir", () => {
  // /Lib/Utils.weave imports Common → /Common.weave (entry root), NOT /Lib/Common.weave
  const files = new Map([
    ["/entry.weave",     `import Lib.Utils\ndef main : Int -> Int ! pure = Lib.Utils.pass`],
    ["/Lib/Utils.weave", `import Common\ndef pass : Int -> Int ! pure = Common.util`],
    ["/Common.weave",    `module Common\ndef util : Int -> Int ! pure = id`],
  ]);
  const r = buildMemoryModuleGraph(files, "/entry.weave");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.graph.has("/Common.weave")).toBe(true);
    expect(r.graph.has("/Lib/Common.weave")).toBe(false);
    expect(r.graph.get("/Lib/Utils.weave")?.depPaths).toEqual(["/Common.weave"]);
  }
});

test("cycle detection", () => {
  const files = new Map([
    ["/a.weave", `import b\ndef fx : Int -> Int ! pure = id`],
    ["/b.weave", `import a\ndef fy : Int -> Int ! pure = id`],
  ]);
  const r = buildMemoryModuleGraph(files, "/a.weave");
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.some((e) => e.tag === "cycle")).toBe(true);
  }
});

test("duplicate dep visited only once", () => {
  const files = new Map([
    ["/entry.weave", `import Lib\nimport Lib\ndef main : Int -> Int ! pure = id`],
    ["/Lib.weave",   `def util : Int -> Int ! pure = id`],
  ]);
  const r = buildMemoryModuleGraph(files, "/entry.weave");
  // Whether or not parse/typecheck accepts duplicate imports, the DFS black-set
  // ensures /Lib.weave appears at most once in the graph.
  if (r.ok) {
    expect([...r.graph.keys()].filter((k) => k === "/Lib.weave").length).toBe(1);
  }
});

// ---------------------------------------------------------------------------
// End-to-end: graph → typecheck → elaborate → interpret
// ---------------------------------------------------------------------------

test("e2e: single-module program runs correctly", () => {
  resetElabCounters();
  const files = single(`def double : Int -> Int ! pure = id`);

  const gr = buildMemoryModuleGraph(files, "/entry.weave");
  expect(gr.ok).toBe(true);
  if (!gr.ok) return;

  const lr = checkAll(gr.graph, "/entry.weave");
  expect(lr.ok).toBe(true);
  if (!lr.ok) return;

  const er = elaborateAll(lr.modules);
  expect(er.ok).toBe(true);
  if (!er.ok) return;

  const result = interpret(er.value, "double", vInt(42));
  expect(result).toEqual(vInt(42));
});

test("e2e: multi-module program runs correctly", () => {
  resetElabCounters();
  const files = new Map([
    ["/entry.weave",   `import Strings\ndef greet : Text -> Text ! pure = Strings.exclaim`],
    ["/Strings.weave", `module Strings\ndef exclaim : Text -> Text ! pure = id <> "!"`],
  ]);

  const gr = buildMemoryModuleGraph(files, "/entry.weave");
  expect(gr.ok).toBe(true);
  if (!gr.ok) return;

  const lr = checkAll(gr.graph, "/entry.weave");
  expect(lr.ok).toBe(true);
  if (!lr.ok) return;

  const er = elaborateAll(lr.modules);
  expect(er.ok).toBe(true);
  if (!er.ok) return;

  const result = interpret(er.value, "greet", vText("hello"));
  expect(result).toEqual(vText("hello!"));
});
