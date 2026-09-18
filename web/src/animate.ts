// Turns the live board (or part of it) into a self-playing SVG with excalidraw-animate, and holds
// the animation the player overlay is showing.
import { exportToSvg, getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
// The package entry also pulls in its file-saving helpers, whose dependency isn't installed with it.
import { animateSvg } from "excalidraw-animate/dist/animate.js";
import type { AnimateArgs } from "../../shared/protocol";
import { diagramOrder } from "./diagram";

type Api = ExcalidrawImperativeAPI;
type El = any;

export interface Animation {
  id: number;
  svg: SVGSVGElement;
  /** When the last stroke finishes, in ms. */
  finishedMs: number;
  /** Where playback starts: elements shown from the start are already drawn by then. */
  startMs: number;
  width: number;
  height: number;
  /** Where the SVG's top left corner is on the board, and how much of the board it covers. */
  scene: { x: number; y: number; width: number; height: number };
  dark: boolean;
}

export interface BuildOptions {
  /** Build from these elements instead of the board's, e.g. a change that hasn't been applied yet. */
  elements?: readonly El[];
  padding?: number;
  /** Embed the fonts, so the SVG renders outside this page. */
  inlineFonts?: boolean;
  /** Draw frame names (the board shows its own, at a fixed screen size). */
  frameNames?: boolean;
}

// A pencil whose tip sits at (0, 0), where excalidraw-animate anchors the pointer image.
const PENCIL = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'>" +
    "<path d='M1 1 L9 4 L26 21 L21 26 L4 9 Z' fill='#ffd43b' stroke='#1e1e1e' stroke-width='1.5' stroke-linejoin='round'/>" +
    "<path d='M1 1 L5 2.5 L2.5 5 Z' fill='#1e1e1e'/></svg>",
)}`;

let nextId = 0;

export async function buildAnimation(api: Api, args: AnimateArgs, { elements: source, padding = 30, inlineFonts = true, frameNames = true }: BuildOptions = {}) {
  const { ids, rest = "animate", elementMs, pointer = false } = args;
  const warnings: string[] = [];
  const files = api.getFiles();
  const all = (source ?? (api.getSceneElements() as readonly El[])).filter(
    // Images whose file hasn't loaded can't be exported.
    (e) => !e.isDeleted && (e.type !== "image" || (e.fileId && files[e.fileId])),
  );
  const byId = new Map(all.map((e) => [e.id, e]));
  // A draw_diagram diagram plays in its step order unless told otherwise.
  const order = args.order?.length ? args.order : (ids ?? []).flatMap((id) => diagramOrder(byId.get(id))).filter((id) => byId.has(id));

  /** An element plus what belongs to it: a shape's label, or everything inside a frame. */
  const expand = (id: string): El[] => {
    const el = byId.get(id);
    if (!el) return [];
    if (el.type === "frame" || el.type === "magicframe") {
      return all.filter((e) => e.id === id || e.frameId === id || (e.containerId && byId.get(e.containerId)?.frameId === id));
    }
    return all.filter((e) => e.id === id || e.containerId === id);
  };

  for (const id of [...(ids ?? []), ...order]) if (!byId.has(id)) warnings.push(`no element with id "${id}"`);
  const scope = new Set(ids?.length ? ids.flatMap(expand).map((e) => e.id) : all.map((e) => e.id));
  const elements = all.filter((e) => scope.has(e.id));
  if (!elements.length) throw new Error("There's nothing to animate.");

  // Drawing order: the ids in `order` first, then everything else. A label always follows its shape.
  const sequence: El[] = [];
  const queued = new Set<string>();
  const enqueue = (e: El) => {
    if (queued.has(e.id) || !scope.has(e.id)) return;
    queued.add(e.id);
    sequence.push(e);
    for (const b of e.boundElements ?? []) if (b.type === "text" && byId.has(b.id)) enqueue(byId.get(b.id));
  };
  for (const id of order) for (const e of expand(id)) if (!e.containerId || !scope.has(e.containerId)) enqueue(e);
  const listed = queued.size;
  for (const e of elements) if (!e.containerId || !scope.has(e.containerId)) enqueue(e);
  for (const e of elements) enqueue(e);
  const shown = new Set(order.length && rest === "show" ? sequence.slice(listed).map((e) => e.id) : []);

  const state = api.getAppState();
  const dark = state.theme === "dark";
  // Clipping wraps shapes inside frames in an extra group, which excalidraw-animate can't patch.
  const frameRendering = { ...state.frameRendering, clip: false, ...(frameNames ? {} : { name: false }) };
  const exportSvg = (list: El[], fonts = inlineFonts) =>
    exportToSvg({
      elements: list as never,
      appState: { ...state, frameRendering, exportBackground: true, exportWithDarkMode: dark, exportScale: 1 },
      files,
      exportPadding: padding,
      ...(fonts ? {} : { skipInliningFonts: true as const }),
    });

  // Embeds don't animate, and links would wrap shapes in <a> tags that excalidraw-animate skips over.
  let renderable = elements.filter((e) => e.type !== "iframe" && e.type !== "embeddable").map((e) => (e.link ? { ...e, link: null } : e));
  let svg = await exportSvg(renderable);
  let rendered = renderOrder(renderable, frameRendering);
  if (groupCount(svg) !== rendered.length) {
    // Something rendered nothing (a zero-size stroke, say). Find it by exporting elements one at a time.
    const empty = new Set<string>();
    for (const e of renderable) {
      if (e.type === "frame" || e.type === "magicframe") continue;
      if (!groupCount(await exportSvg([e], false))) empty.add(e.id);
    }
    renderable = renderable.filter((e) => !empty.has(e.id));
    svg = await exportSvg(renderable);
    rendered = renderOrder(renderable, frameRendering);
    if (groupCount(svg) !== rendered.length) throw new Error("Couldn't match the exported drawing to the board's elements.");
  }

  // excalidraw-animate pairs the SVG's groups with the elements by position, and reads each element's
  // order and duration from its id. It only uses the ids for sorting, so tag copies of the elements.
  const rank = new Map(sequence.map((e, i) => [e.id, i + 1]));
  let shownCount = 0;
  const tagged = rendered.map((e) => {
    const base = e.id.replace(/-?animate(Order|Duration):-?\d+/g, "");
    let tag = `-animateOrder:${rank.get(e.id)}${elementMs ? `-animateDuration:${Math.round(elementMs)}` : ""}`;
    if (shown.has(e.id)) {
      tag = "-animateOrder:-1-animateDuration:1";
      shownCount++;
    }
    return { ...e, id: base + tag };
  });

  const { finishedMs } = animateSvg(svg, tagged as never, {
    // Elements shown from the start take 1ms each and play from 0; otherwise start after a short blank.
    startMs: shownCount ? 0 : 400,
    ...(pointer ? { pointerImg: PENCIL, pointerWidth: "28", pointerHeight: "28" } : {}),
  });

  // Excalidraw exports from the corner of what it draws (labels aside), less the padding.
  const [minX, minY] = getCommonBounds(renderable.filter((e) => !e.containerId) as never);
  const [, , viewWidth, viewHeight] = (svg.getAttribute("viewBox") ?? "0 0 0 0").split(" ").map(Number);
  const animation: Animation = {
    id: nextId++,
    scene: { x: minX - padding, y: minY - padding, width: viewWidth, height: viewHeight },
    svg,
    finishedMs,
    startMs: shownCount ? shownCount + 1 : 0,
    width: Number(svg.getAttribute("width")) || 800,
    height: Number(svg.getAttribute("height")) || 600,
    dark,
  };
  return { animation, elementCount: rendered.length - shownCount, warnings };
}

/**
 * The elements behind the SVG's top-level groups, in order, mirroring Excalidraw's SVG export: a label
 * is drawn right after its shape, and a frame adds a group only for its name (its outline is a rect).
 */
function renderOrder(elements: El[], frameRendering: { enabled: boolean; name: boolean }): El[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out: El[] = [];
  for (const e of elements) {
    if (e.type === "text" && e.containerId && byId.has(e.containerId)) continue;
    if (e.type === "frame" || e.type === "magicframe") {
      // excalidraw-animate draws the name like any other text.
      if (frameRendering.enabled && frameRendering.name) out.push({ ...e, type: "text" });
      continue;
    }
    out.push(e);
    const labelId = e.boundElements?.find((b: El) => b.type === "text")?.id;
    if (labelId && byId.has(labelId)) out.push(byId.get(labelId));
  }
  return out;
}

/** Counts the nodes excalidraw-animate pairs with elements. */
function groupCount(svg: SVGSVGElement) {
  return [...svg.children].filter((n) => n.tagName === "g" || n.tagName === "use").length;
}

export function serializeAnimation(animation: Animation) {
  return new XMLSerializer().serializeToString(animation.svg);
}

// ---------------------------------------------------------------------------
// The animation on screen, for the player overlay
// ---------------------------------------------------------------------------

let current: Animation | null = null;
const listeners = new Set<() => void>();

export function showAnimation(animation: Animation | null) {
  current = animation;
  for (const listener of listeners) listener();
}

export function closeAnimation() {
  if (current) showAnimation(null);
}

export function subscribeAnimation(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function currentAnimation() {
  return current;
}
