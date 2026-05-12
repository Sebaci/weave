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
import { typeEq } from "../types/check.ts";
import type { Type } from "../types/type.ts";

// ---------------------------------------------------------------------------
// Builtin morphism implementations
// These correspond to the morphism names emitted by handleInfix in the
// typechecker (e.g. "add" for +, "sub" for -, ...).  They are resolved
// before looking in the elaborated module's def map.
// ---------------------------------------------------------------------------

type BuiltinFn = (input: Value) => Value;

const BUILTIN_MORPHISMS: Map<string, BuiltinFn> = new Map([
  ["builtin.add",  (v) => numOp(v, (a, b) => a + b, (a, b) => a + b)],
  ["builtin.sub",  (v) => numOp(v, (a, b) => a - b, (a, b) => a - b)],
  ["builtin.mul",  (v) => numOp(v, (a, b) => a * b, (a, b) => a * b)],
  // Int division truncates toward zero: (-7)/2 = -3, 7/(-2) = -3.
  // Division by zero yields 0 for Int (Math.trunc(Infinity) = 0 in JS).
  // These semantics are unspecified by the Weave v1 spec and should be treated
  // as implementation-defined until the spec is updated.
  ["builtin.div",  (v) => numOp(v, (a, b) => Math.trunc(a / b), (a, b) => a / b)],
  ["builtin.lt",   (v) => cmpOp(v, (a, b) => a < b)],
  ["builtin.gt",   (v) => cmpOp(v, (a, b) => a > b)],
  ["builtin.leq",  (v) => cmpOp(v, (a, b) => a <= b)],
  ["builtin.geq",  (v) => cmpOp(v, (a, b) => a >= b)],
  ["builtin.eq",   (v) => eqOp(v, true)],
  ["builtin.neq",  (v) => eqOp(v, false)],
  ["builtin.and",  (v) => boolOp(v, (a, b) => a && b)],
  ["builtin.or",   (v) => boolOp(v, (a, b) => a || b)],
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
      // Comparison is by constructor name + payload only, not by ADT identity.
      // Two constructors with the same name from different ADTs would compare
      // equal. This is safe because the typechecker prevents cross-ADT
      // compositions from reaching the interpreter.
      return a.ctor === bv.ctor && valuesEqual(a.payload, bv.payload);
    }
  }
}

export type EffectHandlers = Map<string, (input: Value) => Value>;

/** Thrown when interpret encounters an EffectNode with no registered handler. */
export class MissingEffectHandlerError extends Error {
  constructor(public readonly op: string) {
    super(`no runtime binding for effect operation '${op}'`);
    this.name = "MissingEffectHandlerError";
  }
}

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
        // All output ports receive the same JS reference. This is safe because
        // Values are immutable by construction (see value.ts immutability
        // invariant). If mutable Values are ever introduced, replace with a
        // deep clone per output.
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
        if (node.field !== undefined) {
          // Field-focused case .field: input is a record; discriminate on node.field
          if (v.tag !== "record") throw new Error(`interpret: case .${node.field}: expected record, got ${v.tag}`);
          const kVal = v.fields.get(node.field);
          if (!kVal) throw new Error(`interpret: case .${node.field}: field '${node.field}' not found`);
          // Context row: input record minus the discriminant field
          const contextRow = new Map<string, Value>(v.fields);
          contextRow.delete(node.field);
          // Determine constructor name from the field value
          let ctorName: string;
          let mergedFields: Map<string, Value>;
          if (kVal.tag === "bool") {
            // Bool is a builtin variant True | False; nullary branches receive contextRow
            ctorName = kVal.value ? "True" : "False";
            mergedFields = contextRow;
          } else if (kVal.tag === "variant") {
            ctorName = kVal.ctor;
            if (kVal.payload.tag === "unit") {
              mergedFields = contextRow;
            } else if (kVal.payload.tag === "record") {
              mergedFields = new Map<string, Value>(kVal.payload.fields);
              for (const [k, val] of contextRow) mergedFields.set(k, val);
            } else {
              throw new Error(`interpret: case .${node.field}: payload is not a record or unit`);
            }
          } else {
            throw new Error(`interpret: case .${node.field}: field '${node.field}' is not a variant or bool`);
          }
          const branch = node.branches.find((b) => b.tag === ctorName);
          if (!branch) throw new Error(`interpret: case .${node.field}: no branch for '${ctorName}'`);
          portValues.set(node.output.id, evalGraph(branch.graph, { tag: "record", fields: mergedFields }, defs, effects));
        } else {
          // Plain case: input is the variant value directly
          if (v.tag !== "variant") throw new Error(`interpret: case: expected variant, got ${v.tag}`);
          const branch = node.branches.find((b) => b.tag === v.ctor);
          if (!branch) throw new Error(`interpret: case: no branch for '${v.ctor}'`);
          portValues.set(node.output.id, evalGraph(branch.graph, v.payload, defs, effects));
        }
        break;
      }

      case "cata": {
        const v = getValue(node.input.id);
        portValues.set(node.output.id, evalCata(node.algebra, node.adtTy, v, defs, effects));
        break;
      }

      case "effect": {
        const handler = effects.get(node.op);
        if (!handler) throw new MissingEffectHandlerError(node.op);
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
 * Recursion is type-directed: we fold a sub-value only when its position in
 * the raw payload type equals adtTy (the ADT being folded). This correctly
 * handles parametric types like List (List Int) where inner and outer lists
 * share constructor names but are distinct types.
 *
 * Polynomial-functor semantics: only positions whose raw type exactly equals
 * adtTy are folded. A constructor with payload `{ children: List Tree }` hands
 * the inner Trees raw to the algebra — they are not folded. This matches the
 * classical base-functor definition (impl note 9.13) but diverges from a
 * naive reading of the spec's "recursive branches receive the already-folded
 * result". The spec should be clarified to match this behavior.
 *
 * Mutual recursion (multiple ADT types) is not supported in v1: CataNode.adtTy
 * is a single type, so sibling-ADT positions are never folded.
 *
 * Plain `throw new Error(...)` is used for invariant violations (elaborator
 * bugs): missing branches, wrong value shapes. These are distinct from
 * MissingEffectHandlerError which is a runtime (user-visible) condition.
 *
 * parallel-safe effects are evaluated sequentially (demand-driven). The effect
 * level is a type-system contract for external schedulers, not a runtime
 * concurrency guarantee in v1.
 */
function evalCata(
  algebra: { tag: string; rawPayloadTy: Type; graph: Graph }[],
  adtTy: Type,
  value: Value,
  defs: Map<string, Graph>,
  effects: EffectHandlers,
): Value {
  function fold(v: Value): Value {
    if (v.tag !== "variant") throw new Error(`interpret: cata: expected variant, got ${v.tag}`);
    const branch = algebra.find((b) => b.tag === v.ctor);
    if (!branch) throw new Error(`interpret: cata: no algebra branch for '${v.ctor}'`);
    const foldedPayload = foldPayload(v.payload, branch.rawPayloadTy);
    return evalGraph(branch.graph, foldedPayload, defs, effects);
  }

  // Recursively fold sub-values at positions whose raw type equals adtTy.
  function foldPayload(v: Value, rawTy: Type): Value {
    if (typeEq(rawTy, adtTy)) return fold(v);
    if (rawTy.tag === "Record" && v.tag === "record") {
      const fields = new Map<string, Value>();
      for (const field of rawTy.fields) {
        const fv = v.fields.get(field.name);
        if (fv !== undefined) fields.set(field.name, foldPayload(fv, field.ty));
      }
      for (const [k, fv] of v.fields) {
        if (!fields.has(k)) fields.set(k, fv);
      }
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
