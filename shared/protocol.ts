// Messages exchanged between the board server and the browser tab over /ws.
// The tab owns the live Excalidraw scene; the server forwards connector tool calls to it.

export type TabCommand = "draw" | "mermaid" | "scene" | "image" | "view" | "clear";

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
}

export interface DrawResult {
  created: string[];
  updated: string[];
  deleted: string[];
  /** Every element id this call changed, including labels and attached arrows. */
  touched: string[];
  warnings: string[];
}

export interface MermaidArgs {
  definition: string;
  x?: number;
  y?: number;
}

export interface MermaidResult {
  created: string[];
  touched: string[];
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

export interface ViewArgs {
  fit?: "all" | "selection";
  ids?: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zoom?: number;
}
