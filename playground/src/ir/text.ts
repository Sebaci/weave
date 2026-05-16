/**
 * Human-readable text rendering of an elaborated IR graph.
 *
 * One line per node, then a wire list.  Case/cata branch sub-graphs are
 * rendered recursively with indentation.  ID normalization mirrors
 * serialize.ts: fresh p0/n0 counters per graph scope.
 */

import type { Graph, Node, LiteralValue } from "../../../src/ir/ir.ts";
import type { Type } from "../../../src/types/type.ts";

// ---------------------------------------------------------------------------
// Type formatter
// ---------------------------------------------------------------------------

function fmtTy(ty: Type): string {
  switch (ty.tag) {
    case "Unit":   return "()";
    case "Int":    return "Int";
    case "Float":  return "Float";
    case "Bool":   return "Bool";
    case "Text":   return "Text";
    case "TyVar":  return ty.name;
    case "Record": {
      if (ty.fields.length === 0) return "{}";
      const fs = ty.fields.map(f => `${f.name}:${fmtTy(f.ty)}`).join(", ");
      return `{${fs}}`;
    }
    case "Named":
      return ty.args.length === 0
        ? ty.name
        : `(${ty.name} ${ty.args.map(fmtTy).join(" ")})`;
    case "Arrow":
      return `${fmtTy(ty.from)} → ${fmtTy(ty.to)}`;
  }
}

// ---------------------------------------------------------------------------
// Literal formatter
// ---------------------------------------------------------------------------

function fmtLit(v: LiteralValue): string {
  switch (v.tag) {
    case "int":   return String(v.value);
    case "float": return String(v.value);
    case "bool":  return String(v.value);
    case "text":  return JSON.stringify(v.value);
    case "unit":  return "()";
  }
}

// ---------------------------------------------------------------------------
// Per-graph ID scope
// ---------------------------------------------------------------------------

interface Scope {
  portMap: Map<string, string>;
  nodeMap: Map<string, string>;
  pc: number;
  nc: number;
}

function mkScope(): Scope {
  return { portMap: new Map(), nodeMap: new Map(), pc: 0, nc: 0 };
}

function ap(sc: Scope, id: string): void {
  if (!sc.portMap.has(id)) sc.portMap.set(id, `p${sc.pc++}`);
}

function an(sc: Scope, id: string): void {
  if (!sc.nodeMap.has(id)) sc.nodeMap.set(id, `n${sc.nc++}`);
}

function rp(sc: Scope, id: string): string { return sc.portMap.get(id) ?? id; }
function rn(sc: Scope, id: string): string { return sc.nodeMap.get(id) ?? id; }

// ---------------------------------------------------------------------------
// Pre-scan: assign IDs in stable order (mirrors serialize.ts)
// ---------------------------------------------------------------------------

function scanGraph(sc: Scope, graph: Graph): void {
  ap(sc, graph.inPort.id);
  ap(sc, graph.outPort.id);
  for (const node of graph.nodes) {
    an(sc, node.id);
    scanNodePorts(sc, node);
  }
}

function scanNodePorts(sc: Scope, node: Node): void {
  switch (node.kind) {
    case "const":
      ap(sc, node.output.id);
      break;
    case "dup":
      ap(sc, node.input.id);
      for (const o of node.outputs) ap(sc, o.id);
      break;
    case "drop":
    case "proj":
    case "ctor":
    case "effect":
    case "ref":
      ap(sc, node.input.id);
      ap(sc, node.output.id);
      break;
    case "tuple":
      for (const inp of node.inputs) ap(sc, inp.port.id);
      ap(sc, node.output.id);
      break;
    case "case":
    case "cata":
      ap(sc, node.input.id);
      ap(sc, node.output.id);
      // branch graphs get their own scope
      break;
  }
}

// ---------------------------------------------------------------------------
// Node formatter
// ---------------------------------------------------------------------------

function fmtNode(sc: Scope, node: Node, indent: string): string {
  const id = rn(sc, node.id);
  const pfx = `${indent}${id.padEnd(4)}`;

  switch (node.kind) {
    case "const":
      return `${pfx}  const  ${fmtLit(node.value).padEnd(14)}  →  ${rp(sc, node.output.id)} : ${fmtTy(node.output.ty)}`;

    case "dup": {
      const outs = node.outputs.map(o => `${rp(sc, o.id)}:${fmtTy(o.ty)}`).join(", ");
      return `${pfx}  dup    ${rp(sc, node.input.id)}:${fmtTy(node.input.ty)}  →  ${outs}`;
    }

    case "drop":
      return `${pfx}  drop   ${rp(sc, node.input.id)}:${fmtTy(node.input.ty)}  →  ${rp(sc, node.output.id)}:()`;

    case "proj":
      return `${pfx}  proj   .${node.field}  ${rp(sc, node.input.id)}:${fmtTy(node.input.ty)}  →  ${rp(sc, node.output.id)}:${fmtTy(node.output.ty)}`;

    case "tuple": {
      const ins = node.inputs.map(inp => `${inp.label}:${rp(sc, inp.port.id)}`).join(", ");
      return `${pfx}  tuple  {${ins}}  →  ${rp(sc, node.output.id)}:${fmtTy(node.output.ty)}`;
    }

    case "ctor":
      return `${pfx}  ctor   .${node.ctorName}  ${rp(sc, node.input.id)}:${fmtTy(node.input.ty)}  →  ${rp(sc, node.output.id)}:${fmtTy(node.output.ty)}`;

    case "ref":
      return `${pfx}  ref    ${node.defId}  ${rp(sc, node.input.id)}:${fmtTy(node.input.ty)}  →  ${rp(sc, node.output.id)}:${fmtTy(node.output.ty)}`;

    case "effect":
      return `${pfx}  effect ${node.op}  ${rp(sc, node.input.id)}:${fmtTy(node.input.ty)}  →  ${rp(sc, node.output.id)}:${fmtTy(node.output.ty)}  ! ${node.effect}`;

    case "case": {
      const header = `${pfx}  case${node.field ? ` .${node.field}` : ""}   ${rp(sc, node.input.id)}:${fmtTy(node.input.ty)}  →  ${rp(sc, node.output.id)}:${fmtTy(node.output.ty)}`;
      const branches = node.branches.map(b => {
        const sub = fmtGraph(b.graph, indent + "    ", `.${b.tag}`);
        return sub;
      });
      return [header, ...branches].join("\n");
    }

    case "cata": {
      const header = `${pfx}  cata   ${rp(sc, node.input.id)}:${fmtTy(node.input.ty)}  →  ${rp(sc, node.output.id)}:${fmtTy(node.output.ty)}`;
      const branches = node.algebra.map(b => {
        const sub = fmtGraph(b.graph, indent + "    ", `.${b.tag}`);
        return sub;
      });
      return [header, ...branches].join("\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Graph formatter (recursive)
// ---------------------------------------------------------------------------

function fmtGraph(graph: Graph, indent: string, label?: string): string {
  const sc = mkScope();
  scanGraph(sc, graph);

  const lines: string[] = [];
  const prefix = label ? `${indent}${label}: ` : indent;

  lines.push(`${prefix}${fmtTy(graph.inPort.ty)} → ${fmtTy(graph.outPort.ty)}  ! ${graph.effect}`);
  lines.push(`${indent}  in:  ${rp(sc, graph.inPort.id)} : ${fmtTy(graph.inPort.ty)}`);
  lines.push(`${indent}  out: ${rp(sc, graph.outPort.id)} : ${fmtTy(graph.outPort.ty)}`);

  if (graph.nodes.length > 0) {
    lines.push("");
    for (const node of graph.nodes) {
      lines.push(fmtNode(sc, node, indent + "  "));
    }
  }

  if (graph.wires.length > 0) {
    lines.push("");
    lines.push(`${indent}  wires:`);
    for (const w of graph.wires) {
      lines.push(`${indent}    ${rp(sc, w.from)} → ${rp(sc, w.to)}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function formatGraphText(defName: string, graph: Graph): string {
  return `def ${defName}\n` + fmtGraph(graph, "");
}
