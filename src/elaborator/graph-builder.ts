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
