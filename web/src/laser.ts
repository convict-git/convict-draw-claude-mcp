// Claude's laser pointer. Claude joins the board as a remote collaborator, so Excalidraw draws its
// named cursor and the fading laser trail.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types";

type Api = ExcalidrawImperativeAPI;
type Point = [number, number];
export type Bounds = [number, number, number, number];
export type Gesture = "circle" | "underline" | "trace" | "dot";

export interface LaserStep {
  bounds: Bounds;
  gesture: Gesture;
  /** Board coordinates to follow, for "trace". */
  path?: Point[];
  ms: number;
}

// Excalidraw colors a collaborator's cursor by hashing its id; this one comes out orange.
const CLAUDE = "claude_laser" as SocketId;
const LASER_COLOR = "#e8590c";
/** How long the cursor stays after the last gesture. */
const LINGER_MS = 2500;
/** Lifting the laser must last a few frames, or Excalidraw doesn't notice the trail ended. */
const LIFT_MS = 120;

let run = 0;
let position: Point | null = null;

/**
 * Points at each step in turn, gliding between them. A new call interrupts the current one.
 * `reveal` scrolls a step into view before it starts and returns the zoom level it left.
 */
export async function pointAt(api: Api, steps: LaserStep[], reveal: (bounds: Bounds) => number) {
  const token = ++run;
  const alive = () => token === run;

  for (const step of steps) {
    const zoom = reveal(step.bounds);
    const { at, loopMs, lift } = gesturePath(step, zoom);
    const start = at(0);

    if (position) {
      // Glide over with the laser off, so the trail only marks what's being pointed at.
      const from = position;
      const distance = Math.hypot(start[0] - from[0], start[1] - from[1]) * zoom;
      const ms = clamp(distance * 0.7, LIFT_MS * 2, 650);
      const ok = await tween(ms, (t) => show(api, lerp(from, start, easeInOut(t)), "up"), alive);
      if (!ok) return;
    }

    const loops = Math.max(1, Math.round(step.ms / loopMs));
    for (let i = 0; i < loops; i++) {
      if (lift && i > 0) {
        show(api, position!, "up");
        if (!(await tween(LIFT_MS, () => {}, alive))) return;
      }
      if (!(await tween(loopMs, (t) => show(api, at(t), "down"), alive))) return;
    }
  }

  show(api, position!, "up");
  if (!(await tween(LINGER_MS, () => {}, alive))) return;
  hideLaser(api);
}

export function hideLaser(api: Api) {
  run++;
  position = null;
  api.updateScene({ collaborators: new Map(), captureUpdate: CaptureUpdateAction.NEVER });
}

function show(api: Api, point: Point, button: "up" | "down") {
  position = point;
  const claude: Collaborator = {
    id: CLAUDE,
    socketId: CLAUDE,
    username: "Claude",
    pointer: { x: point[0], y: point[1], tool: "laser", laserColor: LASER_COLOR },
    button,
  };
  api.updateScene({ collaborators: new Map([[CLAUDE, claude]]), captureUpdate: CaptureUpdateAction.NEVER });
}

/** One loop of a gesture as a function of t in [0, 1], in board coordinates. */
function gesturePath(step: LaserStep, zoom: number): { at: (t: number) => Point; loopMs: number; lift: boolean } {
  const [minX, minY, maxX, maxY] = step.bounds;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const pad = 14 / zoom;

  switch (step.gesture) {
    case "underline": {
      const y = maxY + 6 / zoom;
      const width = (maxX - minX) * zoom;
      // Sweep left to right, then back.
      return { at: (t) => [minX + (maxX - minX) * (1 - Math.abs(1 - 2 * t)), y], loopMs: clamp(width * 3, 700, 1800), lift: false };
    }
    case "trace": {
      const path = step.path?.length ? step.path : [[minX, cy] as Point, [maxX, cy] as Point];
      const lengths = [0];
      for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
      const total = lengths.at(-1) || 1;
      const at = (t: number): Point => {
        const d = easeInOut(t) * total;
        const i = Math.max(1, lengths.findIndex((l) => l >= d));
        const segment = lengths[i] - lengths[i - 1] || 1;
        return lerp(path[i - 1], path[i], (d - lengths[i - 1]) / segment);
      };
      return { at, loopMs: clamp(total * zoom * 2.5, 600, 1600), lift: true };
    }
    case "dot": {
      const r = 16 / zoom;
      return { at: (t) => orbit(cx, cy, r, r, t), loopMs: 650, lift: false };
    }
    default: {
      // An ellipse loose enough to go around the shape's corners.
      const rx = Math.max(((maxX - minX) / 2) * 1.15 + pad, 24 / zoom);
      const ry = Math.max(((maxY - minY) / 2) * 1.2 + pad, 24 / zoom);
      // Ramanujan's approximation of the ellipse's perimeter, traveled at about 450 screen px/s.
      const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
      return { at: (t) => orbit(cx, cy, rx, ry, t), loopMs: clamp(perimeter * zoom * 2.2, 1000, 3000), lift: false };
    }
  }
}

function orbit(cx: number, cy: number, rx: number, ry: number, t: number): Point {
  // Start at the top left and go clockwise, with a slight hand-drawn wobble.
  const angle = (-3 * Math.PI) / 4 + 2 * Math.PI * t;
  const wobble = 1 + 0.03 * Math.sin(angle * 3);
  return [cx + Math.cos(angle) * rx * wobble, cy + Math.sin(angle) * ry * wobble];
}

function tween(ms: number, onFrame: (t: number) => void, alive: () => boolean) {
  return new Promise<boolean>((resolve) => {
    const start = performance.now();
    const tick = (now: number) => {
      if (!alive()) return resolve(false);
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      onFrame(t);
      if (t < 1) requestAnimationFrame(tick);
      else resolve(true);
    };
    requestAnimationFrame(tick);
  });
}

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
