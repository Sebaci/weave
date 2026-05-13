/**
 * IR validation — enforces IR-1 through IR-8 from weave-ir-v1.md §6.
 * Called eagerly after each Graph is constructed.
 */

import type { Graph, Node, Port, PortId } from "./ir.ts";
import { effectJoin, isConcrete, typeEq } from "../types/check.ts";
import { substAdt } from "../types/subst.ts";
import type { ConcreteEffect, Type } from "../types/type.ts";

export type ValidationError = { rule: string; message: string };
export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

export function validateGraph(graph: Graph): ValidationResult {
  const errors: ValidationError[] = [];

  // IR-1a: Wire endpoints reference known port IDs.
  const portTypeMap = collectPortTypeMap(graph);
  checkPortsConnected(graph, portTypeMap, errors);

  // IR-1b: Every node's ports are connected (no orphaned nodes or dangling inputs).
  checkNodeConnectivity(graph, errors);

  // IR-1c: Every node is forward-reachable from graph.inPort or a ConstNode output.
  checkNodeReachability(graph, errors);

  // IR-2: All sharing is explicit via DupNode.
  checkNoImplicitSharing(graph, errors);

  // IR-3: Wire endpoint types are compatible.
  checkWireTypeCompatibility(graph, portTypeMap, errors);

  // IR-4: Graph.effect equals the join of all contained node effects.
  checkEffectConsistency(graph, errors);

  // IR-4b: Per-node effect-level shapes match spec.
  checkNodeEffectShape(graph, errors);

  // IR-4c: CaseNode/CataNode declared effect equals join of branch graph effects.
  checkBranchEffectConsistency(graph, errors);

  // IR-6: CataNode algebra branch ports use substituted types.
  checkCataSubstitution(graph, errors);

  // IR-6b: CaseNode branch ports use correct types (plain and field-focused).
  checkCaseBranchPorts(graph, errors);

  // IR-7: All port types are fully concrete.
  checkConcreteTypes(graph, errors);

  // IR-8: Provenance is never empty on nodes from elaboration.
  checkProvenance(graph, errors);

  // Shape invariants: node-kind-specific structural constraints.
  checkNodeShapeInvariants(graph, errors);

  // Recurse into sub-graphs (CaseNode branches, CataNode algebra).
  for (const node of graph.nodes) {
    if (node.kind === "case") {
      for (const branch of node.branches) {
        const r = validateGraph(branch.graph);
        if (!r.ok) errors.push(...r.errors);
      }
    }
    if (node.kind === "cata") {
      for (const branch of node.algebra) {
        const r = validateGraph(branch.graph);
        if (!r.ok) errors.push(...r.errors);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// IR-1a: Port ID validity
// ---------------------------------------------------------------------------

function collectPortTypeMap(graph: Graph): Map<PortId, Type> {
  const map = new Map<PortId, Type>();
  map.set(graph.inPort.id, graph.inPort.ty);
  map.set(graph.outPort.id, graph.outPort.ty);
  for (const node of graph.nodes) {
    for (const port of nodePorts(node)) map.set(port.id, port.ty);
  }
  return map;
}

function checkPortsConnected(graph: Graph, portTypeMap: Map<PortId, Type>, errors: ValidationError[]) {
  for (const wire of graph.wires) {
    if (!portTypeMap.has(wire.from)) {
      errors.push({ rule: "IR-1", message: `Wire references unknown port '${wire.from}'` });
    }
    if (!portTypeMap.has(wire.to)) {
      errors.push({ rule: "IR-1", message: `Wire references unknown port '${wire.to}'` });
    }
  }
}

// ---------------------------------------------------------------------------
// IR-1b: Node connectivity (no orphaned nodes or dangling ports)
//
// The IR uses two connection patterns:
//   1. Explicit wires: wire(from, to) — from is a producer, to is a fresh consumer.
//   2. Direct port sharing: the same port ID serves as both a node output and a node
//      input (or as graph.inPort directly). No wire is needed because they are
//      literally the same port.
//
// "Supplied" for an input port P means: P == graph.inPort.id, OR P appears as
// wire.to, OR P appears as an output port of some other node.
//
// "Consumed" for an output port P means: P appears as wire.from, OR P appears as
// an input port of some node, OR P == graph.outPort.id.
//
// DropNode.output is intentionally dangling per §9.16 — carved out below.
// ---------------------------------------------------------------------------

function checkNodeConnectivity(graph: Graph, errors: ValidationError[]) {
  const wireTo   = new Set<PortId>(graph.wires.map((w) => w.to));
  const wireFrom = new Set<PortId>(graph.wires.map((w) => w.from));

  const allOutputPortIds = new Set<PortId>();
  const allInputPortIds  = new Set<PortId>();
  for (const node of graph.nodes) {
    for (const p of nodeOutputPorts(node)) allOutputPortIds.add(p.id);
    for (const p of nodeInputPorts(node))  allInputPortIds.add(p.id);
  }

  // graph.outPort must be fed: it must appear as wire.to (something wires to it).
  if (!wireTo.has(graph.outPort.id)) {
    errors.push({ rule: "IR-1", message: "graph.outPort has no incoming wire" });
  }

  for (const node of graph.nodes) {
    // Every node input port must be supplied (fed with a value).
    for (const p of nodeInputPorts(node)) {
      const supplied =
        p.id === graph.inPort.id  ||  // directly IS the graph input
        wireTo.has(p.id)          ||  // fed by a wire
        allOutputPortIds.has(p.id);   // directly IS the output of another node (port sharing)
      if (!supplied) {
        errors.push({
          rule:    "IR-1",
          message: `Node '${node.id}' (${node.kind}) input port '${p.id}' is not connected to any producer`,
        });
      }
    }

    // Every node output port must be consumed somewhere.
    // Carve-out: DropNode.output is intentionally dangling (§9.16).
    if (node.kind === "drop") continue;
    for (const p of nodeOutputPorts(node)) {
      const consumed =
        wireFrom.has(p.id)      ||  // taken by a wire
        allInputPortIds.has(p.id) || // directly used as input of another node (port sharing)
        p.id === graph.outPort.id;   // directly IS the graph output (unusual but valid)
      if (!consumed) {
        errors.push({
          rule:    "IR-1",
          message: `Node '${node.id}' (${node.kind}) output port '${p.id}' is not consumed anywhere`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// IR-1c: Global forward reachability from graph boundary
//
// Every node must be traceable from graph.inPort or a ConstNode output.
// ConstNode outputs are treated as self-sourced boundary seeds because they
// produce values without consuming the graph input.
//
// This catches cycle islands that pass IR-1b: two or more nodes in a cycle
// via port-sharing (A → B → A) where each input is locally supplied and each
// output is locally consumed, yet no node connects to the graph boundary.
//
// Known limitation: any subgraph sourced solely by ConstNodes and drained by
// DropNodes passes this check unchallenged — including const-seeded cycles and
// const → * → drop chains that are fully disconnected from outPort. ConstNode
// outputs are unconditional seeds, so any node reachable from them is marked
// reachable regardless of whether the path connects to outPort. Catching this
// requires a full forward-backward path check, not implemented in v1. The
// elaborator never produces such islands; they can only arise from hand-built IR.
// ---------------------------------------------------------------------------

function checkNodeReachability(graph: Graph, errors: ValidationError[]) {
  // Build forward wire index: from → [to, ...].
  const wireForward = new Map<PortId, PortId[]>();
  for (const wire of graph.wires) addToMultimap(wireForward, wire.from, wire.to);

  // Map each input port ID to its owning node (for through-node propagation).
  const inputPortNode = new Map<PortId, Node>();
  for (const node of graph.nodes) {
    for (const p of nodeInputPorts(node)) inputPortNode.set(p.id, node);
  }

  // BFS seeds: graph.inPort + all ConstNode outputs (self-sourced).
  const seeds: PortId[] = [graph.inPort.id];
  for (const node of graph.nodes) {
    if (node.kind === "const") seeds.push(node.output.id);
  }

  const reachable = new Set<PortId>(seeds);
  const queue = [...seeds];
  let i = 0;
  while (i < queue.length) {
    const p = queue[i++];
    // Follow wires forward.
    for (const next of wireForward.get(p) ?? []) {
      if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
    }
    // If p is an input port of node N, propagate to N's outputs (through-node).
    // For multi-input nodes (TupleNode), reaching ANY input is sufficient to
    // mark all outputs reachable. This is an intentional over-approximation:
    // it still correctly flags fully-disconnected cycle islands (none of their
    // inputs are ever reached), and the elaborator always supplies all inputs
    // before producing a well-formed graph.
    const node = inputPortNode.get(p);
    if (node) {
      for (const out of nodeOutputPorts(node)) {
        if (!reachable.has(out.id)) { reachable.add(out.id); queue.push(out.id); }
      }
    }
  }

  for (const node of graph.nodes) {
    if (!nodePorts(node).some((p) => reachable.has(p.id))) {
      errors.push({
        rule:    "IR-1",
        message: `Node '${node.id}' (${node.kind}) is not reachable from graph.inPort or any ConstNode (orphaned)`,
      });
    }
  }
}

function addToMultimap<K, V>(map: Map<K, V[]>, key: K, val: V): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

// ---------------------------------------------------------------------------
// IR-2: No implicit sharing
// ---------------------------------------------------------------------------

function checkNoImplicitSharing(graph: Graph, errors: ValidationError[]) {
  // A port may have at most one consumer total — either one outgoing wire or one
  // direct node-input reference, but not both, and not two of either.
  // DupNode outputs are subject to the same rule: each output feeds exactly one consumer.
  const consumeCount = new Map<PortId, number>();

  for (const wire of graph.wires) {
    consumeCount.set(wire.from, (consumeCount.get(wire.from) ?? 0) + 1);
  }

  // Also count direct port-sharing: a node input whose port id equals another
  // node's output port id (or the graph's inPort id).
  const producedPortIds = new Set<PortId>([
    graph.inPort.id,
    ...graph.nodes.flatMap((n) => nodeOutputPorts(n).map((p) => p.id)),
  ]);
  for (const node of graph.nodes) {
    for (const p of nodeInputPorts(node)) {
      if (producedPortIds.has(p.id)) {
        consumeCount.set(p.id, (consumeCount.get(p.id) ?? 0) + 1);
      }
    }
  }

  for (const [portId, count] of consumeCount) {
    if (count > 1) {
      errors.push({
        rule:    "IR-2",
        message: `Port '${portId}' has ${count} consumers (implicit sharing — use DupNode)`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// IR-3: Wire endpoint type compatibility
// ---------------------------------------------------------------------------

function checkWireTypeCompatibility(
  graph: Graph,
  portTypeMap: Map<PortId, Type>,
  errors: ValidationError[],
) {
  for (const wire of graph.wires) {
    const fromTy = portTypeMap.get(wire.from);
    const toTy   = portTypeMap.get(wire.to);
    if (fromTy === undefined || toTy === undefined) continue; // caught by IR-1a
    if (!typeEq(fromTy, toTy)) {
      errors.push({
        rule:    "IR-3",
        message: `Wire ${wire.from} -> ${wire.to}: type mismatch — ${showTy(fromTy)} vs ${showTy(toTy)}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// IR-4: Effect consistency
// ---------------------------------------------------------------------------

function checkEffectConsistency(graph: Graph, errors: ValidationError[]) {
  let joined: ConcreteEffect = "pure";
  for (const node of graph.nodes) {
    joined = effectJoin(joined, node.effect);
  }
  if (joined !== graph.effect) {
    errors.push({
      rule:    "IR-4",
      message: `Graph.effect is '${graph.effect}' but join of node effects is '${joined}'`,
    });
  }
}

// ---------------------------------------------------------------------------
// IR-4c: CaseNode/CataNode declared effect matches branch graph effect join
// ---------------------------------------------------------------------------

function checkBranchEffectConsistency(graph: Graph, errors: ValidationError[]) {
  for (const node of graph.nodes) {
    if (node.kind === "case") {
      let joined: ConcreteEffect = "pure";
      for (const b of node.branches) joined = effectJoin(joined, b.graph.effect);
      if (joined !== (node.effect as ConcreteEffect)) {
        errors.push({
          rule:    "IR-4c",
          message: `CaseNode '${node.id}' declared effect '${node.effect}' but branch join is '${joined}'`,
        });
      }
    }
    if (node.kind === "cata") {
      let joined: ConcreteEffect = "pure";
      for (const b of node.algebra) joined = effectJoin(joined, b.graph.effect);
      if (joined !== (node.effect as ConcreteEffect)) {
        errors.push({
          rule:    "IR-4c",
          message: `CataNode '${node.id}' declared effect '${node.effect}' but algebra join is '${joined}'`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// IR-4b: Per-node effect-level shape
// ---------------------------------------------------------------------------

const PURE_EFFECT_KINDS = new Set<Node["kind"]>(["dup", "drop", "proj", "tuple", "const", "ctor"]);

function checkNodeEffectShape(graph: Graph, errors: ValidationError[]) {
  for (const node of graph.nodes) {
    // Use a widening cast to read the runtime effect value unnarrowed.
    const eff = node.effect as ConcreteEffect;
    if (PURE_EFFECT_KINDS.has(node.kind)) {
      if (eff !== "pure") {
        errors.push({
          rule:    "IR-4",
          message: `Node '${node.id}' (${node.kind}) must have effect 'pure', got '${eff}'`,
        });
      }
    } else if (node.kind === "effect") {
      if (eff !== "parallel-safe" && eff !== "sequential") {
        errors.push({
          rule:    "IR-4",
          message: `EffectNode '${node.id}' must have effect 'parallel-safe' or 'sequential', got '${eff}'`,
        });
      }
    }
    // case, cata, ref: effect is the join of sub-effects; no fixed shape constraint.
  }
}

// ---------------------------------------------------------------------------
// IR-6: CataNode algebra branch substitution
// ---------------------------------------------------------------------------

function checkCataSubstitution(graph: Graph, errors: ValidationError[]) {
  for (const node of graph.nodes) {
    if (node.kind !== "cata") continue;
    for (const branch of node.algebra) {
      // inPort type must be Pi[carrierTy/adtTy]
      const expectedIn = substAdt(branch.rawPayloadTy, node.adtTy, node.carrierTy);
      const actualIn   = branch.graph.inPort.ty;
      if (!typeEq(actualIn, expectedIn)) {
        errors.push({
          rule:    "IR-6",
          message:
            `CataNode algebra branch '${branch.tag}': inPort type mismatch` +
            ` — expected ${showTy(expectedIn)}, got ${showTy(actualIn)}`,
        });
      }
      // outPort type must equal carrierTy
      const actualOut = branch.graph.outPort.ty;
      if (!typeEq(actualOut, node.carrierTy)) {
        errors.push({
          rule:    "IR-6",
          message:
            `CataNode algebra branch '${branch.tag}': outPort type mismatch` +
            ` — expected ${showTy(node.carrierTy)}, got ${showTy(actualOut)}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// IR-6b: CaseNode branch port types
// ---------------------------------------------------------------------------

function checkCaseBranchPorts(graph: Graph, errors: ValidationError[]) {
  for (const node of graph.nodes) {
    if (node.kind !== "case") continue;

    if (node.field !== undefined) {
      // Field-focused case: branch inPort = merge(Pi, contextTy) or contextTy for nullary.
      checkCaseFieldBranches(node.field, node.contextTy, node.branches, node.outTy, errors);
    } else {
      // Plain case: branch inPort = rawPayloadTy.
      for (const branch of node.branches) {
        const expected = branch.rawPayloadTy;
        const actual   = branch.graph.inPort.ty;
        if (!typeEq(actual, expected)) {
          errors.push({
            rule:    "IR-6b",
            message:
              `CaseNode branch '${branch.tag}': inPort type mismatch` +
              ` — expected ${showTy(expected)}, got ${showTy(actual)}`,
          });
        }
      }
    }

    // Both plain and field case: every branch outPort must equal node.outTy.
    for (const branch of node.branches) {
      const actual = branch.graph.outPort.ty;
      if (!typeEq(actual, node.outTy)) {
        errors.push({
          rule:    "IR-6b",
          message:
            `CaseNode branch '${branch.tag}': outPort type mismatch` +
            ` — expected ${showTy(node.outTy)}, got ${showTy(actual)}`,
        });
      }
    }
  }
}

function checkCaseFieldBranches(
  field: string,
  contextTy: Type | undefined,
  branches: { tag: string; rawPayloadTy: Type; graph: Graph }[],
  _outTy: Type,
  errors: ValidationError[],
) {
  if (contextTy === undefined || contextTy.tag !== "Record") {
    errors.push({ rule: "IR-6b", message: `CaseNode(field=${field}): contextTy is missing or not a Record` });
    return;
  }
  const contextFields = new Set(contextTy.fields.map((f) => f.name));

  for (const branch of branches) {
    const pi = branch.rawPayloadTy;
    let expected: Type;

    if (pi.tag === "Unit") {
      expected = contextTy;
    } else if (pi.tag === "Record") {
      // F-4: disjointness — fields(Pi) ∩ fields(contextTy) must be empty.
      for (const f of pi.fields) {
        if (contextFields.has(f.name)) {
          errors.push({
            rule:    "IR-6b",
            message:
              `CaseNode(field=${field}) branch '${branch.tag}': payload field '${f.name}' collides with contextTy field`,
          });
        }
      }
      expected = { tag: "Record", fields: [...pi.fields, ...contextTy.fields], rest: null };
    } else {
      errors.push({
        rule:    "IR-6b",
        message: `CaseNode(field=${field}) branch '${branch.tag}': rawPayloadTy is not Unit or Record`,
      });
      continue;
    }

    const actual = branch.graph.inPort.ty;
    if (!typeEq(actual, expected)) {
      errors.push({
        rule:    "IR-6b",
        message:
          `CaseNode(field=${field}) branch '${branch.tag}': inPort type mismatch` +
          ` — expected ${showTy(expected)}, got ${showTy(actual)}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// IR-7: Concrete types
// ---------------------------------------------------------------------------

function checkConcreteTypes(graph: Graph, errors: ValidationError[]) {
  const check = (port: Port, location: string) => {
    if (!isConcrete(port.ty)) {
      errors.push({
        rule:    "IR-7",
        message: `Port '${port.id}' at ${location} has non-concrete type`,
      });
    }
  };

  check(graph.inPort, "graph.inPort");
  check(graph.outPort, "graph.outPort");
  for (const node of graph.nodes) {
    for (const port of nodePorts(node)) {
      check(port, `node ${node.id} (${node.kind})`);
    }
  }
}

// ---------------------------------------------------------------------------
// IR-8: Provenance non-empty
// ---------------------------------------------------------------------------

function checkProvenance(graph: Graph, errors: ValidationError[]) {
  for (const node of graph.nodes) {
    if (node.provenance.length === 0) {
      errors.push({
        rule:    "IR-8",
        message: `Node '${node.id}' (${node.kind}) has empty provenance`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Shape invariants (node-kind structural constraints)
// ---------------------------------------------------------------------------

function checkNodeShapeInvariants(graph: Graph, errors: ValidationError[]) {
  for (const node of graph.nodes) {
    switch (node.kind) {
      case "dup": {
        if (node.outputs.length < 2) {
          errors.push({
            rule:    "IR-shape",
            message: `DupNode '${node.id}' has ${node.outputs.length} output(s) — must be >= 2`,
          });
        }
        for (const out of node.outputs) {
          if (!typeEq(out.ty, node.input.ty)) {
            errors.push({
              rule:    "IR-shape",
              message:
                `DupNode '${node.id}' output port '${out.id}' type ${showTy(out.ty)}` +
                ` does not match input type ${showTy(node.input.ty)}`,
            });
          }
        }
        break;
      }

      case "drop": {
        if (node.output.ty.tag !== "Unit") {
          errors.push({
            rule:    "IR-shape",
            message: `DropNode '${node.id}' output type must be Unit, got ${showTy(node.output.ty)}`,
          });
        }
        break;
      }

      case "proj": {
        const inTy = node.input.ty;
        if (inTy.tag !== "Record") {
          errors.push({
            rule:    "IR-shape",
            message: `ProjNode '${node.id}' input type must be Record, got ${showTy(inTy)}`,
          });
          break;
        }
        const fieldEntry = inTy.fields.find((f) => f.name === node.field);
        if (!fieldEntry) {
          errors.push({
            rule:    "IR-shape",
            message: `ProjNode '${node.id}' field '${node.field}' not found in input type ${showTy(inTy)}`,
          });
          break;
        }
        if (!typeEq(node.output.ty, fieldEntry.ty)) {
          errors.push({
            rule:    "IR-shape",
            message:
              `ProjNode '${node.id}' output type ${showTy(node.output.ty)}` +
              ` does not match field '${node.field}' type ${showTy(fieldEntry.ty)}`,
          });
        }
        break;
      }

      case "tuple": {
        const expected: Type = {
          tag: "Record",
          fields: node.inputs.map((i) => ({ name: i.label, ty: i.port.ty })),
          rest: null,
        };
        if (!typeEq(node.output.ty, expected)) {
          errors.push({
            rule:    "IR-shape",
            message:
              `TupleNode '${node.id}' output type ${showTy(node.output.ty)}` +
              ` does not match expected ${showTy(expected)}`,
          });
        }
        break;
      }

      case "case": {
        if (!typeEq(node.output.ty, node.outTy)) {
          errors.push({
            rule:    "IR-shape",
            message:
              `CaseNode '${node.id}' output port type ${showTy(node.output.ty)}` +
              ` does not match outTy ${showTy(node.outTy)}`,
          });
        }
        // For plain case, input type must equal variantTy.
        // For field-focused case, input.ty is the full record; variantTy is the field's variant type.
        if (node.field === undefined && !typeEq(node.input.ty, node.variantTy)) {
          errors.push({
            rule:    "IR-shape",
            message:
              `CaseNode '${node.id}' input port type ${showTy(node.input.ty)}` +
              ` does not match variantTy ${showTy(node.variantTy)}`,
          });
        }
        break;
      }

      case "cata": {
        if (!typeEq(node.input.ty, node.adtTy)) {
          errors.push({
            rule:    "IR-shape",
            message:
              `CataNode '${node.id}' input port type ${showTy(node.input.ty)}` +
              ` does not match adtTy ${showTy(node.adtTy)}`,
          });
        }
        if (!typeEq(node.output.ty, node.carrierTy)) {
          errors.push({
            rule:    "IR-shape",
            message:
              `CataNode '${node.id}' output port type ${showTy(node.output.ty)}` +
              ` does not match carrierTy ${showTy(node.carrierTy)}`,
          });
        }
        break;
      }

      case "ctor": {
        if (!typeEq(node.output.ty, node.adtTy)) {
          errors.push({
            rule:    "IR-shape",
            message:
              `CtorNode '${node.id}' (${node.ctorName}) output type ${showTy(node.output.ty)}` +
              ` does not match adtTy ${showTy(node.adtTy)}`,
          });
        }
        break;
      }

      // const, effect, ref: no additional shape constraints beyond type checking.
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: all ports on a node
// ---------------------------------------------------------------------------

function nodePorts(node: Node): Port[] {
  switch (node.kind) {
    case "dup":    return [node.input, ...node.outputs];
    case "drop":   return [node.input, node.output];
    case "proj":   return [node.input, node.output];
    case "tuple":  return [...node.inputs.map((i) => i.port), node.output];
    case "case":   return [node.input, node.output];
    case "cata":   return [node.input, node.output];
    case "const":  return [node.output];
    case "ctor":   return [node.input, node.output];
    case "effect": return [node.input, node.output];
    case "ref":    return [node.input, node.output];
  }
}

function nodeInputPorts(node: Node): Port[] {
  switch (node.kind) {
    case "const":  return [];
    case "dup":    return [node.input];
    case "drop":   return [node.input];
    case "proj":   return [node.input];
    case "tuple":  return node.inputs.map((i) => i.port);
    case "case":   return [node.input];
    case "cata":   return [node.input];
    case "ctor":   return [node.input];
    case "effect": return [node.input];
    case "ref":    return [node.input];
  }
}

function nodeOutputPorts(node: Node): Port[] {
  switch (node.kind) {
    case "dup":    return node.outputs;
    case "drop":   return [node.output];
    case "proj":   return [node.output];
    case "tuple":  return [node.output];
    case "case":   return [node.output];
    case "cata":   return [node.output];
    case "const":  return [node.output];
    case "ctor":   return [node.output];
    case "effect": return [node.output];
    case "ref":    return [node.output];
  }
}

// ---------------------------------------------------------------------------
// Type display helper
// ---------------------------------------------------------------------------

function showTy(ty: Type): string {
  switch (ty.tag) {
    case "Unit":   return "Unit";
    case "Int":    return "Int";
    case "Float":  return "Float";
    case "Bool":   return "Bool";
    case "Text":   return "Text";
    case "TyVar":  return ty.name;
    case "Record":
      return `{ ${ty.fields.map((f) => `${f.name}: ${showTy(f.ty)}`).join(", ")}${ty.rest ? ` | ${ty.rest}` : ""} }`;
    case "Named":
      return ty.args.length === 0 ? ty.name : `${ty.name} ${ty.args.map(showTy).join(" ")}`;
    case "Arrow":
      return `(${showTy(ty.from)} -> ${showTy(ty.to)})`;
  }
}
