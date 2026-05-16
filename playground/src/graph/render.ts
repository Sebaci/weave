/**
 * RenderedLayout → SVG string.
 *
 * Edges are drawn as cubic bezier curves from an output-port position
 * (right edge of source node) to an input-port position (left edge of
 * target node).  Ports are coloured by side (blue = input, green = output).
 */
import type { RenderedLayout, RenderedNode, PortPos } from "./layout.ts";

const PORT_R = 4;

const KIND_COLORS: Record<string, { fill: string; stroke: string; fg: string }> = {
  ref:    { fill: "#dbeafe", stroke: "#3b82f6", fg: "#1e40af" },
  tuple:  { fill: "#d1fae5", stroke: "#10b981", fg: "#065f46" },
  dup:    { fill: "#ede9fe", stroke: "#8b5cf6", fg: "#4c1d95" },
  const:  { fill: "#fef3c7", stroke: "#f59e0b", fg: "#78350f" },
  proj:   { fill: "#f1f5f9", stroke: "#94a3b8", fg: "#334155" },
  drop:   { fill: "#f1f5f9", stroke: "#94a3b8", fg: "#334155" },
  ctor:   { fill: "#fce7f3", stroke: "#ec4899", fg: "#831843" },
  case:   { fill: "#fee2e2", stroke: "#f87171", fg: "#7f1d1d" },
  cata:   { fill: "#fee2e2", stroke: "#f87171", fg: "#7f1d1d" },
  effect: { fill: "#fef2f2", stroke: "#dc2626", fg: "#7f1d1d" },
  source: { fill: "#1e293b", stroke: "#0f172a", fg: "#f8fafc" },
  sink:   { fill: "#1e293b", stroke: "#0f172a", fg: "#f8fafc" },
};

function color(kind: string) {
  return KIND_COLORS[kind] ?? { fill: "#f1f5f9", stroke: "#94a3b8", fg: "#334155" };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function f(n: number): string { return n.toFixed(1); }

function renderEdge(from: PortPos, to: PortPos): string {
  const dx = Math.max(50, Math.abs(to.x - from.x) * 0.45);
  const d  = `M ${f(from.x)} ${f(from.y)} C ${f(from.x + dx)} ${f(from.y)} ${f(to.x - dx)} ${f(to.y)} ${f(to.x)} ${f(to.y)}`;
  return `<path d="${d}" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/>`;
}

function renderPortCircle(pos: PortPos, side: "in" | "out"): string {
  const fill = side === "in" ? "#60a5fa" : "#34d399";
  return `<circle cx="${f(pos.x)}" cy="${f(pos.y)}" r="${PORT_R}" fill="${fill}" stroke="#fff" stroke-width="1.5"/>`;
}

function renderPortLabel(pos: PortPos, label: string, side: "in" | "out"): string {
  const x      = side === "in" ? pos.x + PORT_R + 3 : pos.x - PORT_R - 3;
  const anchor = side === "in" ? "start" : "end";
  return `<text x="${f(x)}" y="${f(pos.y)}" dominant-baseline="central" text-anchor="${anchor}" font-family="monospace" font-size="9" fill="#64748b">${esc(label)}</text>`;
}

function renderNode(
  n:          RenderedNode,
  outPortPos: Map<string, PortPos>,
  inPortPos:  Map<string, PortPos>,
): string {
  const { fill, stroke, fg } = color(n.kind);
  const rx = n.kind === "source" || n.kind === "sink" ? 14 : 6;
  const bx = n.x - n.width  / 2;
  const by = n.y - n.height / 2;

  const rect  = `<rect x="${f(bx)}" y="${f(by)}" width="${n.width}" height="${n.height}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  const label = `<text x="${f(n.x)}" y="${f(n.y)}" dominant-baseline="central" text-anchor="middle" font-family="monospace" font-size="11" fill="${fg}" font-weight="600">${esc(n.label)}</text>`;

  const circles = [
    ...n.inPorts.map(p => {
      const pos = inPortPos.get(p.portId);
      if (!pos) return "";
      return renderPortCircle(pos, "in") + (p.label ? renderPortLabel(pos, p.label, "in") : "");
    }),
    ...n.outPorts.map(p => {
      const pos = outPortPos.get(p.portId);
      if (!pos) return "";
      return renderPortCircle(pos, "out") + (p.label ? renderPortLabel(pos, p.label, "out") : "");
    }),
  ].join("");

  return `<g class="node" data-id="${n.id}" data-kind="${n.kind}">${rect}${label}${circles}</g>`;
}

export function renderGraphSVG(layout: RenderedLayout): string {
  const pad = 20;
  const vbW = layout.width  + pad * 2;
  const vbH = layout.height + pad * 2;

  const edges = layout.edges.map(e => {
    const from = layout.outPortPos.get(e.fromPortId);
    const to   = layout.inPortPos.get(e.toPortId);
    if (!from || !to) return "";
    return renderEdge(from, to);
  }).join("\n  ");

  const nodes = layout.nodes
    .map(n => renderNode(n, layout.outPortPos, layout.inPortPos))
    .join("\n  ");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     viewBox="${-pad} ${-pad} ${vbW} ${vbH}"`,
    `     style="width:100%;height:100%;display:block;background:#f8fafc">`,
    `  <g class="edges">${edges}</g>`,
    `  <g class="nodes">${nodes}</g>`,
    `</svg>`,
  ].join("\n");
}
