// The part of the canvas the user can actually see. Excalidraw's toolbars, menus, zoom controls, open
// panels, and our own buttons float over the canvas, so content under them is hidden even though it's
// "in the viewport". Every camera move and visibility check uses the area clear of them.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

type Api = ExcalidrawImperativeAPI;

/** Canvas pixels, relative to the canvas's top-left corner. */
export interface ScreenArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The UI that floats over the canvas: the toolbar, the style panel (shown while a shape or tool is
 * selected), the Library sidebar, the menu button, the top-right buttons, the zoom/undo and help
 * footers, and our connection indicator. Panels that aren't open aren't in the DOM, and zen mode moves
 * the rest off the canvas, so measuring these few boxes follows every layout for a fraction of a millisecond.
 */
const OVERLAYS = [
  ".excalidraw .Island",
  ".main-menu-trigger",
  ".layer-ui__wrapper__top-right",
  ".layer-ui__wrapper__footer-left",
  ".layer-ui__wrapper__footer-right",
  ".connection",
].join(", ");
/** Dialogs and the animation player cover everything for a moment; they don't shape the view. */
const IGNORED = ".Modal, .animation-player";
/** Breathing room between content and the UI next to it. */
const UI_PADDING = 12;

/**
 * The largest canvas area clear of UI overlays. Each piece of UI is assigned to the canvas edge it
 * hides the least from, and the area is what's left inside those edges.
 */
export function visibleArea(api: Api): ScreenArea {
  const { width, height, offsetLeft, offsetTop } = api.getAppState();
  const full = { left: 0, top: 0, width, height };
  if (typeof document === "undefined" || !width || !height) return full;

  let [top, right, bottom, left] = [0, 0, 0, 0];
  for (const el of document.querySelectorAll(OVERLAYS)) {
    if (el.closest(IGNORED)) continue;
    const r = el.getBoundingClientRect();
    const minX = Math.max(r.left - offsetLeft, 0);
    const minY = Math.max(r.top - offsetTop, 0);
    const maxX = Math.min(r.right - offsetLeft, width);
    const maxY = Math.min(r.bottom - offsetTop, height);
    if (maxX <= minX || maxY <= minY) continue; // hidden, empty, or off the canvas
    const cost = { top: maxY, bottom: height - minY, left: maxX, right: width - minX };
    const side = (Object.keys(cost) as (keyof typeof cost)[]).reduce((a, b) => (cost[b] < cost[a] ? b : a));
    if (side === "top") top = Math.max(top, cost.top);
    else if (side === "bottom") bottom = Math.max(bottom, cost.bottom);
    else if (side === "left") left = Math.max(left, cost.left);
    else right = Math.max(right, cost.right);
  }

  const pad = (inset: number) => (inset > 0 ? inset + UI_PADDING : 0);
  let area: ScreenArea = { left: pad(left), top: pad(top), width: width - pad(left) - pad(right), height: height - pad(top) - pad(bottom) };
  // On a small screen, a big panel could leave almost nothing; then keep that axis whole.
  if (area.width < width * 0.4) area = { ...area, left: 0, width };
  if (area.height < height * 0.4) area = { ...area, top: 0, height };
  return area;
}

/** The part of the board the user can see, in board coordinates. */
export function currentViewport(api: Api) {
  const s = api.getAppState();
  return viewportFrom(visibleArea(api), s.scrollX, s.scrollY, s.zoom.value);
}

export function viewportCenter(api: Api): [number, number] {
  const v = currentViewport(api);
  return [v.x + v.width / 2, v.y + v.height / 2];
}

/** Zooms to `value` with `focus` at the center of the visible area. Returns the viewport it set. */
export function setZoom(api: Api, value: number, focus: [number, number]) {
  const area = visibleArea(api);
  const zoom = Math.min(Math.max(value, 0.1), 30);
  const scrollX = -focus[0] + (area.left + area.width / 2) / zoom;
  const scrollY = -focus[1] + (area.top + area.height / 2) / zoom;
  api.updateScene({
    appState: { zoom: { value: zoom } as never, scrollX, scrollY },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  return viewportFrom(area, scrollX, scrollY, zoom);
}

function viewportFrom(area: ScreenArea, scrollX: number, scrollY: number, zoom: number) {
  return {
    x: Math.round(area.left / zoom - scrollX),
    y: Math.round(area.top / zoom - scrollY),
    width: Math.round(area.width / zoom),
    height: Math.round(area.height / zoom),
    zoom: Math.round(zoom * 100) / 100,
  };
}
