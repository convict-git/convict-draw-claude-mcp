// A diagram's legend: one sample per style the diagram uses (kinds, statuses, line styles, arrowheads,
// and any colors Claude gave a meaning), each with a short explanation.
import type { Arrowhead, LineStyle, NamedColor, NodeKind, Status } from "../../shared/protocol";
import type { Spec } from "./diagram-layout";
import { edgeLook, HEAD_MEANING, INK, KINDS, LINE_MEANING, nodeLook, PALETTE, STATUS_MEANING, type Look } from "./diagram-style";
import { textWidth } from "./measure";

type El = any;

interface Entry {
  key: string;
  text: string;
  sample: El;
}

const SAMPLE_W = 44;
const SAMPLE_H = 26;
const FONT = 16;
const ROW = 36;
const PAD = 16;

export function legendEntries(spec: Spec, look: Look): Entry[] {
  if (!spec.legend) return [];
  const custom = typeof spec.legend === "object" ? spec.legend : {};
  const entries = new Map<string, Entry>();
  const add = (key: string, fallback: string | undefined, sample: El) => {
    const text = custom[key] ?? fallback;
    if (text && !entries.has(key)) entries.set(key, { key, text, sample });
  };
  const box = (style: Record<string, unknown>, shape = "rectangle") => ({ type: shape, ...style });
  const line = (style: Record<string, unknown>) => ({ type: "arrow", ...style });

  const kinds = new Set(spec.nodes.map((n) => n.kind ?? (spec.layout === "mindmap" ? undefined : "service")).filter(Boolean) as NodeKind[]);
  if (kinds.size > 1 || spec.layout === "mindmap") {
    for (const kind of kinds) {
      const { shape, style } = nodeLook({ id: "", label: "", kind }, look);
      add(kind, KINDS[kind].meaning, box(style, shape));
    }
  }
  const statuses = new Set([...spec.nodes, ...spec.edges].map((part) => part.status).filter(Boolean) as Status[]);
  for (const status of statuses) add(status, STATUS_MEANING[status], box(nodeLook({ id: "", label: "", status }, look).style));
  const lines = new Set(spec.edges.map((e) => e.line ?? "solid"));
  // In a mind map, solid lines are just branches.
  if (spec.layout === "mindmap") lines.delete("solid");
  if ([...lines].some((l) => l !== "solid")) {
    for (const style of ["solid", "dashed", "dotted"] as LineStyle[]) {
      if (lines.has(style)) add(style, LINE_MEANING[style], line(edgeLook({ from: "", to: "", line: style }, look).style));
    }
  }
  for (const head of new Set(spec.edges.flatMap((e) => [e.head, e.tail]).filter((h) => h && h !== "arrow" && h !== "none") as Arrowhead[])) {
    add(head, HEAD_MEANING[head], line(edgeLook({ from: "", to: "", head }, look).style));
  }
  // Anything else Claude named: a color, or a style this diagram doesn't use yet.
  for (const [key, text] of Object.entries(custom)) {
    if (entries.has(key)) continue;
    if (key in PALETTE) add(key, text, box({ backgroundColor: PALETTE[key as NamedColor].fill, strokeColor: INK, roughness: look.roughness }));
    else if (key in KINDS) add(key, text, box(nodeLook({ id: "", label: "", kind: key as NodeKind }, look).style, KINDS[key as NodeKind].shape));
    else if (key in STATUS_MEANING) add(key, text, box(nodeLook({ id: "", label: "", status: key as Status }, look).style));
    else if (key in LINE_MEANING) add(key, text, line(edgeLook({ from: "", to: "", line: key as LineStyle }, look).style));
    else add(key, text, line(edgeLook({ from: "", to: "", head: key as Arrowhead }, look).style));
  }
  return [...entries.values()];
}

/** Legend elements laid out in rows no wider than `maxWidth`, with the top left at (x, y). */
export function buildLegend(diagramId: string, entries: Entry[], x: number, y: number, maxWidth: number, look: Look) {
  if (!entries.length) return { elements: [] as El[], width: 0, height: 0 };
  const group = `${diagramId}__legend`;
  const common = { frameId: diagramId, groupIds: [group], customData: { diagram: diagramId, legend: true } };
  const items: El[] = [];
  let cx = x + PAD;
  let cy = y + PAD + 28;
  let right = x + PAD + textWidth("Legend", FONT, look.font);
  for (const entry of entries) {
    const width = SAMPLE_W + 10 + textWidth(entry.text, FONT, look.font);
    if (cx > x + PAD && cx + width > x + maxWidth - PAD) {
      cx = x + PAD;
      cy += ROW;
    }
    const id = `${group}_${entry.key}`;
    const { type, ...style } = entry.sample;
    if (type === "arrow") {
      items.push({ type, id, x: cx, y: cy + SAMPLE_H / 2, points: [[0, 0], [SAMPLE_W, 0]], ...style, ...common });
    } else {
      items.push({ type, id, x: cx, y: cy, width: SAMPLE_W, height: SAMPLE_H, ...style, ...common });
    }
    items.push({ type: "text", id: `${id}_text`, x: cx + SAMPLE_W + 10, y: cy + SAMPLE_H / 2 - (FONT * look.font.lineHeight) / 2, text: entry.text, fontSize: FONT, fontFamily: look.font.family, strokeColor: "#495057", ...common });
    right = Math.max(right, cx + width);
    cx += width + 28;
  }
  const width = right - x + PAD;
  const height = cy + SAMPLE_H + PAD - y;
  const frame = { type: "rectangle", id: group, x, y, width, height, backgroundColor: "#f8f9fa", fillStyle: "solid", strokeColor: "#ced4da", strokeWidth: 1, roundness: { type: 3 }, roughness: look.roughness, ...common };
  const title = { type: "text", id: `${group}_title`, x: x + PAD, y: y + 10, text: "Legend", fontSize: FONT, fontFamily: look.font.family, strokeColor: "#495057", ...common };
  // The box first, so the samples are drawn on top of it.
  return { elements: [frame, title, ...items], width, height };
}
