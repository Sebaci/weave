/**
 * Golden IR snapshot tests.
 *
 * Each test elaborates a representative program, normalizes the resulting IR
 * (replacing incrementing IDs with stable positional labels), and compares
 * against a stored snapshot.
 *
 * On first run, Vitest writes the snapshots automatically.
 * Any subsequent diff requires deliberate `--update-snapshots` to accept.
 */

import { describe, test, expect } from "vitest";
import { parseModule } from "../../src/parser/index.ts";
import { checkModule } from "../../src/typechecker/check.ts";
import { elaborateModule, resetElabCounters } from "../../src/elaborator/index.ts";
import { normalizeGraph } from "./normalize.ts";
import type { ElaboratedModule, Graph } from "../../src/ir/ir.ts";

// ---------------------------------------------------------------------------
// Pipeline helper
// ---------------------------------------------------------------------------

function elab(src: string): ElaboratedModule {
  resetElabCounters();
  const pr = parseModule(src);
  if (!pr.ok) throw new Error(`Parse: ${pr.errors.map((e) => e.message).join("; ")}`);
  const tr = checkModule(pr.value);
  if (!tr.ok) throw new Error(`Typecheck: ${tr.errors.map((e) => e.message).join("; ")}`);
  const er = elaborateModule(tr.value);
  if (!er.ok) throw new Error(`Elaborate: ${er.errors.map((e) => e.message).join("; ")}`);
  return er.value;
}

function def(m: ElaboratedModule, name: string): Graph {
  const g = m.defs.get(name);
  if (!g) throw new Error(`def '${name}' not found; available: ${[...m.defs.keys()].join(", ")}`);
  return g;
}

// ---------------------------------------------------------------------------
// Recursive provenance helpers
// ---------------------------------------------------------------------------

/** Collect every graph reachable from g, including nested branch/algebra graphs. */
function collectAllGraphs(g: Graph): Graph[] {
  const result: Graph[] = [g];
  for (const node of g.nodes) {
    if (node.kind === "case") {
      for (const b of node.branches) result.push(...collectAllGraphs(b.graph));
    } else if (node.kind === "cata") {
      for (const b of node.algebra) result.push(...collectAllGraphs(b.graph));
    }
  }
  return result;
}

/** Assert that every graph and every node within it (recursively) has provenance. */
function assertProvenanceRecursive(g: Graph, context: string): void {
  for (const graph of collectAllGraphs(g)) {
    expect(graph.provenance.length, `${context}: a graph has no provenance`).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      expect(
        node.provenance.length,
        `${context}: node ${node.id} (${node.kind}) has no provenance`,
      ).toBeGreaterThan(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture 1 — let inside fold (sumOfDoubles)
// ---------------------------------------------------------------------------

describe("fold + let: sumOfDoubles", () => {
  const src = `
module Golden.Let

type List a =
  | Nil
  | Cons { head: a, tail: List a }

def sumOfDoubles : List Int -> Int =
  fold {
    Nil:  0,
    Cons: { head, tail } >>>
      let doubled = head + head in
      doubled + tail,
  }
`;

  test("exact def keys", () => {
    const m = elab(src);
    expect([...m.defs.keys()].sort()).toEqual([
      "Golden.Let.sumOfDoubles",
      "sumOfDoubles",
    ]);
  });

  test("sumOfDoubles graph shape", () => {
    const m = elab(src);
    expect(normalizeGraph(def(m, "sumOfDoubles"))).toMatchSnapshot();
  });

  test("all graphs and nodes have provenance", () => {
    const m = elab(src);
    assertProvenanceRecursive(def(m, "sumOfDoubles"), "sumOfDoubles");
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — case .field (handleResult)
// ---------------------------------------------------------------------------

describe("case .field: handleResult", () => {
  const src = `
module Golden.CaseField

type Result =
  | Ok  { value: Int }
  | Err { code: Int }

def handleResult : { result: Result, label: Text } -> Text =
  case .result {
    Ok:  { value } >>> label,
    Err: { code }  >>> label,
  }
`;

  test("exact def keys", () => {
    const m = elab(src);
    expect([...m.defs.keys()].sort()).toEqual([
      "Golden.CaseField.handleResult",
      "handleResult",
    ]);
  });

  test("handleResult graph shape", () => {
    const m = elab(src);
    expect(normalizeGraph(def(m, "handleResult"))).toMatchSnapshot();
  });

  test("CaseNode carries field and contextTy", () => {
    const m = elab(src);
    const g = def(m, "handleResult");
    const caseNode = g.nodes.find((n) => n.kind === "case");
    expect(caseNode).toBeDefined();
    if (caseNode?.kind === "case") {
      expect(caseNode.field).toBe("result");
      expect(caseNode.contextTy).toBeDefined();
    }
  });

  test("all graphs and nodes have provenance", () => {
    const m = elab(src);
    assertProvenanceRecursive(def(m, "handleResult"), "handleResult");
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — fanout (reflect, translate, composition)
// ---------------------------------------------------------------------------

describe("fanout: Point transformations", () => {
  const src = `
module Golden.Fanout

type Point =
  | Point { x: Int, y: Int }

def reflect : Point -> Point =
  case {
    Point: { x, y } >>> fanout { x: y, y: x } >>> Point,
  }

def translate : Point -> Point =
  case {
    Point: { x, y } >>> fanout { x: x + 1, y: y + 1 } >>> Point,
  }

def reflectThenTranslate : Point -> Point =
  reflect >>> translate
`;

  test("exact def keys", () => {
    const m = elab(src);
    expect([...m.defs.keys()].sort()).toEqual([
      "Golden.Fanout.reflect",
      "Golden.Fanout.reflectThenTranslate",
      "Golden.Fanout.translate",
      "reflect",
      "reflectThenTranslate",
      "translate",
    ]);
  });

  test("reflect graph shape", () => {
    const m = elab(src);
    expect(normalizeGraph(def(m, "reflect"))).toMatchSnapshot();
  });

  test("translate graph shape", () => {
    const m = elab(src);
    expect(normalizeGraph(def(m, "translate"))).toMatchSnapshot();
  });

  test("reflectThenTranslate graph shape", () => {
    const m = elab(src);
    expect(normalizeGraph(def(m, "reflectThenTranslate"))).toMatchSnapshot();
  });

  test("all graphs and nodes have provenance", () => {
    const m = elab(src);
    for (const name of ["reflect", "translate", "reflectThenTranslate"])
      assertProvenanceRecursive(def(m, name), name);
  });
});

// ---------------------------------------------------------------------------
// Fixture 4 — build (origin, unitBox)
// ---------------------------------------------------------------------------

describe("build: origin and unitBox", () => {
  const src = `
module Golden.Build

type Point =
  | Point { x: Int, y: Int }

type BoundingBox =
  | BoundingBox { topLeft: Point, bottomRight: Point }

def origin : Unit -> Point =
  build { x: 0, y: 0 } >>> Point

def unitBox : Unit -> BoundingBox =
  build { topLeft: origin, bottomRight: origin } >>> BoundingBox
`;

  test("exact def keys", () => {
    const m = elab(src);
    expect([...m.defs.keys()].sort()).toEqual([
      "Golden.Build.origin",
      "Golden.Build.unitBox",
      "origin",
      "unitBox",
    ]);
  });

  test("origin graph shape", () => {
    const m = elab(src);
    expect(normalizeGraph(def(m, "origin"))).toMatchSnapshot();
  });

  test("unitBox graph shape", () => {
    const m = elab(src);
    expect(normalizeGraph(def(m, "unitBox"))).toMatchSnapshot();
  });

  test("unitBox refs origin without DupNode (build provides independent Unit per field)", () => {
    const m = elab(src);
    const g = def(m, "unitBox");
    const dups = g.nodes.filter((n) => n.kind === "dup");
    expect(dups).toHaveLength(0);
  });

  test("all graphs and nodes have provenance", () => {
    const m = elab(src);
    for (const name of ["origin", "unitBox"])
      assertProvenanceRecursive(def(m, name), name);
  });
});
