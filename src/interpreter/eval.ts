/**
 * Weave v1 Graph Interpreter.
 *
 * Evaluates an elaborated Graph by threading a Value through nodes in
 * dependency order.  CataNode is the only semantic special case: it performs
 * bottom-up structural recursion rather than plain dataflow.
 *
 * External effect handlers are supplied by the caller as a Map from OpRef to
 * a function (Value -> Value).  Unknown OpRefs at evaluation time are
 * interpreter errors, not type errors.
 */

import type { Graph, Node, PortId } from "../ir/ir.ts";
import type { LiteralValue } from "../ir/ir.ts";
import type { ElaboratedModule } from "../ir/ir.ts";
import { type Value, VUnit, vInt, vFloat, vBool, vText } from "./value.ts";

// ---------------------------------------------------------------------------
// Builtin morphism implementations
// These correspond to the morphism names emitted by handleInfix in the
// typechecker (e.g. "add" for +, "sub" for -, ...).  They are resolved
// before looking in the elaborated module's def map.
// ---------------------------------------------------------------------------

type BuiltinFn = (input: Value) => Value;

const BUILTIN_MORPHISMS: Map<string, BuiltinFn> = new Map([
  ["add",  (v) => numOp(v, (a, b) => a + b, (a, b) => a + b)],
  ["sub",  (v) => numOp(v, (a, b) => a - b, (a, b) => a - b)],
  ["mul",  (v) => numOp(v, (a, b) => a * b, (a, b) => a * b)],
  ["div",  (v) => numOp(v, (a, b) => Math.trunc(a / b), (a, b) => a / b)],
  ["lt",   (v) => cmpOp(v, (a, b) => a < b)],
  ["gt",   (v) => cmpOp(v, (a, b) => a > b)],
  ["leq",  (v) => cmpOp(v, (a, b) => a <= b)],
  ["geq",  (v) => cmpOp(v, (a, b) => a >= b)],
  ["eq",   (v) => eqOp(v, true)],
  ["neq",  (v) => eqOp(v, false)],
  ["and",  (v) => boolOp(v, (a, b) => a && b)],
  ["or",   (v) => boolOp(v, (a, b) => a || b)],
]);

function getLR(v: Value, opName: string): { l: Value; r: Value } {
  if (v.tag !== "record") throw new Error(`${opName}: expected record`);
  return { l: v.fields.get("l")!, r: v.fields.get("r")! };
}

function numOp(v: Value, intFn: (a: number, b: number) => number, floatFn: (a: number, b: number) => number): Value {
  const { l, r } = getLR(v, "numOp");
  if (l.tag === "int"   && r.tag === "int")   return vInt(intFn(l.value, r.value));
  if (l.tag === "float" && r.tag === "float") return vFloat(floatFn(l.value, r.value));
  throw new Error("numOp: unsupported operand types");
}

function cmpOp(v: Value, pred: (a: number, b: number) => boolean): Value {
  const { l, r } = getLR(v, "cmpOp");
  if ((l.tag === "int" || l.tag === "float") && (r.tag === "int" || r.tag === "float")) {
    return vBool(pred(l.value, r.value));
  }
  throw new Error("cmpOp: unsupported operand types");
}

function eqOp(v: Value, positive: boolean): Value {
  const { l, r } = getLR(v, "eqOp");
  const eq = valuesEqual(l, r);
  return vBool(positive ? eq : !eq);
}

function boolOp(v: Value, fn: (a: boolean, b: boolean) => boolean): Value {
  const { l, r } = getLR(v, "boolOp");
  if (l.tag !== "bool" || r.tag !== "bool") throw new Error("boolOp: expected booleans");
  return vBool(fn(l.value, r.value));
}

function valuesEqual(a: Value, b: Value): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case "unit":  return true;
    case "int":   return a.value === (b as typeof a).value;
    case "float": return a.value === (b as typeof a).value;
    case "bool":  return a.value === (b as typeof a).value;
    case "text":  return a.value === (b as typeof a).value;
    case "record": {
      const bf = (b as typeof a).fields;
      if (a.fields.size !== bf.size) return false;
      for (const [k, v] of a.fields) {
        const bv = bf.get(k);
        if (!bv || !valuesEqual(v, bv)) return false;
      }
      return true;
    }
    case "variant": {
      const bv = b as typeof a;
      return a.ctor === bv.ctor && valuesEqual(a.payload, bv.payload);
    }
  }
}

export type EffectHandlers = Map<string, (input: Value) => Value>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Interpret a named def from an elaborated module.
 * `input` is the morphism's domain value; `effects` supplies runtime handlers.
 */
export function interpret(
  mod: ElaboratedModule,
  defName: string,
  input: Value,
  effects: EffectHandlers = new Map(),
): Value {
  const graph = mod.defs.get(defName);
  if (!graph) throw new Error(`interpret: no graph for def '${defName}'`);
  return evalGraph(graph, input, mod.defs, effects);
}

/**
 * Evaluate a single Graph directly.
 */
export function evalGraph(
  graph: Graph,
  input: Value,
  defs: Map<string, Graph>,
  effects: EffectHandlers,
): Value {
  const portValues = new Map<PortId, Value>();
  portValues.set(graph.inPort.id, input);

  // Wire map: destination port → source port
  const wireFrom = new Map<PortId, PortId>();
  for (const wire of graph.wires) {
    wireFrom.set(wire.to, wire.from);
  }

  // Node producer map: output port id → the node that produces it
  const portProducer = new Map<PortId, Node>();
  for (const node of graph.nodes) {
    for (const pid of outputPortIds(node)) {
      portProducer.set(pid, node);
    }
  }

  function getValue(portId: PortId): Value {
    // Already computed?
    const cached = portValues.get(portId);
    if (cached !== undefined) return cached;

    // Follow a wire to its source
    const src = wireFrom.get(portId);
    if (src !== undefined) {
      const v = getValue(src);
      portValues.set(portId, v);
      return v;
    }

    // Produce via the owning node
    const node = portProducer.get(portId);
    if (!node) throw new Error(`interpret: no producer for port '${portId}'`);
    evalNode(node);
    const result = portValues.get(portId);
    if (result === undefined) throw new Error(`interpret: node did not populate port '${portId}'`);
    return result;
  }

  function evalNode(node: Node): void {
    // Idempotent: if every output port is already known, skip
    if (outputPortIds(node).every((pid) => portValues.has(pid))) return;

    switch (node.kind) {
      case "const": {
        portValues.set(node.output.id, literalToValue(node.value));
        break;
      }

      case "dup": {
        const v = getValue(node.input.id);
        for (const outPort of node.outputs) portValues.set(outPort.id, v);
        break;
      }

      case "drop": {
        getValue(node.input.id); // evaluate for potential effects, result discarded
        portValues.set(node.output.id, VUnit);
        break;
      }

      case "proj": {
        const v = getValue(node.input.id);
        if (v.tag !== "record") throw new Error(`interpret: proj '${node.field}': expected record, got ${v.tag}`);
        const fv = v.fields.get(node.field);
        if (fv === undefined) throw new Error(`interpret: proj '${node.field}': field not found`);
        portValues.set(node.output.id, fv);
        break;
      }

      case "tuple": {
        const fields = new Map<string, Value>();
        for (const inp of node.inputs) {
          fields.set(inp.label, getValue(inp.port.id));
        }
        portValues.set(node.output.id, { tag: "record", fields });
        break;
      }

      case "ctor": {
        const payload = getValue(node.input.id);
        portValues.set(node.output.id, { tag: "variant", ctor: node.ctorName, payload });
        break;
      }

      case "case": {
        const v = getValue(node.input.id);
        if (v.tag !== "variant") throw new Error(`interpret: case: expected variant, got ${v.tag}`);
        const branch = node.branches.find((b) => b.tag === v.ctor);
        if (!branch) throw new Error(`interpret: case: no branch for '${v.ctor}'`);
        portValues.set(node.output.id, evalGraph(branch.graph, v.payload, defs, effects));
        break;
      }

      case "cata": {
        const v = getValue(node.input.id);
        portValues.set(node.output.id, evalCata(node.algebra, v, defs, effects));
        break;
      }

      case "effect": {
        const handler = effects.get(node.op);
        if (!handler) throw new Error(`interpret: no effect handler for '${node.op}'`);
        portValues.set(node.output.id, handler(getValue(node.input.id)));
        break;
      }

      case "ref": {
        const inputVal = getValue(node.input.id);
        const builtin = BUILTIN_MORPHISMS.get(node.defId);
        if (builtin) {
          portValues.set(node.output.id, builtin(inputVal));
          break;
        }
        const defGraph = defs.get(node.defId);
        if (!defGraph) throw new Error(`interpret: no graph for ref '${node.defId}'`);
        portValues.set(node.output.id, evalGraph(defGraph, inputVal, defs, effects));
        break;
      }
    }
  }

  return getValue(graph.outPort.id);
}

// ---------------------------------------------------------------------------
// CataNode — bottom-up catamorphism (semantic special case)
// ---------------------------------------------------------------------------

/**
 * Evaluate a catamorphism bottom-up.
 *
 * The algebra is the set of branch graphs whose input types are Pi[A/μF]:
 * recursive fields already carry the carrier type A, not the raw ADT μF.
 *
 * We detect recursive substructures by checking if a value's variant
 * constructor appears in the algebra's branch set.
 */
function evalCata(
  algebra: { tag: string; graph: Graph }[],
  value: Value,
  defs: Map<string, Graph>,
  effects: EffectHandlers,
): Value {
  const ctorSet = new Set(algebra.map((b) => b.tag));

  function fold(v: Value): Value {
    if (v.tag !== "variant") throw new Error(`interpret: cata: expected variant, got ${v.tag}`);
    const foldedPayload = foldPayload(v.payload);
    const branch = algebra.find((b) => b.tag === v.ctor);
    if (!branch) throw new Error(`interpret: cata: no algebra branch for '${v.ctor}'`);
    return evalGraph(branch.graph, foldedPayload, defs, effects);
  }

  // Recursively fold any subvalue that is itself an ADT node (its ctor is in the algebra).
  function foldPayload(v: Value): Value {
    if (v.tag === "variant" && ctorSet.has(v.ctor)) return fold(v);
    if (v.tag === "record") {
      const fields = new Map<string, Value>();
      for (const [k, fv] of v.fields) fields.set(k, foldPayload(fv));
      return { tag: "record", fields };
    }
    return v;
  }

  return fold(value);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function literalToValue(lit: LiteralValue): Value {
  switch (lit.tag) {
    case "unit":  return VUnit;
    case "int":   return vInt(lit.value);
    case "float": return vFloat(lit.value);
    case "bool":  return vBool(lit.value);
    case "text":  return vText(lit.value);
  }
}

/** Returns the IDs of all output ports produced by a node. */
function outputPortIds(node: Node): PortId[] {
  switch (node.kind) {
    case "dup":    return node.outputs.map((p) => p.id);
    case "drop":   return [node.output.id];
    case "proj":   return [node.output.id];
    case "tuple":  return [node.output.id];
    case "case":   return [node.output.id];
    case "cata":   return [node.output.id];
    case "const":  return [node.output.id];
    case "ctor":   return [node.output.id];
    case "effect": return [node.output.id];
    case "ref":    return [node.output.id];
  }
}
