/**
 * GraphBuilder — mutable accumulator that builds an immutable Graph.
 *
 * Each sub-graph (branch handler, algebra branch) gets its own GraphBuilder
 * instance. Call build() to freeze the graph.
 *
 * ID generation is global (module-level counter) so IDs are unique across
 * the entire elaborated module.
 */

import type {
  Graph, GraphId, Node, NodeId, Port, PortId, Wire, Provenance,
} from "../ir/ir.ts";
import type { Type, ConcreteEffect } from "../types/type.ts";
import { effectJoin } from "../types/check.ts";
import type { SourceNodeId } from "../surface/id.ts";

// ---------------------------------------------------------------------------
// Global ID counters
// ---------------------------------------------------------------------------

let _graphCounter = 0;
let _nodeCounter  = 0;
let _portCounter  = 0;

export function freshGraphId(): GraphId { return `g_${++_graphCounter}`; }
export function freshNodeId():  NodeId  { return `nd_${++_nodeCounter}`; }
export function freshPortId():  PortId  { return `p_${++_portCounter}`; }

export function resetElabCounters(): void {
  _graphCounter = 0;
  _nodeCounter  = 0;
  _portCounter  = 0;
}

// ---------------------------------------------------------------------------
// GraphBuilder
// ---------------------------------------------------------------------------

export class GraphBuilder {
  private _nodes: Node[]  = [];
  private _wires: Wire[]  = [];

  addNode(node: Node): void {
    this._nodes.push(node);
  }

  wire(from: PortId, to: PortId): void {
    this._wires.push({ from, to });
  }

  /**
   * Returns true if `portId` has already been "consumed as a source" — meaning
   * it appears as `wire.from` in a wire, or directly as a node's input port ID
   * (the direct-port-sharing pattern used by 1-binder handlers and DupNode binders).
   *
   * Used by LocalRef and Literal elaboration to decide whether to insert a DropNode
   * for the current flowing port.
   */
  isPortConsumedAsSource(portId: PortId): boolean {
    if (this._wires.some((w) => w.from === portId)) return true;
    return this._nodes.some((n) => nodeInputPortIds(n).includes(portId));
  }

  build(
    inPort:     Port,
    outPort:    Port,
    provenance: Provenance[],
  ): Graph {
    let eff: ConcreteEffect = "pure";
    for (const node of this._nodes) eff = effectJoin(eff, node.effect);
    return {
      id:         freshGraphId(),
      inPort,
      outPort,
      effect:     eff,
      nodes:      [...this._nodes],
      wires:      [...this._wires],
      provenance,
    };
  }
}

// ---------------------------------------------------------------------------
// Port construction helpers
// ---------------------------------------------------------------------------

export function mkPort(ty: Type): Port {
  return { id: freshPortId(), ty };
}

export function prov(sourceId: SourceNodeId, role?: string): Provenance {
  return role !== undefined ? { sourceId, role } : { sourceId };
}

// ---------------------------------------------------------------------------
// Internal: node input port ID extraction (used by isPortConsumedAsSource)
// ---------------------------------------------------------------------------

function nodeInputPortIds(node: Node): PortId[] {
  switch (node.kind) {
    case "const":  return [];
    case "dup":    return [node.input.id];
    case "drop":   return [node.input.id];
    case "proj":   return [node.input.id];
    case "tuple":  return node.inputs.map((i) => i.port.id);
    case "case":   return [node.input.id];
    case "cata":   return [node.input.id];
    case "ctor":   return [node.input.id];
    case "effect": return [node.input.id];
    case "ref":    return [node.input.id];
  }
}
