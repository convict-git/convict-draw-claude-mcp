// Layout checks that run after Claude draws. They report overlapping shapes, arrows that cut through
// shapes they don't connect, and arrow labels that are cramped or wrapped, so Claude can fix them in
// its next call instead of leaving a tangled diagram.

import { arrowShows } from "./diagram-layout";

type El = any;
type Rect = [number, number, number, number];
type Point = [number, number];

const MAX_ISSUES = 6;
const BOX_TYPES = new Set(["rectangle", "ellipse", "diamond", "image", "text", "embeddable", "iframe"]);

/** Problems involving the elements in `touched` (or arrows attached to them). */
export function checkLayout(elements: readonly El[], touched: Set<string>): string[] {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const boxes = live.filter((e) => BOX_TYPES.has(e.type) && !e.containerId && e.width > 0 && e.height > 0);
  const arrows = live.filter((e) => (e.type === "arrow" || e.type === "line") && e.points?.length >= 2);
  const issues: string[] = [];

  // Shapes overlapping each other. One shape entirely inside another is grouping, not overlap.
  for (const a of boxes) {
    if (!touched.has(a.id)) continue;
    const ra = rect(a);
    for (const b of boxes) {
      if (a === b || (touched.has(b.id) && b.id < a.id)) continue;
      const rb = rect(b);
      if (intersects(inset(ra, 2), inset(rb, 2)) && !contains(ra, rb) && !contains(rb, ra)) issues.push(`${name(a)} overlaps ${name(b)}`);
    }
  }

  for (const arrow of arrows) {
    const startId = arrow.startBinding?.elementId;
    const endId = arrow.endBinding?.elementId;
    if (!touched.has(arrow.id) && !touched.has(startId) && !touched.has(endId)) continue;
    const path: Point[] = arrow.points.map((p: number[]) => [arrow.x + p[0], arrow.y + p[1]]);
    const ends = [path[0], path[path.length - 1]];
    // Boxes around both ends (a group the arrow lives in) aren't obstacles.
    const obstacles = boxes.filter((b) => b.id !== startId && b.id !== endId && !ends.some((p) => inside(p, rect(b))));

    const crossed = obstacles.filter((b) => segments(path).some(([p, q]) => segmentHitsRect(p, q, inset(rect(b), shrink(b)))));
    if (crossed.length) issues.push(`${arrowName(arrow)} crosses ${crossed.map(name).join(", ")}`);

    if ((startId || endId) && pathLength(path) < 24) issues.push(`${arrowName(arrow)} is only ${Math.round(pathLength(path))}px long, too short to see`);

    const labelId = arrow.boundElements?.find((b: El) => b.type === "text")?.id;
    const label = labelId && byId.get(labelId);
    if (!label || label.isDeleted) continue;
    const text = label.originalText ?? label.text ?? "";
    const wrappedLines = String(label.text ?? "").split("\n").length;
    const lines = text.split("\n").length;
    const length = Math.round(pathLength(path));
    if (wrappedLines > lines) {
      issues.push(`label "${oneLine(text)}" on ${arrowName(arrow)} wraps onto ${wrappedLines} lines (arrow is ${length}px long)`);
    }
    if (!arrowShows(path, rect(label), 10)) {
      issues.push(`label "${oneLine(text)}" on ${arrowName(arrow)} hides the arrow: the label is about ${Math.round(label.width)}px wide and the arrow ${length}px long. Move the shapes about ${Math.max(40, Math.round(label.width + 60 - length))}px further apart, route the arrow with a longer straight run, or shorten the label`);
    }
    const lr = inset(rect(label), 2);
    const covered = boxes.filter((b) => !ends.every((p) => inside(p, rect(b))) && intersects(lr, rect(b)));
    if (covered.length) {
      issues.push(`label "${oneLine(text)}" on ${arrowName(arrow)} overlaps ${covered.map(name).join(", ")}: needs about ${Math.round(label.width + 40)}px of arrow, has ${length}px`);
    }
  }

  // Arrow labels on top of each other.
  const labels = live.filter((e) => e.type === "text" && e.containerId && ["arrow", "line"].includes(byId.get(e.containerId)?.type));
  for (const a of labels) {
    if (!touched.has(a.id) && !touched.has(a.containerId)) continue;
    for (const b of labels) {
      if (a === b || ((touched.has(b.id) || touched.has(b.containerId)) && b.id < a.id)) continue;
      if (intersects(inset(rect(a), 1), inset(rect(b), 1))) issues.push(`labels "${oneLine(a.originalText ?? a.text)}" and "${oneLine(b.originalText ?? b.text)}" overlap`);
    }
  }

  const unique = [...new Set(issues)];
  if (unique.length > MAX_ISSUES) return [...unique.slice(0, MAX_ISSUES), `and ${unique.length - MAX_ISSUES} more layout problems`];
  return unique;
}

function name(e: El) {
  const text = e.type === "text" ? e.originalText ?? e.text : undefined;
  return text ? `text "${oneLine(text)}"` : `${e.type} ${e.id}`;
}

function arrowName(arrow: El) {
  return `${arrow.type} ${arrow.id}`;
}

function oneLine(text: string) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 37)}...` : flat;
}

function rect(e: El): Rect {
  return [e.x, e.y, e.x + e.width, e.y + e.height];
}

/** Ellipses and diamonds don't fill their bounding box, so shrink them more before testing crossings. */
function shrink(e: El) {
  return e.type === "ellipse" || e.type === "diamond" ? Math.min(e.width, e.height) * 0.15 : 6;
}

function inset([minX, minY, maxX, maxY]: Rect, by: number): Rect {
  return [minX + by, minY + by, maxX - by, maxY - by];
}

function intersects(a: Rect, b: Rect) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function contains(outer: Rect, inner: Rect) {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function inside([x, y]: Point, r: Rect) {
  return x > r[0] && x < r[2] && y > r[1] && y < r[3];
}

function segments(path: Point[]): [Point, Point][] {
  return path.slice(1).map((q, i) => [path[i], q]);
}

function pathLength(path: Point[]) {
  return segments(path).reduce((sum, [p, q]) => sum + Math.hypot(q[0] - p[0], q[1] - p[1]), 0);
}

/** Liang–Barsky clipping: does the segment pass through the rectangle's interior? */
function segmentHitsRect(p: Point, q: Point, [minX, minY, maxX, maxY]: Rect) {
  if (minX >= maxX || minY >= maxY) return false;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  let t0 = 0;
  let t1 = 1;
  for (const [pk, qk] of [
    [-dx, p[0] - minX],
    [dx, maxX - p[0]],
    [-dy, p[1] - minY],
    [dy, maxY - p[1]],
  ]) {
    if (pk === 0) {
      if (qk <= 0) return false;
    } else {
      const t = qk / pk;
      if (pk < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 >= t1) return false;
    }
  }
  return true;
}
