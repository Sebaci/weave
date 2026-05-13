/**
 * IR-1c: Node reachability from graph boundary.
 *
 * Every node must be forward-reachable from graph.inPort or a ConstNode output.
 * IR-1b catches locally disconnected ports (dangling inputs/outputs); IR-1c
 * catches disconnected islands that pass IR-1b — notably cycle islands where
 * each node's input is locally supplied and output is locally consumed via
 * port-sharing, but the whole island is unreachable from the graph boundary.
 *
 * Known blind spot: a subgraph sourced entirely by ConstNodes and drained by
 * DropNodes passes both IR-1b and IR-1c because ConstNode outputs are seeded
 * unconditionally. See the regression test at the bottom.
 */

import { describe, test, expect } from "vitest";
import { validateGraph } from "../../src/ir/validate.ts";
import type { Graph, Node, Port, Wire } from "../../src/ir/ir.ts";
import type { Type } from "../../src/types/type.ts";
import type { Provenance } from "../../src/ir/ir.ts";

// ---------------------------------------------------------------------------
// Minimal graph builder helpers
// ---------------------------------------------------------------------------

const INT:  Type = { tag: "Int" };
const UNIT: Type = { tag: "Unit" };
const PROV: Provenance[] = [{ sourceId: "test" }];

function port(id: string, ty: Type = INT): Port { return { id, ty }; }

function constNode(id: string, outId: string): Node {
  return { kind: "const", id, effect: "pure", value: { tag: "int", value: 0 }, output: port(outId), provenance: PROV };
}

function refNode(id: string, inId: string, outId: string): Node {
  return { kind: "ref", id, defId: "dummy", effect: "pure", input: port(inId), output: port(outId), provenance: PROV };
}

function dropNode(id: string, inId: string, outId: string): Node {
  return { kind: "drop", id, effect: "pure", input: port(inId), output: port(outId, UNIT), provenance: PROV };
}

/** Build a minimal graph with an explicit wire from lastNodeOutId to outPort.
 *  This ensures IR-1b's "outPort must have an incoming wire" check passes. */
function mkGraph(
  inPortId: string, outPortId: string,
  nodes: Node[], innerWires: Wire[] = [],
  lastNodeOutId?: string,
): Graph {
  const wires: Wire[] = [...innerWires];
  if (lastNodeOutId && lastNodeOutId !== outPortId) {
    wires.push({ from: lastNodeOutId, to: outPortId });
  }
  return {
    id: "g", inPort: port(inPortId), outPort: port(outPortId),
    effect: "pure", nodes, wires, provenance: [],
  };
}

function wire(from: string, to: string): Wire { return { from, to }; }

/** Returns IR-1 "orphaned" error messages from validateGraph. */
function orphanedErrors(g: Graph): string[] {
  const r = validateGraph(g);
  if (r.ok) return [];
  return r.errors.filter((e) => e.rule === "IR-1" && e.message.includes("orphaned")).map((e) => e.message);
}

// ---------------------------------------------------------------------------
// Compiler-produced programs: must pass full validateGraph (all rules)
// ---------------------------------------------------------------------------

describe("IR-1c: compiler-produced graphs — full validation", () => {
  async function compile(src: string, defName: string): Promise<Graph> {
    const { parseModule } = await import("../../src/parser/index.ts");
    const { checkModule }  = await import("../../src/typechecker/check.ts");
    const { elaborateModule, resetElabCounters } = await import("../../src/elaborator/index.ts");
    resetElabCounters();
    const pr = parseModule(src);
    if (!pr.ok) throw new Error("parse: " + pr.errors.map((e) => e.message).join("; "));
    const tr = checkModule(pr.value);
    if (!tr.ok) throw new Error("type: " + tr.errors.map((e) => e.message).join("; "));
    const er = elaborateModule(tr.value);
    if (!er.ok) throw new Error("elab: " + er.errors.map((e) => e.message).join("; "));
    return er.value.defs.get(defName)!;
  }

  test("fold with let (DupNode from multi-use binder) passes all validation rules", async () => {
    // sumOfDoubles uses 'head' twice → DupNode inserted in the Cons branch handler.
    // Full validateGraph must pass; this exercises IR-1c on a graph with DupNode.
    const g = await compile(`
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
`, "sumOfDoubles");
    const r = validateGraph(g);
    if (!r.ok) throw new Error(r.errors.map((e) => `[${e.rule}] ${e.message}`).join("\n"));
    expect(r.ok).toBe(true);
  });

  test("fold (simple sum) passes all validation rules", async () => {
    const g = await compile(`
type List a =
  | Nil
  | Cons { head: a, tail: List a }

def sumList : List Int -> Int =
  fold {
    Nil:  0,
    Cons: { head, tail } >>> head + tail,
  }
`, "sumList");
    const r = validateGraph(g);
    if (!r.ok) throw new Error(r.errors.map((e) => `[${e.rule}] ${e.message}`).join("\n"));
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cycle islands: IR-1b passes, IR-1c catches
// ---------------------------------------------------------------------------

describe("IR-1c: cycle island — passes IR-1b, caught by IR-1c", () => {
  test("two-node port-sharing cycle is orphaned", () => {
    // Main path: inPort(p0) → refMain → p2 → outPort
    // Island: refA.input=pA, refA.output=pB; refB.input=pB, refB.output=pA (cycle)
    // Each island node's input is "supplied" by the other's output (port-sharing),
    // and each output is "consumed" by the other's input — so IR-1b passes.
    // Neither pA nor pB is reachable from inPort → IR-1c flags both.
    const refMain = refNode("nd_main", "p0", "p2");
    const refA    = refNode("nd_A", "pA", "pB");
    const refB    = refNode("nd_B", "pB", "pA");
    const g = mkGraph("p0", "p_out", [refMain, refA, refB], [wire("p2", "p_out")]);
    const errs = orphanedErrors(g);
    expect(errs.some((e) => e.includes("nd_A"))).toBe(true);
    expect(errs.some((e) => e.includes("nd_B"))).toBe(true);
    expect(errs.some((e) => e.includes("nd_main"))).toBe(false);
  });

  test("three-node cycle is orphaned", () => {
    const refMain = refNode("nd_main", "p0", "p2");
    const n1 = refNode("nd_1", "c", "a");
    const n2 = refNode("nd_2", "a", "b");
    const n3 = refNode("nd_3", "b", "c");
    const g = mkGraph("p0", "p_out", [refMain, n1, n2, n3], [wire("p2", "p_out")]);
    const errs = orphanedErrors(g);
    expect(errs.length).toBe(3);
    expect(errs.some((e) => e.includes("nd_1"))).toBe(true);
    expect(errs.some((e) => e.includes("nd_2"))).toBe(true);
    expect(errs.some((e) => e.includes("nd_3"))).toBe(true);
  });

  test("cycle island is flagged even when graph also has a valid ConstNode chain", () => {
    // ConstNode → refC → outPort (valid ConstNode-seeded main path).
    // Separate port-sharing cycle: cycleA ↔ cycleB (no const seed, not reachable).
    const drop  = dropNode("nd_drop", "p0", "p_unit");
    const cNode = constNode("nd_const", "p_c");
    const refC  = refNode("nd_refc", "p_c", "p_refc");
    const cycleA = refNode("nd_cycA", "cy1", "cy2");
    const cycleB = refNode("nd_cycB", "cy2", "cy1");
    const g = mkGraph(
      "p0", "p_out",
      [drop, cNode, refC, cycleA, cycleB],
      [wire("p_refc", "p_out")],
    );
    const errs = orphanedErrors(g);
    expect(errs.some((e) => e.includes("nd_cycA"))).toBe(true);
    expect(errs.some((e) => e.includes("nd_cycB"))).toBe(true);
    expect(errs.some((e) => e.includes("nd_const"))).toBe(false);
    expect(errs.some((e) => e.includes("nd_refc"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Known blind spot regression: const → * → drop dead island
// ---------------------------------------------------------------------------

describe("IR-1c: known blind spot (const-seeded dead island)", () => {
  test("const → ref → drop island is NOT flagged as orphaned (accepted limitation)", () => {
    // The island (nd_c → nd_r → nd_d) is completely disconnected from outPort,
    // but passes IR-1c because ConstNode is seeded unconditionally and DropNode
    // is a legitimate terminal exempt from IR-1b's output-consumed check.
    // This test documents the known blind spot; it must remain green.
    const mainRef = refNode("nd_main", "p0", "p2");
    const islandC = constNode("nd_c", "p_ic");
    const islandR = refNode("nd_r", "p_ic", "p_ir");
    const islandD = dropNode("nd_d", "p_ir", "p_id");
    const g = mkGraph("p0", "p_out", [mainRef, islandC, islandR, islandD], [wire("p2", "p_out")]);
    // The entire graph must pass full validation (not just the orphaned filter),
    // confirming the island is accepted by all IR rules including IR-1c.
    const r = validateGraph(g);
    if (!r.ok) throw new Error(r.errors.map((e) => `[${e.rule}] ${e.message}`).join("\n"));
    expect(r.ok).toBe(true);
  });
});
