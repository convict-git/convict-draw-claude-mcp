// draw_diagram: Claude describes nodes, edges, and groups; the layout places them, and the result is
// drawn as ordinary elements inside a frame. The description is kept on the frame, so later calls can
// add, change, remove, or reveal parts by id. Every part keeps its place across reveals because the
// layout always includes every step.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { DiagramArgs, DiagramGroup } from "../../shared/protocol";
import { layoutDiagram, placeLabels, throughPoint, trimRoute, type Box, type Point, type Spec } from "./diagram-layout";
import { buildLegend, legendEntries } from "./diagram-legend";
import { edgeLook, EDGE_FONT, GROUP_FONT, groupLook, INK, lookOf, nodeLook, styleSignature } from "./diagram-style";
import { textSize } from "./measure";

type Api = ExcalidrawImperativeAPI;
type El = any;

export interface DiagramPlan {
  /** Elements for the draw command: new ones, updates to existing ones, deletes, and layer order. */
  elements: El[];
  frame: { x: number; y: number; width: number; height: number };
  /** Ids that become visible with this call, in the order they're explained. */
  revealed: string[];
  /** The order to draw new elements in: the title, then the parts as they're explained, then the legend. */
  drawOrder: string[];
  nodeCount: number;
  edgeCount: number;
  steps: { shown: number; total: number };
  warnings: string[];
}

const FRAME_PADDING = 40;
const LEGEND_GAP = 36;
const TITLE_FONT = 28;

export async function planDiagram(api: Api, args: DiagramArgs): Promise<DiagramPlan> {
  if (!args.id?.trim()) throw new Error("draw_diagram needs an id.");
  const id = args.id;
  const warnings: string[] = [];
  const scene = api.getSceneElements() as readonly El[];
  const frame = scene.find((e) => e.id === id && e.type === "frame");
  if (!frame && scene.some((e) => e.id === id)) throw new Error(`The id "${id}" is already used by another element. Pick a different diagram id.`);

  const spec = mergeSpec(frame?.customData?.spec, args, warnings);
  if (!spec.nodes.length) throw new Error("The diagram has no nodes. Pass nodes: [{id, label}, ...].");

  // Every part id must be free, or already belong to this diagram.
  const ownIds = new Set([id, ...spec.nodes.map((n) => n.id), ...spec.edges.map((e) => e.id), ...spec.groups.map((g) => g.id)]);
  const taken = scene.filter((e) => ownIds.has(e.id) && e.id !== id && e.customData?.diagram !== id).map((e) => e.id);
  if (taken.length) throw new Error(`These ids are already used by other elements on the board: ${taken.join(", ")}. Use different ids.`);

  const steps = stepsOf(spec);
  const total = Math.max(1, ...steps.values());
  const shown = spec.showStep === "all" ? total : Math.min(spec.showStep, total);
  const visible = (partId: string) => (steps.get(partId) ?? 1) <= shown;

  const look = lookOf(spec.look);
  const layout = await layoutDiagram(spec, look);
  const arrows = spec.layout === "mindmap" ? "curved" : spec.arrows;
  const entries = legendEntries(spec, look);

  // Where the frame goes: where it already is, or next to what's on the board.
  const others = scene.filter((e) => e.id !== id && e.customData?.diagram !== id && !e.containerId);
  let origin: Point = [0, 0];
  if (frame) origin = [frame.x, frame.y];
  else if (others.length) {
    const [minX, minY, maxX, maxY] = bounds(others);
    origin = args.placement === "below_existing" ? [minX, maxY + 120] : [maxX + 120, minY];
  }
  // A title inside the frame: Excalidraw's own frame name is small and gray.
  const titleHeight = spec.title ? textSize(spec.title, TITLE_FONT, look.font).height + 20 : 0;
  const ox = origin[0] + FRAME_PADDING;
  const oy = origin[1] + FRAME_PADDING + titleHeight;
  const legend = buildLegend(id, entries, ox, oy + layout.height + LEGEND_GAP, Math.max(layout.width, 520), look);
  const width = Math.round(Math.max(layout.width, legend.width) + FRAME_PADDING * 2);
  const height = Math.round(titleHeight + layout.height + (legend.height ? legend.height + LEGEND_GAP : 0) + FRAME_PADDING * 2);

  const existing = new Map(scene.filter((e) => e.customData?.diagram === id && !e.containerId).map((e) => [e.id, e]));
  const mentioned = new Set([...(args.nodes ?? []).map((n) => n.id), ...(args.groups ?? []).map((g) => g.id), ...(args.edges ?? []).map((e) => e.id ?? `${e.from}->${e.to}`)]);
  const restyleAll = Boolean(args.look || args.layout);
  const elements: El[] = [];
  const revealed: string[] = [];
  const tag = { diagram: id };

  /**
   * Add a part: created in full if it's new; otherwise moved into place, and restyled unless the user
   * has restyled it by hand since (Claude restyles it anyway when it passes that part again).
   */
  const emit = (partId: string, type: string, geometry: El, style: El, label?: { text: string; fontSize: number; style: El; align?: El }) => {
    const current = existing.get(partId);
    const signature = styleSignature({ ...current, ...style });
    if (!current) {
      elements.push({
        type,
        id: partId,
        ...geometry,
        ...style,
        frameId: id,
        ...(label ? { label: { text: label.text, fontSize: label.fontSize, ...label.style, ...label.align } } : {}),
        customData: { ...tag, style: signature },
      });
      revealed.push(partId);
      return;
    }
    const untouched = current.customData?.style === undefined || current.customData.style === styleSignature(current);
    const restyle = untouched || mentioned.has(partId) || restyleAll;
    elements.push({
      id: partId,
      ...geometry,
      ...(restyle ? { ...style, customData: { style: signature } } : {}),
      ...(label ? { label: { text: label.text, ...(restyle ? { fontSize: label.fontSize, ...label.style } : {}) } } : {}),
    });
  };

  elements.push({ type: "frame", id, name: spec.title ?? id, x: origin[0], y: origin[1], width, height, customData: { ...tag, spec } });
  if (spec.title) {
    const title = { x: ox, y: origin[1] + FRAME_PADDING - 8, text: spec.title };
    const titleId = `${id}__title`;
    if (existing.has(titleId)) elements.push({ id: titleId, ...title });
    else elements.push({ type: "text", id: titleId, ...title, fontSize: TITLE_FONT, fontFamily: look.font.family, strokeColor: INK, frameId: id, customData: tag });
  }

  // Outer groups first, so inner ones and nodes are drawn on top.
  const groupDepth = (g: DiagramGroup, seen = new Set<string>()): number => {
    const parent = g.parent && spec.groups.find((p) => p.id === g.parent);
    if (!parent || seen.has(g.id)) return 0;
    seen.add(g.id);
    return 1 + groupDepth(parent, seen);
  };
  const groups = [...spec.groups].sort((a, b) => groupDepth(a) - groupDepth(b));
  for (const group of groups) {
    const box = layout.boxes.get(group.id);
    if (!box || !visible(group.id)) continue;
    const { style, labelStyle } = groupLook(group, look);
    emit(group.id, "rectangle", at(box, ox, oy), style, { text: group.label, fontSize: GROUP_FONT, style: labelStyle, align: { textAlign: "left", verticalAlign: "top" } });
  }

  for (const node of spec.nodes) {
    const box = layout.boxes.get(node.id);
    if (!box || !visible(node.id)) continue;
    const { shape, fontSize, style, labelStyle } = nodeLook(node, look, layout.branches.get(node.id));
    if (existing.has(node.id) && existing.get(node.id).type !== shape) {
      warnings.push(`"${node.id}" keeps its shape: to give it a kind with another shape, remove it and add it with a new id`);
    }
    emit(node.id, existing.get(node.id)?.type ?? shape, at(box, ox, oy), style, { text: layout.texts.get(node.id) ?? node.label, fontSize, style: labelStyle });
  }

  const anchors = placeLabels(spec, layout, look, arrows);
  for (const edge of spec.edges) {
    const route = layout.routes.get(edge.id);
    if (!route || !visible(edge.id)) continue;
    const line = trimRoute(route.points, arrows);
    const anchor = anchors.get(edge.id);
    const points = (anchor ? throughPoint(line, anchor) : line).map(([x, y]) => [ox + x, oy + y] as Point);
    const [x0, y0] = points[0];
    const elbow = arrows === "elbow";
    const binding = (end: string, p: Point) => {
      const box = layout.boxes.get(end)!;
      // Elbow arrows attach at a fixed spot on each box, given as fractions of its size.
      return { elementId: end, ...(elbow ? { fixedPoint: [(p[0] - box.x) / (box.width || 1), (p[1] - box.y) / (box.height || 1)] } : {}) };
    };
    const geometry = {
      x: x0,
      y: y0,
      points: points.map(([x, y]) => [x - x0, y - y0]),
      elbowed: elbow,
      roundness: arrows === "curved" ? { type: 2 } : null,
      startBinding: binding(edge.from, route.points[0]),
      endBinding: binding(edge.to, route.points[route.points.length - 1]),
    };
    const { style, labelStyle } = edgeLook(edge, look, spec.layout === "mindmap" ? layout.branches.get(edge.id) : undefined);
    const text = layout.texts.get(edge.id);
    emit(edge.id, "arrow", geometry, style, text ? { text, fontSize: EDGE_FONT, style: labelStyle } : undefined);
  }

  for (const part of legend.elements) {
    if (!existing.has(part.id)) elements.push(part);
    else {
      const { type, frameId, groupIds, customData, ...fields } = part;
      elements.push(fields);
    }
  }

  // Parts removed from the diagram, or hidden again by a lower show_step.
  const drawn = new Set(elements.map((e) => e.id));
  const gone = [...existing.keys()].filter((key) => !drawn.has(key));
  if (gone.length) elements.push({ type: "delete", ids: gone.join(",") });
  // Filled group zones go behind everything else, outermost first.
  const zones = groups.filter((g) => drawn.has(g.id)).map((g) => g.id);
  if (zones.length) elements.push({ type: "order", ids: zones.join(","), to: "back" });

  // Explain in step order: within a step, a node and then the edges that just became visible.
  const order = new Map(explanationOrder(spec, steps).map((key, i) => [key, i]));
  const parts = revealed.filter((key) => order.has(key)).sort((a, b) => order.get(a)! - order.get(b)!);

  const drawOrder = [`${id}__title`, ...parts];
  return { elements, frame: { x: origin[0], y: origin[1], width, height }, revealed: parts, drawOrder, nodeCount: spec.nodes.length, edgeCount: spec.edges.length, steps: { shown, total }, warnings };
}

/** Ids of a diagram's parts in the order they're revealed, for animating it step by step. */
export function diagramOrder(frame: El): string[] {
  const spec = frame?.customData?.spec as Spec | undefined;
  return spec?.nodes ? explanationOrder(spec, stepsOf(spec)) : [];
}

/** How many of a diagram's steps are shown, for describing the board. */
export function diagramSteps(frame: El): { shown: number; total: number } | undefined {
  const spec = frame?.customData?.spec as Spec | undefined;
  if (!spec?.nodes) return undefined;
  const total = Math.max(1, ...stepsOf(spec).values());
  return { shown: spec.showStep === "all" ? total : Math.min(spec.showStep, total), total };
}

// ---------------------------------------------------------------------------
// The description: merging calls, and steps
// ---------------------------------------------------------------------------

function mergeSpec(previous: Spec | undefined, args: DiagramArgs, warnings: string[]): Spec {
  const spec: Spec = previous
    ? { ...structuredClone(previous), layout: previous.layout ?? "flow", look: previous.look ?? "sketch" }
    : { layout: "flow", direction: "right", arrows: "elbow", look: "sketch", nodes: [], edges: [], groups: [], showStep: "all" };
  for (const key of ["title", "layout", "direction", "arrows", "look", "legend"] as const) {
    if (args[key] !== undefined) (spec as any)[key] = args[key];
  }
  if (args.showStep !== undefined) spec.showStep = args.showStep;

  const upsert = <T extends { id: string }>(list: T[], item: T) => {
    const index = list.findIndex((existing) => existing.id === item.id);
    if (index < 0) list.push(item);
    else list[index] = { ...list[index], ...item };
  };
  for (const group of args.groups ?? []) upsert(spec.groups, group);
  for (const node of args.nodes ?? []) upsert(spec.nodes, node);
  const defaultIds = new Set<string>();
  for (const edge of args.edges ?? []) {
    let edgeId = edge.id ?? `${edge.from}->${edge.to}`;
    // Two edges between the same nodes in one call are two edges, not one edge updated twice.
    if (!edge.id) {
      for (let n = 2; defaultIds.has(edgeId); n++) edgeId = `${edge.from}->${edge.to}#${n}`;
      defaultIds.add(edgeId);
    }
    upsert(spec.edges, { ...edge, id: edgeId });
  }

  for (const removed of args.remove ?? []) {
    const group = spec.groups.find((g) => g.id === removed);
    if (group) {
      // Its contents move up to the enclosing group.
      for (const n of spec.nodes) if (n.group === removed) n.group = group.parent;
      for (const g of spec.groups) if (g.parent === removed) g.parent = group.parent;
    }
    const before = spec.nodes.length + spec.edges.length + spec.groups.length;
    spec.nodes = spec.nodes.filter((n) => n.id !== removed);
    spec.groups = spec.groups.filter((g) => g.id !== removed);
    spec.edges = spec.edges.filter((e) => e.id !== removed && e.from !== removed && e.to !== removed);
    if (before === spec.nodes.length + spec.edges.length + spec.groups.length) warnings.push(`remove: nothing called "${removed}" in this diagram`);
  }

  if (spec.layout === "mindmap" && spec.groups.length) {
    warnings.push("groups aren't drawn in a mind map; branches already group related ideas");
    spec.groups = [];
    for (const node of spec.nodes) node.group = undefined;
  }
  const nodeIds = new Set(spec.nodes.map((n) => n.id));
  const groupIds = new Set(spec.groups.map((g) => g.id));
  for (const id of nodeIds) if (groupIds.has(id)) throw new Error(`"${id}" is used as both a node id and a group id.`);
  for (const node of spec.nodes) {
    if (node.group && !groupIds.has(node.group)) {
      warnings.push(`node "${node.id}": no group "${node.group}", so it's outside any group`);
      node.group = undefined;
    }
  }
  for (const group of spec.groups) {
    if (group.parent && (!groupIds.has(group.parent) || insideOf(spec, group.parent, group.id))) {
      warnings.push(`group "${group.id}": parent "${group.parent}" ignored`);
      group.parent = undefined;
    }
  }
  spec.edges = spec.edges.filter((edge) => {
    const missing = [edge.from, edge.to].filter((end) => !nodeIds.has(end) && !groupIds.has(end));
    if (missing.length) warnings.push(`edge "${edge.id}" dropped: no node or group "${missing.join('", "')}"`);
    return !missing.length;
  });
  return spec;
}

/** Whether group `id` is `ancestor` or nested inside it. */
function insideOf(spec: Spec, id: string | undefined, ancestor: string): boolean {
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    if (id === ancestor) return true;
    seen.add(id);
    id = spec.groups.find((g) => g.id === id)?.parent;
  }
  return false;
}

/** The step at which each part appears. Groups appear with their first member; edges with their later end. */
function stepsOf(spec: Spec): Map<string, number> {
  const steps = new Map<string, number>();
  for (const node of spec.nodes) steps.set(node.id, Math.max(1, node.step ?? 1));
  const groupStep = (group: DiagramGroup): number => {
    if (group.step) return Math.max(1, group.step);
    const members = [
      ...spec.nodes.filter((n) => n.group === group.id).map((n) => steps.get(n.id)!),
      ...spec.groups.filter((g) => g.parent === group.id).map(groupStep),
    ];
    return members.length ? Math.min(...members) : 1;
  };
  for (const group of spec.groups) steps.set(group.id, groupStep(group));
  for (const edge of spec.edges) {
    steps.set(edge.id, Math.max(edge.step ?? 1, steps.get(edge.from) ?? 1, steps.get(edge.to) ?? 1));
  }
  return steps;
}

function explanationOrder(spec: Spec, steps: Map<string, number>): string[] {
  const order: string[] = [];
  const placed = new Set<string>();
  const total = Math.max(1, ...steps.values());
  for (let step = 1; step <= total; step++) {
    for (const group of spec.groups) if (steps.get(group.id) === step) order.push(group.id);
    for (const node of spec.nodes) {
      if (steps.get(node.id) !== step) continue;
      order.push(node.id);
      placed.add(node.id);
      // Edges into this node, once both ends are on the board.
      for (const edge of spec.edges) {
        if (steps.get(edge.id) === step && (edge.to === node.id || edge.from === node.id) && placed.has(edge.from) && placed.has(edge.to)) order.push(edge.id);
      }
    }
    for (const edge of spec.edges) if (steps.get(edge.id) === step && !order.includes(edge.id)) order.push(edge.id);
  }
  return order;
}

function at(box: Box, ox: number, oy: number) {
  return { x: ox + box.x, y: oy + box.y, width: box.width, height: box.height };
}

function bounds(elements: readonly El[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    minX = Math.min(minX, e.x);
    minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + e.width);
    maxY = Math.max(maxY, e.y + e.height);
  }
  return [minX, minY, maxX, maxY];
}
