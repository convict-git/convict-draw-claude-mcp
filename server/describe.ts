// Turns the raw scene into short text Claude can read: an outline of the board and a list of
// what the user changed since Claude last looked.
import type { SceneSnapshot, SlimElement } from "../shared/protocol.js";

export type Snapshot = Map<string, SlimElement & { label?: string }>;

const MOVE_THRESHOLD = 8;

/** Index elements by id, folding each shape's label text into the shape itself. */
export function snapshotElements(elements: SlimElement[]): Snapshot {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const snapshot: Snapshot = new Map();
  for (const e of elements) {
    if (e.type === "text" && e.containerId && byId.has(e.containerId)) continue;
    const label = e.boundTextId ? byId.get(e.boundTextId)?.text : undefined;
    snapshot.set(e.id, { ...e, label });
  }
  return snapshot;
}

export function describeBoard(scene: SceneSnapshot): string {
  const snapshot = snapshotElements(scene.elements);
  const v = scene.viewport;
  const lines: string[] = [];

  const header = [`${snapshot.size} element${snapshot.size === 1 ? "" : "s"}`];
  header.push(`visible area (clear of toolbars) x=${v.x} y=${v.y} ${v.width}×${v.height} at ${Math.round(v.zoom * 100)}% zoom`);
  lines.push(`Board: ${header.join(" · ")}`);
  if (snapshot.size) lines.push("You drew everything except elements marked [user].");

  const selected = scene.selectedIds.filter((id) => snapshot.has(id)).map((id) => name(snapshot.get(id)!, snapshot));
  if (selected.length) lines.push(`User has selected: ${selected.join(", ")}`);
  if (scene.editingTextId) lines.push(`User is currently typing in ${name(snapshot.get(scene.editingTextId) ?? { id: scene.editingTextId, type: "text" } as never, snapshot)}`);
  if (!snapshot.size) {
    lines.push("The board is empty.");
    return lines.join("\n");
  }

  const frames = [...snapshot.values()].filter((e) => e.type === "frame" || e.type === "magicframe");
  const inFrame = new Map<string, string[]>();
  const loose: string[] = [];
  for (const e of snapshot.values()) {
    if (e.type === "frame" || e.type === "magicframe") continue;
    const line = describeElement(e, snapshot);
    if (e.frameId && snapshot.has(e.frameId)) inFrame.set(e.frameId, [...(inFrame.get(e.frameId) ?? []), line]);
    else loose.push(line);
  }
  for (const frame of frames) {
    lines.push(`- ${describeElement(frame, snapshot)}`);
    for (const line of inFrame.get(frame.id) ?? []) lines.push(`    - ${line}`);
  }
  for (const line of loose) lines.push(`- ${line}`);
  return lines.join("\n");
}

export function describeChanges(before: Snapshot, scene: SceneSnapshot): string[] {
  const after = snapshotElements(scene.elements);
  const changes: string[] = [];

  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) {
      changes.push(`added ${describeElement(now, after)}`);
      continue;
    }
    const what: string[] = [];
    const wasText = was.label ?? was.text;
    const nowText = now.label ?? now.text;
    if (wasText !== nowText) what.push(`text "${wasText ?? ""}" → "${nowText ?? ""}"`);
    const dx = now.x - was.x;
    const dy = now.y - was.y;
    if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) what.push(`moved by (${signed(dx)}, ${signed(dy)}) to (${now.x}, ${now.y})`);
    if (Math.abs(now.width - was.width) > MOVE_THRESHOLD || Math.abs(now.height - was.height) > MOVE_THRESHOLD)
      what.push(`resized to ${now.width}×${now.height}`);
    if (was.strokeColor !== now.strokeColor || was.backgroundColor !== now.backgroundColor || was.strokeStyle !== now.strokeStyle)
      what.push("restyled");
    if (was.startId !== now.startId || was.endId !== now.endId) what.push(`now connects ${connection(now, after)}`);
    if (was.frameId !== now.frameId) what.push(now.frameId ? `moved into ${name(after.get(now.frameId) ?? { id: now.frameId, type: "frame" } as never, after)}` : "moved out of its frame");
    if (was.name !== now.name) what.push(`renamed to "${now.name ?? ""}"`);
    if (what.length) changes.push(`changed ${name(now, after)}: ${what.join(", ")}`);
  }
  for (const [id, was] of before) {
    if (!after.has(id)) changes.push(`deleted ${name(was, before)}`);
  }
  return changes;
}

function describeElement(e: SlimElement & { label?: string }, all: Snapshot): string {
  const parts: string[] = [];
  switch (e.type) {
    case "frame":
    case "magicframe":
      parts.push(`frame "${e.name ?? "Frame"}" (id ${e.id}) at (${e.x}, ${e.y}) ${e.width}×${e.height}`);
      if (e.steps) parts.push(`draw_diagram diagram${e.steps.total > 1 ? `, step ${e.steps.shown} of ${e.steps.total} shown` : ""}`);
      break;
    case "arrow":
    case "line": {
      parts.push(`${e.type} (id ${e.id})`);
      if (e.startId || e.endId) parts.push(connection(e, all));
      else if (e.points?.length) parts.push(`from (${e.x}, ${e.y}) to (${e.x + e.points.at(-1)![0]}, ${e.y + e.points.at(-1)![1]})`);
      if (e.label) parts.push(`labeled "${e.label}"`);
      break;
    }
    case "text":
      parts.push(`text "${e.text ?? ""}" (id ${e.id}) at (${e.x}, ${e.y})${e.fontSize ? ` size ${e.fontSize}` : ""}`);
      break;
    case "freedraw": {
      parts.push(`freehand stroke (id ${e.id}) covering (${e.x}, ${e.y}) ${e.width}×${e.height}`);
      const near = nearestLabeled(e, all);
      if (near) parts.push(`near ${name(near, all)}`);
      break;
    }
    default:
      // Diagram parts are placed by the layout, so their coordinates and colors are noise.
      parts.push(`${e.type}${e.label ? ` "${e.label}"` : ""} (id ${e.id})${e.diagram ? "" : ` at (${e.x}, ${e.y}) ${e.width}×${e.height}`}`);
  }
  const colors = e.diagram && e.byClaude ? [] : [e.backgroundColor && `fill ${e.backgroundColor}`, e.strokeColor && `stroke ${e.strokeColor}`];
  const style = [...colors, e.strokeStyle].filter(Boolean);
  if (style.length) parts.push(style.join(", "));
  if (e.link) parts.push(`link ${e.link}`);
  if (!e.byClaude) parts.push("[user]");
  return parts.join(" · ");
}

function name(e: SlimElement & { label?: string }, all: Snapshot): string {
  const text = e.type === "frame" || e.type === "magicframe" ? e.name : e.label ?? e.text;
  if (e.type === "arrow" || e.type === "line") return `${e.type} ${connection(e, all)} (id ${e.id})`;
  return `${e.type}${text ? ` "${text}"` : ""} (id ${e.id})`;
}

function connection(e: SlimElement, all: Snapshot): string {
  const end = (id?: string) => {
    if (!id) return "nothing";
    const target = all.get(id);
    const text = target?.label ?? target?.text ?? target?.name;
    return text ? `"${text}"` : id;
  };
  return `${end(e.startId)} → ${end(e.endId)}`;
}

function nearestLabeled(e: SlimElement, all: Snapshot) {
  const cx = e.x + e.width / 2;
  const cy = e.y + e.height / 2;
  let best: (SlimElement & { label?: string }) | undefined;
  let bestDistance = 250;
  for (const other of all.values()) {
    if (other.id === e.id || !(other.label || other.text || other.name)) continue;
    const distance = Math.hypot(other.x + other.width / 2 - cx, other.y + other.height / 2 - cy);
    if (distance < bestDistance) {
      best = other;
      bestDistance = distance;
    }
  }
  return best;
}

function signed(n: number) {
  return n > 0 ? `+${n}` : String(n);
}
