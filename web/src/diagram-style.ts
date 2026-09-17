// The visual language of draw_diagram: what each kind, status, color, and line style looks like.
// Keeping one fixed meaning per visual channel (shape and fill = role, border and opacity = status,
// line style = kind of connection, arrowhead = relationship) makes every diagram readable the same way.
import type { Arrowhead, DiagramEdge, DiagramGroup, DiagramNode, NamedColor, NodeKind, Status } from "../../shared/protocol";
import { CLEAN_FONT, HAND_FONT, type Font } from "./measure";

type El = any;

export const INK = "#1e1e1e";
const MUTED = "#868e96";

/** Open Color hues Excalidraw's own palette uses: a pastel fill, a strong stroke, and a faint zone tint. */
export const PALETTE: Record<NamedColor, { fill: string; stroke: string; zone: string }> = {
  blue: { fill: "#a5d8ff", stroke: "#1971c2", zone: "#e7f5ff" },
  green: { fill: "#b2f2bb", stroke: "#2f9e44", zone: "#ebfbee" },
  yellow: { fill: "#ffec99", stroke: "#f08c00", zone: "#fff9db" },
  orange: { fill: "#ffd8a8", stroke: "#e8590c", zone: "#fff4e6" },
  red: { fill: "#ffc9c9", stroke: "#e03131", zone: "#fff5f5" },
  purple: { fill: "#d0bfff", stroke: "#6741d9", zone: "#f3f0ff" },
  teal: { fill: "#c3fae8", stroke: "#0c8599", zone: "#e6fcf5" },
  pink: { fill: "#fcc2d7", stroke: "#c2255c", zone: "#fff0f6" },
  gray: { fill: "#e9ecef", stroke: "#495057", zone: "#f8f9fa" },
};

/** Mind map branches take these colors in turn. */
export const BRANCH_COLORS: NamedColor[] = ["blue", "green", "orange", "purple", "pink", "teal", "red", "yellow"];

export type Shape = "rectangle" | "ellipse" | "diamond";

export const KINDS: Record<NodeKind, { shape: Shape; color: NamedColor; rounded: boolean; size?: "large"; meaning: string }> = {
  topic: { shape: "ellipse", color: "yellow", rounded: false, size: "large", meaning: "main topic" },
  service: { shape: "rectangle", color: "blue", rounded: true, meaning: "component or step" },
  actor: { shape: "ellipse", color: "yellow", rounded: false, meaning: "person or entry point" },
  store: { shape: "rectangle", color: "teal", rounded: false, meaning: "data store" },
  queue: { shape: "rectangle", color: "purple", rounded: true, meaning: "queue or event stream" },
  external: { shape: "rectangle", color: "orange", rounded: true, meaning: "external system" },
  decision: { shape: "diamond", color: "yellow", rounded: false, meaning: "decision" },
  question: { shape: "rectangle", color: "pink", rounded: true, meaning: "open question" },
  note: { shape: "rectangle", color: "gray", rounded: false, meaning: "note" },
  success: { shape: "rectangle", color: "green", rounded: true, meaning: "good outcome" },
  error: { shape: "rectangle", color: "red", rounded: true, meaning: "failure" },
};

export const STATUS_MEANING: Record<Status, string> = {
  highlight: "key part",
  new: "new",
  planned: "planned",
  deprecated: "deprecated",
  risk: "risk",
};

export const LINE_MEANING: Record<string, string> = {
  solid: "call or main flow",
  dashed: "async, event, or response",
  dotted: "optional or indirect",
};

export const HEAD_MEANING: Partial<Record<Arrowhead, string>> = {
  triangle: "inherits / is a",
  triangle_outline: "implements",
  diamond: "owns (composition)",
  diamond_outline: "has (aggregation)",
  dot: "uses",
  circle_outline: "optional",
  bar: "stops / blocked",
  crowfoot_one: "exactly one",
  crowfoot_many: "many",
  crowfoot_one_or_many: "one or more",
};

export const FONT_SIZES = { small: 16, medium: 18, large: 26 };
export const EDGE_FONT = 16;
export const GROUP_FONT = 16;

export interface Look {
  font: Font;
  roughness: number;
}

export function lookOf(name: "sketch" | "clean" | undefined): Look {
  return name === "clean" ? { font: CLEAN_FONT, roughness: 0 } : { font: HAND_FONT, roughness: 1 };
}

/** Mind map context for a node: how deep it is and which branch it's on. */
export interface Branch {
  depth: number;
  color: NamedColor;
}

export interface NodeLook {
  shape: Shape;
  fontSize: number;
  /** Excalidraw properties for the shape. */
  style: Record<string, unknown>;
  /** Excalidraw properties for its label. */
  labelStyle: Record<string, unknown>;
}

export function nodeLook(node: DiagramNode, look: Look, branch?: Branch): NodeLook {
  const kind = KINDS[node.kind ?? (branch?.depth === 0 ? "topic" : "service")] ?? KINDS.service;
  // In a mind map, depth sets the size and the branch sets the color, unless the node says otherwise.
  const depth = branch?.depth;
  const size = node.size ?? kind.size ?? (depth === undefined ? "medium" : depth === 0 ? "large" : depth === 1 ? "medium" : "small");
  // An explicit kind keeps its color (a question stays pink on any branch).
  const color = PALETTE[node.color ?? (depth && !node.kind ? branch!.color : kind.color)] ?? PALETTE.blue;
  const fill = node.fill ?? (depth !== undefined && depth >= 2 ? "none" : "solid");

  const style: Record<string, unknown> = {
    backgroundColor: fill === "none" ? "transparent" : color.fill,
    fillStyle: fill === "none" ? "solid" : fill,
    strokeColor: depth || fill === "none" ? color.stroke : INK,
    strokeWidth: depth === 0 ? 4 : depth !== undefined && depth >= 2 ? 1 : 2,
    strokeStyle: node.border ?? "solid",
    roundness: kind.shape === "rectangle" && (kind.rounded || depth !== undefined) ? { type: 3 } : null,
    roughness: look.roughness,
    opacity: 100,
  };
  const labelStyle: Record<string, unknown> = {
    fontFamily: look.font.family,
    strokeColor: fill === "none" ? color.stroke : INK,
    opacity: 100,
  };
  applyStatus(node.status, style, labelStyle, node.border === undefined);
  return { shape: kind.shape, fontSize: FONT_SIZES[size], style, labelStyle };
}

export function edgeLook(edge: DiagramEdge, look: Look, branch?: Branch) {
  const color = edge.color ? PALETTE[edge.color]?.stroke : branch ? PALETTE[branch.color].stroke : INK;
  const weight = edge.weight ?? (branch ? (branch.depth <= 1 ? "bold" : branch.depth === 2 ? "normal" : "thin") : "normal");
  const head = edge.head ?? (branch ? "none" : "arrow");
  const style: Record<string, unknown> = {
    strokeColor: color ?? INK,
    strokeStyle: edge.line ?? "solid",
    strokeWidth: weight === "bold" ? 4 : weight === "thin" ? 1 : 2,
    startArrowhead: !edge.tail || edge.tail === "none" ? null : edge.tail,
    endArrowhead: head === "none" ? null : head,
    roughness: look.roughness,
    opacity: 100,
  };
  const labelStyle: Record<string, unknown> = { fontFamily: look.font.family, strokeColor: color ?? INK, opacity: 100 };
  applyStatus(edge.status, style, labelStyle, edge.line === undefined);
  return { style, labelStyle };
}

export function groupLook(group: DiagramGroup, look: Look) {
  const color = group.color ? PALETTE[group.color] : undefined;
  const border = group.border ?? "dashed";
  return {
    style: {
      backgroundColor: color ? color.zone : "transparent",
      fillStyle: "solid",
      strokeColor: border === "none" ? "transparent" : color ? color.stroke : MUTED,
      strokeStyle: border === "none" ? "solid" : border,
      strokeWidth: 1,
      roundness: { type: 3 },
      roughness: look.roughness,
    },
    labelStyle: { fontFamily: look.font.family, strokeColor: color ? color.stroke : "#495057" },
  };
}

function applyStatus(status: Status | undefined, style: Record<string, unknown>, label: Record<string, unknown>, lineIsDefault: boolean) {
  switch (status) {
    case "highlight":
      style.strokeWidth = 4;
      break;
    case "new":
      style.strokeWidth = 4;
      style.strokeColor = PALETTE.green.stroke;
      break;
    case "planned":
      if (lineIsDefault) style.strokeStyle = "dashed";
      if (style.fillStyle === "solid" && style.backgroundColor !== "transparent") style.fillStyle = "hachure";
      break;
    case "deprecated":
      style.opacity = 35;
      label.opacity = 45;
      if (lineIsDefault) style.strokeStyle = "dotted";
      break;
    case "risk":
      style.strokeWidth = 4;
      style.strokeColor = PALETTE.red.stroke;
      label.strokeColor = PALETTE.red.stroke;
      break;
  }
}

/** The style properties draw_diagram sets, to tell whether the user has restyled an element since. */
export const STYLE_KEYS = ["backgroundColor", "fillStyle", "strokeColor", "strokeStyle", "strokeWidth", "opacity"];

export function styleSignature(element: El) {
  return STYLE_KEYS.map((key) => String(element[key] ?? "")).join("|");
}
