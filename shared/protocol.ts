// Messages exchanged between the board server and the browser tab over /ws.
// The tab owns the live Excalidraw scene; the server forwards connector tool calls to it.

export type TabCommand = "draw" | "diagram" | "mermaid" | "scene" | "image" | "view" | "clear" | "animate" | "point";

export type ServerToTab =
  | { type: "request"; id: string; command: TabCommand; args: unknown }
  | { type: "superseded" };

export type TabToServer =
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: string };

/** A trimmed-down element: enough for Claude to understand the board, without Excalidraw internals. */
export interface SlimElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  text?: string;
  fontSize?: number;
  containerId?: string | null;
  boundTextId?: string;
  startId?: string;
  endId?: string;
  points?: number[][];
  frameId?: string | null;
  name?: string | null;
  strokeColor?: string;
  backgroundColor?: string;
  strokeStyle?: string;
  link?: string | null;
  byClaude?: boolean;
  /** Id of the draw_diagram diagram this element belongs to. */
  diagram?: string;
  /** For a diagram's frame: which steps are on the board. */
  steps?: { shown: number; total: number };
}

export interface SceneSnapshot {
  elements: SlimElement[];
  selectedIds: string[];
  editingTextId: string | null;
  viewport: { x: number; y: number; width: number; height: number; zoom: number };
}

export interface DrawArgs {
  elements: Record<string, unknown>[];
  placement?: "as_given" | "right_of_existing" | "below_existing";
  /** Sweep the laser pointer over the new elements after drawing them. */
  point?: boolean;
}

/** Results of commands that change the board carry the scene afterwards, which saves a round trip. */
export interface ChangeResult {
  /** Every element id this call changed, including labels and attached arrows. */
  touched: string[];
  scene: SceneSnapshot;
}

export interface DrawResult extends ChangeResult {
  created: string[];
  updated: string[];
  deleted: string[];
  /** Problems in the drawing or its layout: overlaps, crossings, cramped labels. */
  warnings: string[];
  /** How far `placement` moved the new elements from the coordinates given. */
  offset?: { dx: number; dy: number };
}

export type NodeKind =
  | "topic" | "service" | "actor" | "store" | "queue" | "external" | "decision" | "question" | "note" | "success" | "error";
export type NamedColor = "blue" | "green" | "yellow" | "orange" | "red" | "purple" | "teal" | "pink" | "gray";
/** How a part is marked: emphasis, what's new, what's planned, what's going away, what's risky. */
export type Status = "highlight" | "new" | "planned" | "deprecated" | "risk";
export type LineStyle = "solid" | "dashed" | "dotted";
export type Arrowhead =
  | "arrow" | "triangle" | "triangle_outline" | "dot" | "circle" | "circle_outline" | "diamond" | "diamond_outline"
  | "bar" | "crowfoot_one" | "crowfoot_many" | "crowfoot_one_or_many" | "none";

export interface DiagramNode {
  id: string;
  label: string;
  kind?: NodeKind;
  color?: NamedColor;
  fill?: "solid" | "hachure" | "cross-hatch" | "zigzag" | "none";
  border?: LineStyle;
  status?: Status;
  size?: "small" | "medium" | "large";
  group?: string;
  step?: number;
}

export interface DiagramEdge {
  id?: string;
  from: string;
  to: string;
  label?: string;
  line?: LineStyle;
  weight?: "thin" | "normal" | "bold";
  head?: Arrowhead;
  tail?: Arrowhead;
  color?: NamedColor;
  status?: Status;
  step?: number;
}

export interface DiagramGroup {
  id: string;
  label: string;
  parent?: string;
  /** Tints the group's background and border. */
  color?: NamedColor;
  border?: LineStyle | "none";
  step?: number;
}

export interface DiagramArgs {
  id: string;
  title?: string;
  /** flow: layered boxes and arrows. mindmap: a central topic with colored, curved branches. */
  layout?: "flow" | "mindmap";
  direction?: "right" | "down";
  arrows?: "elbow" | "curved" | "straight";
  /** sketch: hand-drawn. clean: smooth lines and a plain font. */
  look?: "sketch" | "clean";
  /** true: explain the styles used. An object also names what they mean, e.g. {"dashed": "events"}. */
  legend?: boolean | Record<string, string>;
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
  groups?: DiagramGroup[];
  /** Node, edge, or group ids to take out of the diagram. */
  remove?: string[];
  /** Show parts up to this step; "all" shows everything. */
  showStep?: number | "all";
  point?: boolean;
  placement?: "right_of_existing" | "below_existing";
}

export interface DiagramResult extends DrawResult {
  frame: { x: number; y: number; width: number; height: number };
  nodeCount: number;
  edgeCount: number;
  steps: { shown: number; total: number };
}

export interface MermaidArgs {
  definition: string;
  x?: number;
  y?: number;
}

export interface MermaidResult extends ChangeResult {
  created: string[];
  bounds: { x: number; y: number; width: number; height: number };
  editable: boolean;
}

export interface ImageArgs {
  area?: "all" | "viewport" | "selection";
}

export interface ImageResult {
  base64: string;
  mimeType: string;
}

export interface AnimateArgs {
  /** Animate only these elements (a frame includes everything inside it). Default: the whole board. */
  ids?: string[];
  /** Ids to draw first, in this order. Each shape's label is drawn right after it. */
  order?: string[];
  /** Elements not listed in `order`: "animate" draws them afterwards, "show" displays them from the start. */
  rest?: "animate" | "show";
  /** How long drawing each element takes, in ms. Default: excalidraw-animate's timing. */
  elementMs?: number;
  /** Show a pencil following the strokes. */
  pointer?: boolean;
  /** Return the animated SVG so the server can save it. */
  includeSvg?: boolean;
}

export interface AnimateResult {
  elementCount: number;
  durationMs: number;
  warnings: string[];
  svg?: string;
}

export interface PointArgs {
  /** Elements to point at, one after another (or all at once with `together`). */
  ids?: string[];
  together?: boolean;
  /** A spot on the board to point at instead. */
  x?: number;
  y?: number;
  /** How long to point at each target. */
  ms?: number;
  gesture?: "auto" | "circle" | "underline" | "trace" | "dot";
  /** Remove Claude's pointer from the board now. */
  hide?: boolean;
}

export interface PointResult {
  targets: string[];
  durationMs: number;
  warnings: string[];
}

export interface ViewArgs {
  fit?: "all" | "selection";
  ids?: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zoom?: number;
}
