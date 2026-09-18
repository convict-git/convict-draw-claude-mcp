// Drawing in place: what Claude adds to the board is drawn stroke by stroke where it lands, instead of
// popping in. An animated SVG of the area (new elements drawn in order, everything else already there)
// sits exactly over the canvas while it plays and follows the view if the user scrolls or zooms. The
// real elements are on the board underneath the whole time, so nothing is lost if it's cut short.
import { getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { buildAnimation, type Animation } from "./animate";

type Api = ExcalidrawImperativeAPI;
type El = any;
type Rect = [number, number, number, number];

/** The whole drawing takes about this long, however many elements it has... */
const TOTAL_MS = 4500;
/** ...within these limits per element. */
const MIN_ELEMENT_MS = 150;
const MAX_ELEMENT_MS = 450;
const FADE_MS = 180;

interface Playing {
  stop: () => void;
  done: Promise<void>;
  /** When it's expected to finish (performance.now() time). */
  endsAt: number;
}

let playing: Playing | null = null;
/** Counts preparations, so one overtaken by a newer drawing while it was being built gives way. */
let generation = 0;

/** The drawing in progress (if any): resolves when it finishes or is stopped, and about how long that is from now. */
export function drawingIn(): { done: Promise<void>; remainingMs: number } {
  return { done: playing?.done ?? Promise.resolve(), remainingMs: playing ? Math.max(0, playing.endsAt - performance.now()) : 0 };
}

export function stopDrawIn() {
  generation++;
  playing?.stop();
}

export interface DrawIn {
  /** Put the overlay on screen, showing the area as it was before the change. Call right before applying it. */
  mount: () => void;
  /** Start drawing. Returns immediately; `done` resolves when it's over. */
  play: () => void;
  durationMs: number;
}

/**
 * Prepares to draw `newIds` in, in `order` (ids not listed follow in board order), from `next`, the
 * board as it will be once the change is applied. Returns undefined when there's nothing worth drawing.
 */
export async function prepareDrawIn(api: Api, next: readonly El[], newIds: string[], order: string[]): Promise<DrawIn | undefined> {
  stopDrawIn();
  const token = ++generation;
  if (!newIds.length || matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
  const live = next.filter((e) => !e.isDeleted);
  const fresh = new Set(newIds);
  const newElements = live.filter((e) => fresh.has(e.id) || fresh.has(e.containerId));
  if (!newElements.length) return undefined;

  // The overlay hides what's under it, so it has to include everything it covers. Grow the area until
  // it holds every element that reaches into it (a frame brings its contents along).
  let area = bounds(newElements);
  const scope = new Set<string>(newIds);
  for (let round = 0; round < 4; round++) {
    let grew = false;
    for (const e of live) {
      if (e.containerId || scope.has(e.id) || !intersects(bounds([e]), area)) continue;
      scope.add(e.id);
      grew = true;
    }
    const members = live.filter((e) => scope.has(e.id) || scope.has(e.containerId) || scope.has(e.frameId));
    area = bounds(members);
    if (!grew) break;
  }

  // Labels are drawn as strokes of their own.
  const count = newElements.length;
  const elementMs = Math.round(Math.min(MAX_ELEMENT_MS, Math.max(MIN_ELEMENT_MS, TOTAL_MS / count)));
  const listed = [...order.filter((id) => fresh.has(id)), ...newIds.filter((id) => !order.includes(id))];
  const { animation } = await buildAnimation(
    api,
    { ids: [...scope], order: listed, rest: "show", elementMs },
    { elements: live, padding: 8, inlineFonts: false, frameNames: false },
  );
  if (token !== generation) return undefined;
  const durationMs = Math.max(0, animation.finishedMs - animation.startMs);
  return { ...overlay(api, animation), durationMs };
}

function overlay(api: Api, animation: Animation): Omit<DrawIn, "durationMs"> {
  const { svg, scene } = animation;
  const layer = document.createElement("div");
  layer.className = "draw-in";
  layer.appendChild(svg);

  const place = () => {
    const { scrollX, scrollY, zoom } = api.getAppState();
    Object.assign(svg.style, {
      left: `${(scene.x + scrollX) * zoom.value}px`,
      top: `${(scene.y + scrollY) * zoom.value}px`,
      width: `${scene.width * zoom.value}px`,
      height: `${scene.height * zoom.value}px`,
    });
  };

  let finish = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const stop = (fade = false) => {
    if (playing?.done !== done) return;
    playing = null;
    clearTimeout(timer);
    unsubscribe();
    window.removeEventListener("pointerdown", cut, true);
    window.removeEventListener("keydown", cut, true);
    if (fade) {
      layer.style.opacity = "0";
      setTimeout(() => layer.remove(), FADE_MS);
    } else layer.remove();
    finish();
  };
  // The user touching the board takes it back right away.
  const cut = () => stop();
  const lengthMs = animation.finishedMs - animation.startMs + 150;
  playing = { stop: () => stop(), done, endsAt: performance.now() + lengthMs };

  return {
    mount: () => {
      if (playing?.done !== done) return;
      place();
      // Just above the drawing canvas, and below Claude's pointer, selections, and the toolbars.
      const container = document.querySelector(".excalidraw");
      if (!container) return stop();
      container.appendChild(layer);
      // Hold on the first frame (what was there before) until the change is applied underneath.
      svg.pauseAnimations();
      svg.setCurrentTime(animation.startMs / 1000);
      unsubscribe = api.onScrollChange(place);
      window.addEventListener("pointerdown", cut, true);
      window.addEventListener("keydown", cut, true);
    },
    play: () => {
      if (playing?.done !== done) return;
      svg.unpauseAnimations();
      if (playing) playing.endsAt = performance.now() + lengthMs;
      timer = setTimeout(() => stop(true), lengthMs);
    },
  };
}

function bounds(elements: readonly El[]): Rect {
  return getCommonBounds(elements as never) as Rect;
}

function intersects(a: Rect, b: Rect) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}
