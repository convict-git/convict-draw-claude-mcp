// Where new content goes: the nearest free spot next to what's already on the board, so everything
// stays close together and the whole board still fits on one screen when zoomed out.
import { getCommonBounds } from "@excalidraw/excalidraw";

type El = any;
export type Rect = [number, number, number, number];

/** Space kept between separate pieces of work. */
export const PLACEMENT_GAP = 100;
const GRID = 20;
/** Roughly a screen's shape: the board should grow toward it rather than into a long strip. */
const SCREEN_ASPECT = 1.6;

/** The areas new content must stay clear of: top-level elements (a frame stands for everything in it). */
export function obstaclesOf(elements: readonly El[], skip: ReadonlySet<string> = new Set()): Rect[] {
  const frames = new Set(elements.filter((e) => e.type === "frame" && !e.isDeleted).map((e) => e.id));
  return elements
    .filter((e) => !e.isDeleted && !e.containerId && !skip.has(e.id) && !(e.frameId && frames.has(e.frameId) && !skip.has(e.frameId)))
    .map((e) => getCommonBounds([e] as never) as Rect);
}

/**
 * The top-left corner for a `width`×`height` area that overlaps nothing, sits next to existing content,
 * and keeps the board compact. Among equally compact spots, the one nearest `near` (where the user is
 * looking) wins. Returns undefined on an empty board.
 */
export function findFreeSpot(width: number, height: number, obstacles: readonly Rect[], near?: [number, number]): [number, number] | undefined {
  if (!obstacles.length) return undefined;
  const all = union(obstacles);
  const gap = PLACEMENT_GAP;
  const candidates: [number, number][] = [
    [all[2] + gap, all[1]],
    [all[0], all[3] + gap],
  ];
  for (const [minX, minY, maxX, maxY] of obstacles) {
    candidates.push(
      [maxX + gap, minY],
      [minX, maxY + gap],
      [minX - width - gap, minY],
      [minX, minY - height - gap],
      [maxX + gap, maxY - height],
      [maxX - width, maxY + gap],
    );
  }

  const focus = near ?? [(all[0] + all[2]) / 2, (all[1] + all[3]) / 2];
  let best: [number, number] | undefined;
  let bestCost = Infinity;
  for (const [cx, cy] of candidates) {
    const x = snap(cx);
    const y = snap(cy);
    const rect: Rect = [x, y, x + width, y + height];
    // Just under the gap, so spots exactly one gap away (after snapping) still count as free.
    if (obstacles.some((o) => overlaps(rect, o, gap - GRID - 1))) continue;
    const [uMinX, uMinY, uMaxX, uMaxY] = union([all, rect]);
    // How big a screen-shaped view must be to show everything, plus a pull toward the user's view.
    const fit = Math.max(uMaxX - uMinX, (uMaxY - uMinY) * SCREEN_ASPECT);
    const distance = Math.hypot(x + width / 2 - focus[0], y + height / 2 - focus[1]);
    const cost = fit + distance * 0.25;
    if (cost < bestCost) {
      bestCost = cost;
      best = [x, y];
    }
  }
  return best ?? [snap(all[2] + gap), snap(all[1])];
}

function union(rects: readonly Rect[]): Rect {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rects) {
    minX = Math.min(minX, r[0]);
    minY = Math.min(minY, r[1]);
    maxX = Math.max(maxX, r[2]);
    maxY = Math.max(maxY, r[3]);
  }
  return [minX, minY, maxX, maxY];
}

function overlaps(a: Rect, b: Rect, margin: number) {
  return a[0] < b[2] + margin && a[2] + margin > b[0] && a[1] < b[3] + margin && a[3] + margin > b[1];
}

function snap(v: number) {
  return Math.round(v / GRID) * GRID;
}
