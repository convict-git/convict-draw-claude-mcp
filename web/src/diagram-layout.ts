// Where draw_diagram puts things. A flow is laid out by ELK (layered, with arrows routed around boxes
// and room left for arrow labels). A mind map is laid out here: the first node in the middle, its
// branches split to the left and right, and each branch's children stacked beside it.
import type { DiagramEdge, DiagramGroup, DiagramNode } from "../../shared/protocol";
import { BRANCH_COLORS, EDGE_FONT, GROUP_FONT, nodeLook, type Branch, type Look, type Shape } from "./diagram-style";
import { textSize, wrapText } from "./measure";

type El = any;
export type Point = [number, number];
type Rect = [number, number, number, number];
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A diagram's description, as kept on its frame. */
export interface Spec {
  title?: string;
  layout: "flow" | "mindmap";
  direction: "right" | "down";
  arrows: "elbow" | "curved" | "straight";
  look: "sketch" | "clean";
  legend?: boolean | Record<string, string>;
  nodes: DiagramNode[];
  edges: (DiagramEdge & { id: string })[];
  groups: DiagramGroup[];
  showStep: number | "all";
}

export interface Layout {
  width: number;
  height: number;
  boxes: Map<string, Box>;
  routes: Map<string, { points: Point[]; labelAt?: Point }>;
  /** Labels as drawn, with line breaks. */
  texts: Map<string, string>;
  /** Mind map depth and branch color of each node and edge. */
  branches: Map<string, Branch>;
  shapes: Map<string, Shape>;
}

const ARROW_GAP = 4;
/** How much arrow must show on each side of its label. Excalidraw hides the arrow under the label, so a label longer than its arrow leaves only the text. */
export const LABEL_CLEARANCE = 24;
const SPACING = {
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
  "elk.spacing.edgeNode": "24",
  "elk.spacing.edgeEdge": "24",
  "elk.layered.spacing.edgeNodeBetweenLayers": "32",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
  "elk.spacing.edgeLabel": "6",
  "elk.edgeLabels.inline": "true",
};
/** Wrap a flow whose main direction is more than this many times its other side. */
const MAX_STRETCH = 3;
const SCREEN_ASPECT = 1.6;

export async function layoutDiagram(spec: Spec, look: Look): Promise<Layout> {
  const tree = spec.layout === "mindmap" ? mindmapTree(spec) : undefined;
  const branches = tree?.branches ?? new Map<string, Branch>();
  const texts = new Map<string, string>();
  const sizes = new Map<string, { width: number; height: number }>();
  const shapes = new Map<string, Shape>();

  for (const node of spec.nodes) {
    const { shape, fontSize } = nodeLook(node, look, branches.get(node.id));
    const maxWidth = shape === "diamond" ? fontSize * 7 : shape === "ellipse" ? fontSize * 9 : fontSize * 11;
    const text = wrapText(node.label, fontSize, maxWidth, look.font);
    texts.set(node.id, text);
    sizes.set(node.id, nodeSize(shape, textSize(text, fontSize, look.font), fontSize));
    shapes.set(node.id, shape);
  }
  for (const edge of spec.edges) {
    // Arrow labels wider than about 170px wrap in Excalidraw, so wrap them here and reserve their real size.
    if (edge.label?.trim()) texts.set(edge.id, wrapText(edge.label, EDGE_FONT, 150, look.font));
  }

  if (tree) return { ...mindmapLayout(spec, sizes, shapes, tree, texts, look), texts, branches, shapes };

  // Labels get room from the layout, but an arrow whose label still covers it (a bend next to the label, an
  // arrow between neighbors in one layer) gets more space and another try.
  const extra = { along: 0, across: 0 };
  let layout!: Layout;
  for (let attempt = 0; attempt < 3; attempt++) {
    layout = { ...(await flowLayout(spec, sizes, texts, look, extra)), texts, branches, shapes };
    const short = labelShortfall(spec, layout, look);
    if (!short.along && !short.across) break;
    extra.along = Math.min(extra.along + short.along, 400);
    extra.across = Math.min(extra.across + short.across, 400);
  }
  return layout;
}

// ---------------------------------------------------------------------------
// Flow: ELK layered layout
// ---------------------------------------------------------------------------

let elkInstance: Promise<any> | null = null;

function elk() {
  // Loaded on first use, so the board page doesn't pay for it up front.
  elkInstance ??= import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
  return elkInstance;
}

async function flowLayout(
  spec: Spec,
  sizes: Map<string, { width: number; height: number }>,
  texts: Map<string, string>,
  look: Look,
  extra: { along: number; across: number },
) {
  const spacing: Record<string, string> = {
    ...SPACING,
    "elk.spacing.nodeNode": String(40 + extra.across),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(60 + extra.along),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(32 + extra.along / 2),
  };
  const elkNodes = new Map<string, El>();
  for (const node of spec.nodes) elkNodes.set(node.id, { id: node.id, ...sizes.get(node.id) });
  for (const group of spec.groups) {
    const title = textSize(group.label, GROUP_FONT, look.font);
    elkNodes.set(group.id, {
      id: group.id,
      children: [],
      layoutOptions: {
        "elk.padding": `[top=${Math.ceil(title.height + 24)},left=20,bottom=20,right=20]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${Math.ceil(title.width + 40)},40)`,
        // ELK doesn't pass spacing down to a group's contents.
        ...spacing,
      },
    });
  }

  const root: El = {
    id: "__root__",
    children: [],
    edges: [],
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": spec.direction === "down" ? "DOWN" : "RIGHT",
      "elk.edgeRouting": spec.arrows === "elbow" ? "ORTHOGONAL" : "POLYLINE",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.edgeCoords": "ROOT",
      "elk.json.shapeCoords": "ROOT",
      // Claude lists things in the order it explains them; keep that order where the layout allows.
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      ...spacing,
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
  };
  for (const group of spec.groups) (group.parent ? elkNodes.get(group.parent) : root).children.push(elkNodes.get(group.id));
  for (const node of spec.nodes) (node.group ? elkNodes.get(node.group) : root).children.push(elkNodes.get(node.id));
  const backEdges = loopClosingEdges(spec);
  for (const edge of spec.edges) {
    // An edge that closes a loop is laid out reversed, so the flow reads from the first-listed node.
    const back = backEdges.has(edge.id);
    const elkEdge: El = { id: edge.id, sources: [back ? edge.to : edge.from], targets: [back ? edge.from : edge.to] };
    const text = texts.get(edge.id);
    if (text) {
      const size = textSize(text, EDGE_FONT, look.font);
      // Reserve arrow on both sides of the label along the flow, so the arrow still shows around it.
      const clearance = 2 * (LABEL_CLEARANCE + ARROW_GAP);
      const down = spec.direction === "down";
      elkEdge.labels = [{ id: `${edge.id}:label`, text, width: Math.ceil(size.width + 16 + (down ? 0 : clearance)), height: Math.ceil(size.height + 8 + (down ? clearance : 0)) }];
    }
    root.edges.push(elkEdge);
  }

  // ELK fills in positions on the graph it's given, so lay out copies.
  const engine = await elk();
  let result = await engine.layout(structuredClone(root));
  // A long flow in one row or column doesn't fit a screen: wrap it into rows (or columns) if that's more compact.
  const stretch = spec.direction === "down" ? result.height / result.width : result.width / result.height;
  if (stretch > MAX_STRETCH && longestChain(spec) >= 6) {
    const wrapped = structuredClone(root);
    Object.assign(wrapped.layoutOptions, { "elk.layered.wrapping.strategy": "MULTI_EDGE", "elk.aspectRatio": String(SCREEN_ASPECT) });
    const candidate = await engine.layout(wrapped);
    // ELK sometimes cuts routes short when wrapping around groups; only use a wrapped layout whose arrows all connect.
    if (routesConnect(candidate)) result = candidate;
  }

  const boxes = new Map<string, Box>();
  const visit = (node: El) => {
    for (const child of node.children ?? []) {
      boxes.set(child.id, { x: Math.round(child.x), y: Math.round(child.y), width: Math.round(child.width), height: Math.round(child.height) });
      visit(child);
    }
  };
  visit(result);

  const routes = new Map<string, { points: Point[]; labelAt?: Point }>();
  const collect = (node: El) => {
    for (const edge of node.edges ?? []) {
      const points = edgePath(edge.sections ?? []);
      if (points.length < 2) continue;
      if (backEdges.has(edge.id)) points.reverse();
      const label = edge.labels?.[0];
      routes.set(edge.id, { points, labelAt: label ? [label.x + label.width / 2, label.y + label.height / 2] : undefined });
    }
    for (const child of node.children ?? []) collect(child);
  };
  collect(result);

  return { width: result.width, height: result.height, boxes, routes };
}

/** Edges that point back to a node already on the current path, walking from nodes in the order listed. */
function loopClosingEdges(spec: Spec): Set<string> {
  const out = new Map<string, Spec["edges"]>();
  for (const edge of spec.edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
  const back = new Set<string>();
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    onPath.add(id);
    for (const edge of out.get(id) ?? []) {
      if (onPath.has(edge.to)) back.add(edge.id);
      else visit(edge.to);
    }
    onPath.delete(id);
    done.add(id);
  };
  for (const id of [...spec.nodes.map((n) => n.id), ...spec.groups.map((g) => g.id)]) visit(id);
  return back;
}

/** Nodes on the longest path through the diagram, ignoring edges that close a cycle. */
function longestChain(spec: Spec): number {
  const next = new Map<string, string[]>();
  for (const edge of spec.edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const memo = new Map<string, number>();
  const onPath = new Set<string>();
  const depth = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    onPath.add(id);
    let longest = 0;
    for (const to of next.get(id) ?? []) if (!onPath.has(to)) longest = Math.max(longest, depth(to));
    onPath.delete(id);
    memo.set(id, longest + 1);
    return longest + 1;
  };
  return Math.max(0, ...spec.nodes.map((n) => depth(n.id)));
}

function routesConnect(graph: El): boolean {
  const boxes = new Map<string, El>();
  const edges: El[] = [];
  const visit = (node: El) => {
    edges.push(...(node.edges ?? []));
    for (const child of node.children ?? []) {
      boxes.set(child.id, child);
      visit(child);
    }
  };
  visit(graph);
  const touches = ([x, y]: Point, box: El) =>
    box && x >= box.x - 2 && x <= box.x + box.width + 2 && y >= box.y - 2 && y <= box.y + box.height + 2;
  return edges.every((edge) => {
    const points = edgePath(edge.sections ?? []);
    return points.length >= 2 && touches(points[0], boxes.get(edge.sources[0])) && touches(points[points.length - 1], boxes.get(edge.targets[0]));
  });
}

/** An edge's route. Wrapping splits an edge into sections chained by their ids; join them in order. */
function edgePath(sections: El[]): Point[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  let section = sections.find((candidate) => !candidate.incomingSections?.length) ?? sections[0];
  const points: Point[] = [];
  const seen = new Set<string>();
  while (section && !seen.has(section.id)) {
    seen.add(section.id);
    for (const p of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
      const last = points[points.length - 1];
      if (!last || last[0] !== p.x || last[1] !== p.y) points.push([p.x, p.y]);
    }
    section = byId.get(section.outgoingSections?.[0]);
  }
  return points;
}

// ---------------------------------------------------------------------------
// Mind map
// ---------------------------------------------------------------------------

interface Tree {
  root: string;
  children: Map<string, string[]>;
  /** Edges that form the tree; the rest are cross-links. */
  treeEdges: Set<string>;
  branches: Map<string, Branch>;
}

/** The first node is the center. Edges (in either direction) connect each node to the one it branches from. */
function mindmapTree(spec: Spec): Tree {
  const root = spec.nodes[0]?.id;
  const ids = new Set(spec.nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  const treeEdges = new Set<string>();
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of spec.edges) {
      const other = edge.from === id ? edge.to : edge.to === id ? edge.from : undefined;
      if (!other || !ids.has(other) || seen.has(other)) continue;
      seen.add(other);
      children.set(id, [...(children.get(id) ?? []), other]);
      treeEdges.add(edge.id);
      queue.push(other);
    }
  }
  // Nodes nothing connects to still belong to the map: hang them off the center.
  for (const node of spec.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    children.set(root, [...(children.get(root) ?? []), node.id]);
  }

  const branches = new Map<string, Branch>();
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const assign = (id: string, depth: number, color: Branch["color"]) => {
    branches.set(id, { depth, color });
    for (const child of children.get(id) ?? []) assign(child, depth + 1, depth === 0 ? byId.get(child)?.color ?? color : color);
  };
  branches.set(root, { depth: 0, color: byId.get(root)?.color ?? "yellow" });
  (children.get(root) ?? []).forEach((child, i) => assign(child, 1, byId.get(child)?.color ?? BRANCH_COLORS[i % BRANCH_COLORS.length]));
  // An edge takes the branch of the end farther from the center.
  for (const edge of spec.edges) {
    const a = branches.get(edge.from);
    const b = branches.get(edge.to);
    const deeper = a && b ? (a.depth >= b.depth ? a : b) : a ?? b;
    if (deeper) branches.set(edge.id, deeper);
  }
  return { root, children, treeEdges, branches };
}

function mindmapLayout(
  spec: Spec,
  sizes: Map<string, { width: number; height: number }>,
  shapes: Map<string, Shape>,
  tree: Tree,
  texts: Map<string, string>,
  look: Look,
) {
  const siblingGap = (depth: number) => (depth === 0 ? 36 : depth === 1 ? 20 : 10);
  // A labeled branch needs to be long enough to show around its label.
  const labelWidth = (a: string, b: string) => {
    const edge = spec.edges.find((e) => tree.treeEdges.has(e.id) && ((e.from === a && e.to === b) || (e.from === b && e.to === a)));
    const text = edge && texts.get(edge.id);
    return text ? textSize(text, EDGE_FONT, look.font).width : 0;
  };
  const branchGap = (parent: string, list: string[]) => {
    const base = depthOf(parent) === 0 ? 100 : 60;
    const widest = Math.max(0, ...list.map((k) => labelWidth(parent, k)));
    return widest ? Math.max(base, Math.ceil(widest + 2 * (LABEL_CLEARANCE + ARROW_GAP) + 8)) : base;
  };
  const depthOf = (id: string) => tree.branches.get(id)?.depth ?? 0;
  const kids = (id: string) => tree.children.get(id) ?? [];

  const heights = new Map<string, number>();
  const heightOf = (id: string): number => {
    if (heights.has(id)) return heights.get(id)!;
    const list = kids(id);
    const stacked = list.reduce((sum, k) => sum + heightOf(k), 0) + siblingGap(depthOf(id)) * Math.max(0, list.length - 1);
    const h = Math.max(sizes.get(id)!.height, stacked);
    heights.set(id, h);
    return h;
  };

  const boxes = new Map<string, Box>();
  const rootSize = sizes.get(tree.root)!;
  boxes.set(tree.root, { x: -rootSize.width / 2, y: -rootSize.height / 2, ...rootSize });

  // Split the main branches between the two sides, keeping them about the same height.
  const right: string[] = [];
  const left: string[] = [];
  let rightHeight = 0;
  let leftHeight = 0;
  for (const k of kids(tree.root)) {
    if (rightHeight <= leftHeight) {
      right.push(k);
      rightHeight += heightOf(k);
    } else {
      left.push(k);
      leftHeight += heightOf(k);
    }
  }

  const place = (parent: string, list: string[], side: 1 | -1) => {
    const p = boxes.get(parent)!;
    const gap = siblingGap(depthOf(parent));
    const reach = branchGap(parent, list);
    const total = list.reduce((sum, k) => sum + heightOf(k), 0) + gap * Math.max(0, list.length - 1);
    let cursor = p.y + p.height / 2 - total / 2;
    for (const k of list) {
      const size = sizes.get(k)!;
      const h = heightOf(k);
      const x = side > 0 ? p.x + p.width + reach : p.x - reach - size.width;
      boxes.set(k, { x, y: cursor + h / 2 - size.height / 2, ...size });
      place(k, kids(k), side);
      cursor += h + gap;
    }
  };
  place(tree.root, right, 1);
  place(tree.root, left, -1);

  const routes = new Map<string, { points: Point[] }>();
  for (const edge of spec.edges) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) continue;
    if (tree.treeEdges.has(edge.id)) {
      // A smooth S-curve from the side of one box to the facing side of the other.
      const ca = center(a);
      const cb = center(b);
      const start = sidePoint(a, shapes.get(edge.from), cb);
      const end = sidePoint(b, shapes.get(edge.to), ca);
      const dx = end[0] - start[0];
      routes.set(edge.id, { points: [start, [start[0] + dx / 3, start[1]], [start[0] + (2 * dx) / 3, end[1]], end] });
    } else {
      // A cross-link bows away from the straight line; pick the bend that crosses the fewest boxes.
      const start = borderPoint(a, center(b));
      const end = borderPoint(b, center(a));
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]) || 1;
      const obstacles = [...boxes].filter(([id]) => id !== edge.from && id !== edge.to).map(([, box]) => box);
      let best: { points: Point[]; hits: number } | undefined;
      for (const bow of [0.15, -0.15, 0.35, -0.35, 0]) {
        const mid: Point = [(start[0] + end[0]) / 2 - ((end[1] - start[1]) / length) * bow * length, (start[1] + end[1]) / 2 + ((end[0] - start[0]) / length) * bow * length];
        const points = [start, mid, end];
        const hits = obstacles.filter((box) => points.slice(1).some((q, i) => segmentCrossesRect(points[i], q, [box.x, box.y, box.x + box.width, box.y + box.height]))).length;
        if (!best || hits < best.hits) best = { points, hits };
      }
      routes.set(edge.id, { points: best!.points });
    }
  }

  // Move everything so the top left is at (0, 0).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  // Cross-links can bow outside the boxes; keep them (and room for a label) inside the frame.
  for (const route of routes.values()) {
    for (const [x, y] of route.points) {
      minX = Math.min(minX, x - 30);
      minY = Math.min(minY, y - 20);
      maxX = Math.max(maxX, x + 30);
      maxY = Math.max(maxY, y + 20);
    }
  }
  for (const [id, b] of boxes) boxes.set(id, { ...b, x: Math.round(b.x - minX), y: Math.round(b.y - minY) });
  for (const route of routes.values()) route.points = route.points.map(([x, y]) => [x - minX, y - minY]);
  return { width: maxX - minX, height: maxY - minY, boxes, routes };
}

/** Where a branch leaves a box toward `toward`: the middle of the facing side, or the edge of an ellipse. */
function sidePoint(box: Box, shape: Shape | undefined, toward: Point): Point {
  const [cx, cy] = center(box);
  if (shape === "ellipse") {
    const angle = Math.atan2((toward[1] - cy) / (box.height / 2), (toward[0] - cx) / (box.width / 2));
    return [cx + Math.cos(angle) * (box.width / 2), cy + Math.sin(angle) * (box.height / 2)];
  }
  return [toward[0] >= cx ? box.x + box.width : box.x, cy];
}

/** Where the line from a box's center toward `toward` leaves the box. */
function borderPoint(box: Box, toward: Point): Point {
  const [cx, cy] = center(box);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (!dx && !dy) return [cx, cy];
  const scale = Math.min(dx ? box.width / 2 / Math.abs(dx) : Infinity, dy ? box.height / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * scale, cy + dy * scale];
}

function center(box: Box): Point {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/** A box that fits the label inside the shape's text area (Excalidraw wraps text that doesn't fit). */
function nodeSize(shape: Shape, text: { width: number; height: number }, fontSize: number) {
  const w = text.width + 8;
  const h = text.height;
  switch (shape) {
    case "ellipse":
      return { width: Math.max(fontSize * 6, Math.ceil((w + 16) * Math.SQRT2 + 8)), height: Math.max(fontSize * 3, Math.ceil((h + 12) * Math.SQRT2 + 4)) };
    case "diamond":
      return { width: Math.max(fontSize * 6.5, Math.ceil(2 * (w + 12) + 8)), height: Math.max(fontSize * 4, Math.ceil(2 * (h + 12))) };
    default:
      return { width: Math.max(fontSize * 4, Math.ceil(w + fontSize * 1.4)), height: Math.max(fontSize * 2.4, Math.ceil(h + fontSize * 1.2)) };
  }
}

// ---------------------------------------------------------------------------
// Arrows and their labels
// ---------------------------------------------------------------------------

/** The arrow's path with a small gap from each box (and only its ends, for straight arrows). */
export function trimRoute(route: Point[], arrows: Spec["arrows"]): Point[] {
  let points = route.map((p) => [...p] as Point);
  if (arrows === "straight") points = [points[0], points[points.length - 1]];
  shorten(points, 0, 1);
  shorten(points, points.length - 1, points.length - 2);
  return points;
}

/**
 * Where each arrow label goes. Excalidraw centers a label on its arrow, so slide it along the arrow to
 * the first spot that covers no box, group title, or other label (and preferably no other arrow).
 * Labels are placed for every step at once, so they don't move as later steps are revealed.
 */
export function placeLabels(spec: Spec, layout: Layout, look: Look, arrows: Spec["arrows"]): Map<string, Point> {
  const pad = 4;
  const boxes: Rect[] = [];
  const borders: Rect[] = [];
  for (const node of spec.nodes) {
    const b = layout.boxes.get(node.id);
    if (b) boxes.push([b.x - pad, b.y - pad, b.x + b.width + pad, b.y + b.height + pad]);
  }
  for (const group of spec.groups) {
    const b = layout.boxes.get(group.id);
    if (!b) continue;
    const title = textSize(group.label, GROUP_FONT, look.font);
    boxes.push([b.x, b.y, b.x + title.width + 10 + pad, b.y + title.height + 5 + pad]);
    borders.push([b.x, b.y, b.x + b.width, b.y + b.height]);
  }
  const lines = new Map([...layout.routes].map(([id, route]) => [id, trimRoute(route.points, arrows)]));
  const placed: Rect[] = [];
  const anchors = new Map<string, Point>();

  for (const edge of spec.edges) {
    const text = layout.texts.get(edge.id);
    const line = lines.get(edge.id);
    if (!text || !line) continue;
    const size = textSize(text, EDGE_FONT, look.font);
    const rectAt = ([x, y]: Point): Rect => [x - size.width / 2 - pad, y - size.height / 2 - pad, x + size.width / 2 + pad, y + size.height / 2 + pad];
    const otherLines = [...lines].filter(([id]) => id !== edge.id).map(([, points]) => points);
    // A label may sit inside or outside a group, but not on its border.
    const onBorder = (r: Rect) => borders.some((b) => overlaps(r, b) && !(r[0] >= b[0] && r[1] >= b[1] && r[2] <= b[2] && r[3] <= b[3]));
    const free = (r: Rect) => !boxes.some((b) => overlaps(r, b)) && !placed.some((p) => overlaps(r, p)) && !onBorder(r);
    const clear = (r: Rect) => !otherLines.some((points) => points.slice(1).some((q, i) => segmentCrossesRect(points[i], q, r)));

    const shows = (c: Point) => arrowShows(line, rectAt(c));
    const candidates = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88].map((t) => pointAlong(line, t));
    // The middle of the longest straight run is the likeliest spot to leave the arrow visible.
    candidates.push(segmentMiddle(line, longestSegment(line)));
    const labelAt = layout.routes.get(edge.id)?.labelAt;
    if (labelAt) candidates.unshift(closestOnPath(line, labelAt));
    const anchor =
      candidates.find((c) => free(rectAt(c)) && clear(rectAt(c)) && shows(c)) ??
      candidates.find((c) => free(rectAt(c)) && shows(c)) ??
      candidates.find((c) => free(rectAt(c)) && clear(rectAt(c))) ??
      candidates.find((c) => free(rectAt(c))) ??
      candidates[0];
    anchors.set(edge.id, anchor);
    placed.push(rectAt(anchor));
  }
  return anchors;
}

/**
 * How much more room the flow needs so every arrow shows around its label: extra length along the flow
 * (between layers) and across it (between neighbors in a layer).
 */
function labelShortfall(spec: Spec, layout: Layout, look: Look): { along: number; across: number } {
  const anchors = placeLabels(spec, layout, look, spec.arrows);
  const short = { along: 0, across: 0 };
  for (const edge of spec.edges) {
    const text = layout.texts.get(edge.id);
    const route = layout.routes.get(edge.id);
    const anchor = anchors.get(edge.id);
    if (!text || !route || !anchor) continue;
    const line = trimRoute(route.points, spec.arrows);
    const size = textSize(text, EDGE_FONT, look.font);
    const rect: Rect = [anchor[0] - size.width / 2, anchor[1] - size.height / 2, anchor[0] + size.width / 2, anchor[1] + size.height / 2];
    if (arrowShows(line, rect)) continue;
    const i = longestSegment(line);
    const [dx, dy] = [line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]];
    const length = Math.hypot(dx, dy) || 1;
    const covered = (Math.abs(dx) * size.width + Math.abs(dy) * size.height) / length;
    const missing = Math.ceil(covered + 2 * LABEL_CLEARANCE + 8 - length);
    if (missing <= 0) continue;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const alongFlow = horizontal === (spec.direction !== "down");
    if (alongFlow) short.along = Math.max(short.along, missing);
    else short.across = Math.max(short.across, missing);
  }
  return short;
}

/** Whether enough of the arrow shows before and after its label (Excalidraw cuts the arrow out around the label). */
export function arrowShows(points: Point[], [minX, minY, maxX, maxY]: Rect, clearance = LABEL_CLEARANCE): boolean {
  const cut: Rect = [minX - 4, minY - 4, maxX + 4, maxY + 4];
  let travelled = 0;
  let firstIn = -1;
  let lastIn = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const length = segmentLength(points, i);
    const steps = Math.max(1, Math.ceil(length / 2));
    for (let s = 0; s <= steps; s++) {
      const x = points[i][0] + ((points[i + 1][0] - points[i][0]) * s) / steps;
      const y = points[i][1] + ((points[i + 1][1] - points[i][1]) * s) / steps;
      if (x > cut[0] && x < cut[2] && y > cut[1] && y < cut[3]) {
        const at = travelled + (length * s) / steps;
        if (firstIn < 0) firstIn = at;
        lastIn = at;
      }
    }
    travelled += length;
  }
  if (firstIn < 0) return true;
  return firstIn >= clearance && travelled - lastIn >= clearance;
}

function longestSegment(points: Point[]): number {
  let longest = 0;
  for (let i = 1; i < points.length - 1; i++) if (segmentLength(points, i) > segmentLength(points, longest)) longest = i;
  return longest;
}

function segmentMiddle(points: Point[], i: number): Point {
  return [(points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2];
}

/** Insert `anchor` into the path, in the middle of the point list, since that's where Excalidraw puts an arrow's label. */
export function throughPoint(points: Point[], anchor: Point): Point[] {
  let best = { index: 0, distance: Infinity };
  for (let i = 0; i < points.length - 1; i++) {
    const [x, y] = closestOnSegment(anchor, points[i], points[i + 1]);
    const distance = Math.hypot(x - anchor[0], y - anchor[1]);
    if (distance < best.distance) best = { index: i, distance };
  }
  // Split segments on the shorter side until the label point is in the middle.
  const full = [...points.slice(0, best.index + 1), anchor, ...points.slice(best.index + 1)];
  let label = best.index + 1;
  while (label * 2 !== full.length - 1) {
    const [from, to] = label * 2 < full.length - 1 ? [0, label] : [label, full.length - 1];
    let longest = from;
    for (let i = from; i < to; i++) if (segmentLength(full, i) > segmentLength(full, longest)) longest = i;
    if (segmentLength(full, longest) < 2) return points;
    full.splice(longest + 1, 0, [(full[longest][0] + full[longest + 1][0]) / 2, (full[longest][1] + full[longest + 1][1]) / 2]);
    if (longest < label) label++;
  }
  return full;
}

function pointAlong(points: Point[], t: number): Point {
  const total = points.slice(1).reduce((sum, _, i) => sum + segmentLength(points, i), 0);
  let remaining = total * t;
  for (let i = 0; i < points.length - 1; i++) {
    const length = segmentLength(points, i);
    if (remaining <= length || i === points.length - 2) {
      const f = length ? Math.min(1, remaining / length) : 0;
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * f, points[i][1] + (points[i + 1][1] - points[i][1]) * f];
    }
    remaining -= length;
  }
  return points[0];
}

function closestOnPath(points: Point[], target: Point): Point {
  let best: Point = points[0];
  let distance = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const p = closestOnSegment(target, points[i], points[i + 1]);
    const d = Math.hypot(p[0] - target[0], p[1] - target[1]);
    if (d < distance) {
      best = p;
      distance = d;
    }
  }
  return best;
}

function overlaps(a: Rect, b: Rect) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/** Whether a segment passes through a rectangle (sampled every few pixels). */
function segmentCrossesRect(p: Point, q: Point, r: Rect) {
  const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 4));
  for (let i = 0; i <= steps; i++) {
    const x = p[0] + ((q[0] - p[0]) * i) / steps;
    const y = p[1] + ((q[1] - p[1]) * i) / steps;
    if (x > r[0] && x < r[2] && y > r[1] && y < r[3]) return true;
  }
  return false;
}

function segmentLength(points: Point[], i: number) {
  return Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
}

function closestOnSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): Point {
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return [ax + dx * t, ay + dy * t];
}

/** Move points[index] toward points[toward] by the arrow gap, if the segment is long enough. */
function shorten(points: Point[], index: number, toward: number) {
  const [x, y] = points[index];
  const [tx, ty] = points[toward];
  const length = Math.hypot(tx - x, ty - y);
  if (length < ARROW_GAP * 3) return;
  points[index] = [x + ((tx - x) / length) * ARROW_GAP, y + ((ty - y) / length) * ARROW_GAP];
}
