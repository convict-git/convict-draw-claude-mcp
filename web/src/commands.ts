// Commands the board server asks this tab to run. Everything that needs Excalidraw's own
// logic (text measurement, bindings, Mermaid layout, image export) happens here, because the
// Excalidraw package only runs in a browser.
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  elementsOverlappingBBox,
  exportToBlob,
  getCommonBounds,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  AnimateArgs,
  AnimateResult,
  DiagramArgs,
  DiagramResult,
  DrawArgs,
  DrawResult,
  ImageArgs,
  ImageResult,
  MermaidArgs,
  MermaidResult,
  PointArgs,
  PointResult,
  SceneSnapshot,
  SlimElement,
  TabCommand,
  ViewArgs,
} from "../../shared/protocol";
import { buildAnimation, closeAnimation, serializeAnimation, showAnimation } from "./animate";
import { diagramSteps, planDiagram } from "./diagram";
import { hideLaser, pointAt, type Bounds, type LaserStep } from "./laser";
import { checkLayout } from "./lint";
import { textWidth } from "./measure";

type Api = ExcalidrawImperativeAPI;
// Excalidraw's element types are branded and readonly; this bridge works with plain objects.
type El = any;

// Fields Claude may change on an existing element through `draw`.
const UPDATABLE_FIELDS = [
  "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth",
  "strokeStyle", "roughness", "opacity", "roundness", "text", "fontSize", "fontFamily", "textAlign",
  "verticalAlign", "points", "startArrowhead", "endArrowhead", "elbowed", "frameId", "groupIds", "locked", "link", "name",
];
/** How long the view rests on a new spot before drawing starts there, so the user sees where it happens. */
const CAMERA_SETTLE_MS = 300;
/** How long the laser rests on each new element when a drawing call asks to point at what it drew. */
const POINT_NEW_MS = 1200;

interface DrawOptions {
  /** Area to bring into view before drawing (default: the new elements and what they attach to). */
  focus?: Bounds;
  /** Elements to point at after drawing, in order (default with `point`: the new elements). */
  pointIds?: string[];
}
const LABEL_FIELDS = ["fontSize", "fontFamily", "strokeColor", "textAlign", "verticalAlign", "opacity"];
/** Pseudo-elements that arrange existing elements instead of drawing one. */
const ARRANGE_OPS = new Set(["group", "ungroup", "align", "distribute", "order"]);

export async function runCommand(api: Api, command: TabCommand, args: any): Promise<unknown> {
  // Changes to the board or the view should be visible, so they close the animation player.
  if (command !== "scene" && command !== "image" && command !== "animate") closeAnimation();
  switch (command) {
    case "draw":
      return draw(api, args);
    case "diagram":
      return diagram(api, args);
    case "mermaid":
      return mermaid(api, args);
    case "scene":
      return scene(api, args ?? {});
    case "image":
      return image(api, args);
    case "view":
      return view(api, args);
    case "clear":
      return clear(api);
    case "animate":
      return animate(api, args ?? {});
    case "point":
      return point(api, args ?? {});
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// draw: create, update (by existing id), delete, and move the camera
// ---------------------------------------------------------------------------

async function draw(api: Api, { elements, placement = "as_given", point: pointNew = false }: DrawArgs, options: DrawOptions = {}): Promise<DrawResult> {
  if (!Array.isArray(elements)) throw new Error("`elements` must be an array of element objects");
  await fontsReady();

  const current = api.getSceneElementsIncludingDeleted() as readonly El[];
  const live = new Map(current.filter((e) => !e.isDeleted).map((e) => [e.id, e]));
  const warnings: string[] = [];

  let camera: El | null = null;
  const deleteIds: string[] = [];
  const patches: El[] = [];
  const skeletons: El[] = [];
  const arrangements: El[] = [];
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as El;
    if (el.type === "cameraUpdate") camera = el;
    else if (ARRANGE_OPS.has(el.type)) arrangements.push(el);
    else if (el.type === "delete") deleteIds.push(...splitIds(el.ids ?? el.id));
    else if (typeof el.id === "string" && live.has(el.id)) patches.push(el);
    else if (!el.type) warnings.push(`no element with id "${el.id}" to update (to create one, include "type")`);
    else skeletons.push(el);
  }

  // Existing elements are replaced with new versions (never mutated), so undo and change tracking work.
  const changed = new Map<string, El>();
  const get = (id: string): El | undefined => changed.get(id) ?? live.get(id);
  const put = (id: string, updates: Record<string, unknown>, force = false) => {
    const base = get(id);
    if (base) changed.set(id, newElementWith(base, updates as never, force));
  };
  const recenter = new Set<string>();
  const extraCreated: El[] = [];
  const rebinds: { arrowId: string; side: "startBinding" | "endBinding"; binding: El }[] = [];

  // Deletes (a shape's label goes with it)
  const deleted: string[] = [];
  for (const id of deleteIds) {
    const el = get(id);
    if (!el) {
      warnings.push(`delete: no element with id "${id}"`);
      continue;
    }
    put(id, { isDeleted: true });
    deleted.push(id);
    for (const b of el.boundElements ?? []) if (b.type === "text") put(b.id, { isDeleted: true });
  }

  // Updates to existing elements
  const updated: string[] = [];
  for (const patch of patches) {
    const before = get(patch.id);
    if (!before || before.isDeleted) continue;
    if (patch.type && patch.type !== before.type) {
      warnings.push(`"${patch.id}" is a ${before.type}, not a ${patch.type}. To change its type, delete it and create a new element with a new id.`);
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const key of UPDATABLE_FIELDS) if (patch[key] !== undefined) fields[key] = patch[key];
    if (typeof fields.text === "string") fields.originalText = fields.text;
    if (Array.isArray(fields.points)) Object.assign(fields, pointsSize(fields.points as number[][]));
    if (patch.customData && typeof patch.customData === "object") fields.customData = { ...before.customData, ...patch.customData };
    for (const side of ["startBinding", "endBinding"] as const) {
      if (patch[side]?.elementId && (before.type === "arrow" || before.type === "line")) rebinds.push({ arrowId: patch.id, side, binding: patch[side] });
    }
    if (Object.keys(fields).length) put(patch.id, fields);

    if (patch.label && typeof patch.label === "object") {
      const labelId = boundTextId(get(patch.id));
      if (labelId && get(labelId) && !get(labelId).isDeleted) {
        const labelFields: Record<string, unknown> = {};
        if (typeof patch.label.text === "string") {
          labelFields.text = patch.label.text;
          labelFields.originalText = patch.label.text;
        }
        for (const key of LABEL_FIELDS) if (patch.label[key] !== undefined) labelFields[key] = patch.label[key];
        const host = get(patch.id);
        const needed = minLabelWidth(host.type, { fontSize: get(labelId).fontSize, ...patch.label });
        if (host.type !== "arrow" && host.type !== "line" && needed > host.width) {
          put(patch.id, { x: host.x - (needed - host.width) / 2, width: needed });
        }
        put(labelId, labelFields);
      } else if (typeof patch.label.text === "string") {
        // No label yet: let Excalidraw build a measured label on a stand-in shape, then attach it.
        const host = get(patch.id);
        const standIn = convertToExcalidrawElements(
          [{ ...geometry(host), type: host.type, id: "__label_host__", label: labelDefaults(patch.label) }] as never,
          { regenerateIds: false },
        ) as El[];
        const text = standIn.find((e) => e.type === "text");
        if (text) {
          extraCreated.push({ ...text, containerId: host.id, frameId: host.frameId ?? null });
          put(patch.id, { boundElements: [...(host.boundElements ?? []), { type: "text", id: text.id }] });
        }
      }
      recenter.add(patch.id);
    }

    let after = get(patch.id);
    if (after.frameId && patch.frameId === undefined && (after.x !== before.x || after.y !== before.y)) {
      const frame = get(after.frameId);
      if (frame && !overlaps(after, frame)) {
        put(patch.id, { frameId: null });
        after = get(patch.id);
      }
    }
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    if (dx || dy) moveAttachments(after, dx, dy, get, put, recenter);
    if (dx || dy || after.width !== before.width || after.height !== before.height) recenter.add(patch.id);
    updated.push(patch.id);
  }

  // New elements
  const created = createElements(skeletons, get, put, warnings, recenter);
  created.push(...extraCreated);
  rebind(rebinds, created, get, put, warnings);
  let offset: { dx: number; dy: number } | undefined;
  if (placement !== "as_given" && created.length) {
    offset = placementOffset(created, [...live.values()].filter((e) => !deleteIds.includes(e.id)), placement);
    for (const e of created) {
      e.x += offset.dx;
      e.y += offset.dy;
    }
    if (camera) camera = { ...camera, x: camera.x + offset.dx, y: camera.y + offset.dy };
  }
  for (const e of created) e.customData = { ...(e.customData ?? {}), createdBy: "claude" };
  const { layerMoves, arranged } = arrange(arrangements, created, get, put, recenter, warnings);
  for (const id of arranged) if (live.has(id) && !updated.includes(id)) updated.push(id);

  // Merge, let Excalidraw repair bindings and re-measure text, then apply as one undo step.
  // A new element that reuses a deleted element's id replaces it, with a higher version.
  const createdIds = new Set(created.map((e) => e.id));
  for (const e of created) {
    const tombstone = current.find((c) => c.id === e.id);
    if (tombstone) e.version = Math.max(e.version ?? 1, tombstone.version + 1);
  }
  const all = [...current.filter((e) => !createdIds.has(e.id)).map((e) => changed.get(e.id) ?? e), ...created];
  const touched = new Set([...changed.keys(), ...created.map((e) => e.id)]);
  const restored = new Map(
    (restoreElements(all as never, current as never, { repairBindings: true, refreshDimensions: true }) as El[]).map((e) => [e.id, e]),
  );
  let next: El[] = all.map((e) => (touched.has(e.id) ? restored.get(e.id) ?? e : e));
  next = centerLabels(next, recenter);
  next = reorder(next, layerMoves);

  // Move the view first, so the user watches the drawing appear instead of being taken to it afterwards.
  const visibleCreated = created.filter((e) => !e.containerId);
  const focus = options.focus ?? focusArea(next, new Set(visibleCreated.map((e) => e.id)));
  let cameraMoved = false;
  if (camera) {
    applyCamera(api, camera);
    cameraMoved = true;
  } else if (focus && !boundsInViewport(api, focus)) {
    fitBounds(api, focus, 1);
    cameraMoved = true;
  }
  if (cameraMoved && visibleCreated.length) await sleep(CAMERA_SETTLE_MS);
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  for (const e of next) if (touched.has(e.id) && e.containerId) touched.add(e.containerId);
  warnings.push(...checkLayout(next, touched));

  const parts = [
    visibleCreated.length && `drew ${visibleCreated.length}`,
    updated.length && `updated ${updated.length}`,
    deleted.length && `removed ${deleted.length}`,
  ].filter(Boolean);
  if (parts.length) api.setToast({ message: `Claude ${parts.join(", ")}`, duration: 2000 });

  const pointIds = options.pointIds ?? (pointNew ? visibleCreated.filter((e) => e.type !== "frame").map((e) => e.id) : []);
  if (pointIds.length) point(api, { ids: pointIds, ms: POINT_NEW_MS });

  return {
    created: visibleCreated.map((e) => e.id),
    updated,
    deleted,
    touched: [...touched],
    warnings,
    scene: scene(api, { quiet: true }),
    ...(offset && (offset.dx || offset.dy) ? { offset: { dx: Math.round(offset.dx), dy: Math.round(offset.dy) } } : {}),
  };
}

/**
 * Grouping, alignment, and spacing, applied to new and existing elements alike. Returns the layer
 * moves, which are applied once the full element list is known.
 */
function arrange(
  ops: El[],
  created: El[],
  get: (id: string) => El | undefined,
  put: (id: string, updates: Record<string, unknown>) => void,
  recenter: Set<string>,
  warnings: string[],
): { layerMoves: { ids: string[]; to: "front" | "back" }[]; arranged: Set<string> } {
  const arranged = new Set<string>();
  const createdById = new Map(created.map((e) => [e.id, e]));
  const find = (id: string) => createdById.get(id) ?? get(id);
  const set = (id: string, fields: Record<string, unknown>) => {
    const own = createdById.get(id);
    if (own) Object.assign(own, fields);
    else put(id, fields);
  };
  const shift = (id: string, dx: number, dy: number) => {
    if (!dx && !dy) return;
    const el = find(id);
    set(id, { x: el.x + dx, y: el.y + dy });
    moveAttachments(el, dx, dy, find, set, recenter);
    recenter.add(id);
  };
  const labelOf = (id: string) => [...createdById.values()].find((e) => e.containerId === id)?.id ?? boundTextId(find(id));
  const layerMoves: { ids: string[]; to: "front" | "back" }[] = [];

  for (const op of ops) {
    const ids = splitIds(op.ids).filter((id) => {
      if (find(id) && !find(id).isDeleted) return true;
      warnings.push(`${op.type}: no element with id "${id}"`);
      return false;
    });
    if (!ids.length) continue;
    for (const id of ids) arranged.add(id);
    const els = ids.map(find);
    switch (op.type) {
      case "group": {
        const groupId = `group_${Math.random().toString(36).slice(2, 10)}`;
        for (const id of ids) for (const part of [id, labelOf(id)].filter(Boolean) as string[]) set(part, { groupIds: [...(find(part).groupIds ?? []), groupId] });
        break;
      }
      case "ungroup":
        for (const id of ids) for (const part of [id, labelOf(id)].filter(Boolean) as string[]) set(part, { groupIds: [] });
        break;
      case "align": {
        // Excalidraw caches bounds per element version, and new elements may have just been moved; measure directly.
        const minX = Math.min(...els.map((e) => e.x));
        const minY = Math.min(...els.map((e) => e.y));
        const maxX = Math.max(...els.map((e) => e.x + e.width));
        const maxY = Math.max(...els.map((e) => e.y + e.height));
        for (const e of els) {
          const dx = { left: minX - e.x, center: (minX + maxX) / 2 - (e.x + e.width / 2), right: maxX - (e.x + e.width) }[op.to as string] ?? 0;
          const dy = { top: minY - e.y, middle: (minY + maxY) / 2 - (e.y + e.height / 2), bottom: maxY - (e.y + e.height) }[op.to as string] ?? 0;
          shift(e.id, dx, dy);
        }
        if (!["left", "center", "right", "top", "middle", "bottom"].includes(op.to)) warnings.push(`align: "to" must be left, center, right, top, middle, or bottom`);
        break;
      }
      case "distribute": {
        if (els.length < 3) break;
        const horizontal = op.axis !== "vertical";
        const [pos, size] = horizontal ? (["x", "width"] as const) : (["y", "height"] as const);
        const sorted = [...els].sort((a, b) => a[pos] - b[pos]);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const gap = (last[pos] + last[size] - first[pos] - sorted.reduce((sum, e) => sum + e[size], 0)) / (sorted.length - 1);
        let cursor = first[pos] + first[size] + gap;
        for (const e of sorted.slice(1, -1)) {
          shift(e.id, horizontal ? cursor - e.x : 0, horizontal ? 0 : cursor - e.y);
          cursor += e[size] + gap;
        }
        break;
      }
      case "order":
        layerMoves.push({ ids: ids.flatMap((id) => [id, labelOf(id)].filter(Boolean) as string[]), to: op.to === "front" ? "front" : "back" });
        break;
    }
  }
  return { layerMoves, arranged };
}

/** Bring elements to the front or send them to the back, keeping their order among themselves. */
function reorder(elements: El[], moves: { ids: string[]; to: "front" | "back" }[]): El[] {
  let list = elements;
  for (const { ids, to } of moves) {
    const wanted = new Set(ids);
    const moving = ids.map((id) => list.find((e) => e.id === id)).filter(Boolean);
    const rest = list.filter((e) => !wanted.has(e.id));
    list = to === "front" ? [...rest, ...moving] : [...moving, ...rest];
  }
  return list;
}

/** Bindings changed on existing arrows: keep the shapes' lists of attached arrows in step. */
function rebind(
  rebinds: { arrowId: string; side: "startBinding" | "endBinding"; binding: El }[],
  created: El[],
  get: (id: string) => El | undefined,
  put: (id: string, updates: Record<string, unknown>) => void,
  warnings: string[],
) {
  const createdById = new Map(created.map((e) => [e.id, e]));
  for (const { arrowId, side, binding } of rebinds) {
    const arrow = get(arrowId);
    const target = createdById.get(binding.elementId) ?? get(binding.elementId);
    if (!arrow || !target) {
      warnings.push(`arrow "${arrowId}": element "${binding.elementId}" not found`);
      continue;
    }
    const previous = arrow[side]?.elementId;
    const other = side === "startBinding" ? arrow.endBinding?.elementId : arrow.startBinding?.elementId;
    if (previous && previous !== target.id && previous !== other) {
      const old = get(previous);
      if (old) put(previous, { boundElements: (old.boundElements ?? []).filter((b: El) => b.id !== arrowId) });
    }
    put(arrowId, { [side]: { focus: 0, gap: 4, ...binding } });
    const attached = (target.boundElements ?? []).some((b: El) => b.id === arrowId);
    if (attached) continue;
    const boundElements = [...(target.boundElements ?? []), { type: "arrow", id: arrowId }];
    if (createdById.has(target.id)) target.boundElements = boundElements;
    else put(target.id, { boundElements });
  }
}

/** The new elements plus what gives them context: the frame they're in and the shapes their arrows connect. */
function focusArea(elements: El[], createdIds: Set<string>): Bounds | undefined {
  if (!createdIds.size) return undefined;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const area = new Map<string, El>();
  for (const id of createdIds) {
    const e = byId.get(id);
    if (!e) continue;
    area.set(id, e);
    for (const related of [e.frameId, e.startBinding?.elementId, e.endBinding?.elementId]) {
      if (related && byId.has(related)) area.set(related, byId.get(related));
    }
  }
  return area.size ? (getCommonBounds([...area.values()] as never) as Bounds) : undefined;
}

// ---------------------------------------------------------------------------
// diagram: automatic layout, drawn through `draw`
// ---------------------------------------------------------------------------

async function diagram(api: Api, args: DiagramArgs): Promise<DiagramResult> {
  await fontsReady();
  const plan = await planDiagram(api, args);
  const f = plan.frame;
  const result = await draw(
    api,
    { elements: plan.elements },
    { focus: [f.x, f.y, f.x + f.width, f.y + f.height], pointIds: args.point ? plan.revealed : [] },
  );
  return {
    ...result,
    warnings: [...plan.warnings, ...result.warnings],
    frame: f,
    nodeCount: plan.nodeCount,
    edgeCount: plan.edgeCount,
    steps: plan.steps,
  };
}

function createElements(
  skeletons: El[],
  get: (id: string) => El | undefined,
  put: (id: string, updates: Record<string, unknown>, force?: boolean) => void,
  warnings: string[],
  recenter: Set<string>,
): El[] {
  if (!skeletons.length) return [];

  // Arrows are connected after conversion: the converter only resolves ids inside the same batch and
  // expects the arrow to be positioned already, while Claude may connect to shapes already on the board.
  const externalEnds = new Map<string, { start?: string; end?: string; fixedStart?: number[]; fixedEnd?: number[] }>();
  const prepared = skeletons.map((s, i) => {
    const out: El = { ...s, id: s.id ?? `claude_${Date.now().toString(36)}_${i}` };
    if (out.label && typeof out.label === "object") {
      out.label = labelDefaults(out.label);
      const needed = minLabelWidth(out.type, out.label);
      if (typeof out.width === "number" && out.type !== "arrow" && out.type !== "line" && needed > out.width) {
        if (typeof out.x === "number") out.x -= (needed - out.width) / 2;
        out.width = needed;
      }
    }
    if (out.type === "frame" || out.type === "magicframe") out.children = out.children ?? [];
    if (out.type === "arrow" || out.type === "line") {
      const ends: { start?: string; end?: string; fixedStart?: number[]; fixedEnd?: number[] } = {};
      const startId = out.start?.id ?? out.startBinding?.elementId;
      const endId = out.end?.id ?? out.endBinding?.elementId;
      if (typeof startId === "string" && !out.start?.type) {
        delete out.start;
        ends.start = startId;
      }
      if (typeof endId === "string" && !out.end?.type) {
        delete out.end;
        ends.end = endId;
      }
      ends.fixedStart = out.startBinding?.fixedPoint;
      ends.fixedEnd = out.endBinding?.fixedPoint;
      delete out.startBinding;
      delete out.endBinding;
      if (ends.start || ends.end) externalEnds.set(out.id, ends);
    }
    return out;
  });

  const converted = convertToExcalidrawElements(prepared as never, { regenerateIds: false }) as El[];
  const byId = new Map(converted.map((e) => [e.id, e]));
  const lookup = (id: string) => byId.get(id) ?? get(id);

  for (const e of converted) {
    const source = prepared.find((p) => p.id === e.id);
    // Keep the frame geometry Claude asked for (the converter treats 0 as "unset").
    if (source && (e.type === "frame" || e.type === "magicframe")) {
      for (const key of ["x", "y", "width", "height"]) if (typeof source[key] === "number") e[key] = source[key];
    }
    if (source?.frameId && lookup(source.frameId)) e.frameId = source.frameId;
    if (e.type === "text" && e.containerId) e.frameId = lookup(e.containerId)?.frameId ?? e.frameId ?? null;
  }

  for (const [arrowId, ends] of externalEnds) {
    const arrow = byId.get(arrowId);
    if (!arrow) continue;
    const start = ends.start ? lookup(ends.start) : undefined;
    const end = ends.end ? lookup(ends.end) : undefined;
    if (ends.start && !start) warnings.push(`arrow "${arrowId}": start element "${ends.start}" not found`);
    if (ends.end && !end) warnings.push(`arrow "${arrowId}": end element "${ends.end}" not found`);
    const source = prepared.find((p) => p.id === arrowId);
    if (start && end && !Array.isArray(source?.points)) {
      const fixed = routeArrow(arrow, start, end);
      if (fixed) {
        ends.fixedStart ??= fixed[0];
        ends.fixedEnd ??= fixed[1];
      }
    }
    recenter.add(arrowId);
    for (const [side, target, fixedPoint] of [
      ["startBinding", start, ends.fixedStart],
      ["endBinding", end, ends.fixedEnd],
    ] as const) {
      if (!target || arrow.type !== "arrow") continue;
      arrow[side] = { elementId: target.id, focus: 0, gap: 4, ...(fixedPoint ? { fixedPoint } : {}) };
      const boundElements = [...(target.boundElements ?? []), { type: "arrow", id: arrow.id }];
      if (byId.has(target.id)) target.boundElements = boundElements;
      else put(target.id, { boundElements });
    }
  }

  return converted;
}

function moveAttachments(
  el: El,
  dx: number,
  dy: number,
  get: (id: string) => El | undefined,
  put: (id: string, updates: Record<string, unknown>) => void,
  recenter: Set<string>,
) {
  for (const b of el.boundElements ?? []) {
    const other = get(b.id);
    if (!other || other.isDeleted) continue;
    if (b.type === "text") {
      put(b.id, { x: other.x + dx, y: other.y + dy });
    } else if (b.type === "arrow" && Array.isArray(other.points)) {
      const points = other.points.map((p: number[]) => [p[0], p[1]]);
      let { x, y } = other;
      if (other.startBinding?.elementId === el.id) {
        x += dx;
        y += dy;
        for (let i = 1; i < points.length; i++) {
          points[i][0] -= dx;
          points[i][1] -= dy;
        }
      }
      if (other.endBinding?.elementId === el.id) {
        points[points.length - 1][0] += dx;
        points[points.length - 1][1] += dy;
      }
      put(b.id, { x, y, points, ...pointsSize(points) });
      recenter.add(b.id);
    }
  }
}

/** Position each touched container's label, growing the container if the text doesn't fit. */
function centerLabels(elements: El[], containerIds: Set<string>): El[] {
  if (!containerIds.size) return elements;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const replace = new Map<string, El>();
  for (const id of containerIds) {
    let container = byId.get(id);
    const labelId = container && boundTextId(container);
    const label = labelId && byId.get(labelId);
    if (!container || !label || container.isDeleted) continue;
    if (container.type === "arrow" || container.type === "line") {
      const [mx, my] = polylineMiddle(container.points);
      replace.set(label.id, newElementWith(label, { x: container.x + mx - label.width / 2, y: container.y + my - label.height / 2 } as never, true));
      continue;
    }
    const minHeight = label.height + 20;
    if (container.height < minHeight) {
      container = newElementWith(container, { height: minHeight } as never);
      replace.set(container.id, container);
    }
    // Same placement as Excalidraw: 5px padding for labels aligned to an edge.
    const x = label.textAlign === "left" ? container.x + 5 : label.textAlign === "right" ? container.x + container.width - 5 - label.width : container.x + (container.width - label.width) / 2;
    const y = label.verticalAlign === "top" ? container.y + 5 : label.verticalAlign === "bottom" ? container.y + container.height - 5 - label.height : container.y + (container.height - label.height) / 2;
    replace.set(label.id, newElementWith(label, { x, y } as never, true));
  }
  return elements.map((e) => replace.get(e.id) ?? e);
}

/** Where Excalidraw puts an arrow's label: the middle point, or the middle of the middle segment. */
function polylineMiddle(points: number[][]): [number, number] {
  const n = points.length;
  if (n % 2 === 1) return [points[(n - 1) / 2][0], points[(n - 1) / 2][1]];
  const a = points[n / 2 - 1];
  const b = points[n / 2];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Smallest shape width whose label can fit its longest word on one line. */
function minLabelWidth(type: string, label: El): number {
  if (typeof label?.text !== "string" || !label.text.trim()) return 0;
  const longest = Math.max(...label.text.split(/\s+/).map((word: string) => textWidth(word, label.fontSize ?? 20)));
  const inner = longest + 16; // Excalidraw pads bound text by 5px per side; keep a little slack
  if (type === "ellipse") return Math.ceil(inner * Math.SQRT2 + 4);
  if (type === "diamond") return Math.ceil(inner * 2 + 4);
  return Math.ceil(inner + 4);
}

/**
 * Points for an arrow between two shapes: a right-angle path for elbow arrows (which also need the
 * attachment points, returned as fractions of each shape), a gentle bend for curved arrows, and a
 * straight line otherwise.
 */
function routeArrow(arrow: El, start: El, end: El): [number[], number[]] | undefined {
  const from = center(start);
  const to = center(end);
  let path: number[][];
  let fixed: [number[], number[]] | undefined;
  if (arrow.elbowed) {
    // Leave from the sides facing each other, along whichever axis separates the shapes more.
    const gapX = Math.max(start.x - (end.x + end.width), end.x - (start.x + start.width));
    const gapY = Math.max(start.y - (end.y + end.height), end.y - (start.y + start.height));
    const gap = 6;
    if (gapX >= gapY) {
      const dir = to[0] >= from[0] ? 1 : -1;
      const a = [dir > 0 ? start.x + start.width + gap : start.x - gap, from[1]];
      const b = [dir > 0 ? end.x - gap : end.x + end.width + gap, to[1]];
      const midX = (a[0] + b[0]) / 2;
      path = a[1] === b[1] ? [a, b] : [a, [midX, a[1]], [midX, b[1]], b];
      fixed = [[dir > 0 ? 1 : 0, 0.5], [dir > 0 ? 0 : 1, 0.5]];
    } else {
      const dir = to[1] >= from[1] ? 1 : -1;
      const a = [from[0], dir > 0 ? start.y + start.height + gap : start.y - gap];
      const b = [to[0], dir > 0 ? end.y - gap : end.y + end.height + gap];
      const midY = (a[1] + b[1]) / 2;
      path = a[0] === b[0] ? [a, b] : [a, [a[0], midY], [b[0], midY], b];
      fixed = [[0.5, dir > 0 ? 1 : 0], [0.5, dir > 0 ? 0 : 1]];
    }
  } else {
    const a = edgePoint(start, to);
    const b = edgePoint(end, from);
    path = [a, b];
    if (arrow.roundness?.type === 2) {
      // Bow the middle out by a sixth of the length, so parallel arrows between the same shapes don't coincide.
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const bow = length / 6;
      path = [a, [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / length) * bow, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / length) * bow], b];
    }
  }
  arrow.x = path[0][0];
  arrow.y = path[0][1];
  arrow.points = path.map((p) => [p[0] - path[0][0], p[1] - path[0][1]]);
  Object.assign(arrow, pointsSize(arrow.points));
  return fixed;
}

// ---------------------------------------------------------------------------
// mermaid
// ---------------------------------------------------------------------------

async function mermaid(api: Api, { definition, x, y }: MermaidArgs): Promise<MermaidResult> {
  await fontsReady();
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const { elements: skeletons, files } = await parseMermaidToExcalidraw(definition, {
    themeVariables: { fontSize: "20px" },
  });
  const created = convertToExcalidrawElements(skeletons as never, { regenerateIds: true }) as El[];
  if (!created.length) throw new Error("Mermaid produced no elements");

  const existing = api.getSceneElements() as readonly El[];
  const [minX, minY, maxX, maxY] = getCommonBounds(created as never);
  let dx = 0;
  let dy = 0;
  if (typeof x === "number" && typeof y === "number") {
    dx = x - minX;
    dy = y - minY;
  } else if (existing.length) {
    const offset = placementOffset(created, existing, "right_of_existing");
    dx = offset.dx;
    dy = offset.dy;
  }
  for (const e of created) {
    e.x += dx;
    e.y += dy;
    e.customData = { ...(e.customData ?? {}), createdBy: "claude" };
  }
  if (files) api.addFiles(Object.values(files) as never);
  const area: Bounds = [minX + dx, minY + dy, maxX + dx, maxY + dy];
  if (!boundsInViewport(api, area)) {
    fitBounds(api, area, 1);
    await sleep(CAMERA_SETTLE_MS);
  }
  api.updateScene({
    elements: [...(api.getSceneElementsIncludingDeleted() as readonly El[]), ...created],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  api.setToast({ message: "Claude drew a diagram", duration: 2000 });

  return {
    created: created.filter((e) => !e.containerId).map((e) => e.id),
    touched: created.map((e) => e.id),
    scene: scene(api, { quiet: true }),
    bounds: { x: round(minX + dx), y: round(minY + dy), width: round(maxX - minX), height: round(maxY - minY) },
    editable: !created.some((e) => e.type === "image"),
  };
}

// ---------------------------------------------------------------------------
// scene / image / view / clear
// ---------------------------------------------------------------------------

function scene(api: Api, { quiet = false }: { quiet?: boolean }): SceneSnapshot {
  const state = api.getAppState();
  const elements = (api.getSceneElements() as readonly El[]).map(slim);
  if (!quiet) showActivity(api, "Claude looked at the board");
  return {
    elements,
    selectedIds: Object.keys(state.selectedElementIds).filter((id) => state.selectedElementIds[id]),
    editingTextId: (state as El).editingTextElement?.id ?? null,
    viewport: currentViewport(api),
  };
}

async function image(api: Api, { area = "all" }: ImageArgs): Promise<ImageResult> {
  const state = api.getAppState();
  let elements = api.getSceneElements() as readonly El[];
  if (area === "selection") {
    const selected = new Set(Object.keys(state.selectedElementIds).filter((id) => state.selectedElementIds[id]));
    elements = elements.filter((e) => selected.has(e.id) || (e.containerId && selected.has(e.containerId)));
  } else if (area === "viewport") {
    const v = currentViewport(api);
    elements = elementsOverlappingBBox({
      elements: elements as never,
      bounds: [v.x, v.y, v.x + v.width, v.y + v.height],
      type: "overlap",
    }) as El[];
  }
  if (!elements.length) throw new Error(`There's nothing to show (${area} is empty)`);

  const blob = await exportToBlob({
    elements: elements as never,
    appState: { ...state, exportBackground: true, exportWithDarkMode: false },
    files: api.getFiles(),
    mimeType: "image/png",
    maxWidthOrHeight: 1200,
    exportPadding: 24,
  });
  showActivity(api, "Claude looked at the board");
  return { base64: await blobToBase64(blob), mimeType: "image/png" };
}

// View changes go through React state, so getAppState() is stale right after them;
// these functions return the viewport they set instead of reading it back.
function view(api: Api, args: ViewArgs) {
  const { fit, ids, x, y, width, height, zoom } = args;
  if (typeof x === "number" && typeof y === "number" && typeof width === "number" && typeof height === "number") {
    return applyCamera(api, { x, y, width, height });
  }
  const all = api.getSceneElements() as readonly El[];
  let targets: readonly El[] = [];
  if (ids?.length) targets = all.filter((e) => ids.includes(e.id) || (e.containerId && ids.includes(e.containerId)));
  else if (fit === "selection") {
    const selected = api.getAppState().selectedElementIds;
    targets = all.filter((e) => selected[e.id]);
  } else if (fit === "all") targets = all;

  if (targets.length && typeof zoom !== "number") return fitElements(api, targets, 2);
  if (typeof zoom === "number") return setZoom(api, zoom, targets.length ? boundsCenter(targets) : viewportCenter(api));
  return currentViewport(api);
}

function clear(api: Api) {
  hideLaser(api);
  const elements = api.getSceneElementsIncludingDeleted() as readonly El[];
  const count = elements.filter((e) => !e.isDeleted).length;
  api.updateScene({
    elements: elements.map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true } as never))),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  api.setToast({ message: "Claude cleared the board (Ctrl+Z to undo)", duration: 3000 });
  return { removed: count };
}

async function animate(api: Api, args: AnimateArgs): Promise<AnimateResult> {
  await fontsReady();
  const { animation, elementCount, warnings } = await buildAnimation(api, args);
  showAnimation(animation);
  return {
    elementCount,
    durationMs: Math.round(animation.finishedMs - animation.startMs),
    warnings,
    ...(args.includeSvg ? { svg: serializeAnimation(animation) } : {}),
  };
}

const DEFAULT_POINT_MS = 2500;

function point(api: Api, { ids = [], together = false, x, y, ms = DEFAULT_POINT_MS, gesture = "auto", hide = false }: PointArgs): PointResult {
  if (hide) {
    hideLaser(api);
    return { targets: [], durationMs: 0, warnings: [] };
  }
  const all = api.getSceneElements() as readonly El[];
  const byId = new Map(all.map((e) => [e.id, e]));
  const warnings: string[] = [];
  const steps: LaserStep[] = [];
  const targets: string[] = [];
  const stepMs = clamp(ms, 300, 20_000);

  // A label stands for its shape; a shape's bounds include its label.
  const resolve = (id: string): El | undefined => {
    const el = byId.get(id);
    if (!el) warnings.push(`no element with id "${id}"`);
    return el?.containerId && byId.has(el.containerId) ? byId.get(el.containerId) : el;
  };
  const withLabels = (els: El[]) => all.filter((e) => els.some((el) => e.id === el.id || e.containerId === el.id));

  if (typeof x === "number" && typeof y === "number") {
    steps.push({ bounds: [x, y, x, y], gesture: gesture === "auto" ? "dot" : gesture, ms: stepMs });
    targets.push(`(${round(x)}, ${round(y)})`);
  }
  const elements = [...new Set(ids.map(resolve).filter(Boolean))] as El[];
  if (together && elements.length) {
    steps.push({ bounds: getCommonBounds(withLabels(elements) as never) as Bounds, gesture: gesture === "auto" ? "circle" : gesture, ms: stepMs });
    targets.push(elements.map((e) => e.id).join(" + "));
  } else {
    for (const el of elements) {
      const linear = el.type === "arrow" || el.type === "line";
      const auto = linear ? "trace" : el.type === "text" ? "underline" : "circle";
      steps.push({
        bounds: getCommonBounds(withLabels([el]) as never) as Bounds,
        gesture: gesture === "auto" ? auto : gesture,
        path: linear ? el.points.map((p: number[]) => [el.x + p[0], el.y + p[1]]) : undefined,
        ms: stepMs,
      });
      targets.push(el.id);
    }
  }
  if (!steps.length) throw new Error(warnings.length ? warnings.join("; ") : "Nothing to point at: pass ids, or x and y.");

  void pointAt(api, steps, (bounds) => reveal(api, bounds));
  return { targets, durationMs: steps.length * stepMs, warnings };
}

/** Scroll so the area is on screen, zooming out only if it doesn't fit. Returns the zoom. */
function reveal(api: Api, [minX, minY, maxX, maxY]: Bounds) {
  const v = currentViewport(api);
  const margin = 60 / v.zoom;
  const inView = minX - margin >= v.x && minY - margin >= v.y && maxX + margin <= v.x + v.width && maxY + margin <= v.y + v.height;
  if (inView) return v.zoom;
  const state = api.getAppState();
  const zoom = Math.min(v.zoom, (state.width * 0.8) / Math.max(maxX - minX, 1), (state.height * 0.8) / Math.max(maxY - minY, 1));
  return setZoom(api, zoom, [(minX + maxX) / 2, (minY + maxY) / 2]).zoom;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function slim(e: El): SlimElement {
  const s: SlimElement = { id: e.id, type: e.type, x: round(e.x), y: round(e.y), width: round(e.width), height: round(e.height) };
  if (e.angle) s.angle = Math.round(e.angle * 100) / 100;
  if (e.type === "text") {
    s.text = e.originalText ?? e.text;
    s.fontSize = e.fontSize;
    if (e.containerId) s.containerId = e.containerId;
  }
  const labelId = boundTextId(e);
  if (labelId) s.boundTextId = labelId;
  if (e.startBinding?.elementId) s.startId = e.startBinding.elementId;
  if (e.endBinding?.elementId) s.endId = e.endBinding.elementId;
  if ((e.type === "arrow" || e.type === "line") && Array.isArray(e.points)) s.points = e.points.map((p: number[]) => [round(p[0]), round(p[1])]);
  if (e.frameId) s.frameId = e.frameId;
  if (e.type === "frame" || e.type === "magicframe") s.name = e.name ?? null;
  if (e.strokeColor && e.strokeColor !== "#1e1e1e") s.strokeColor = e.strokeColor;
  if (e.backgroundColor && e.backgroundColor !== "transparent") s.backgroundColor = e.backgroundColor;
  if (e.strokeStyle && e.strokeStyle !== "solid") s.strokeStyle = e.strokeStyle;
  if (e.link) s.link = e.link;
  if (e.customData?.createdBy === "claude") s.byClaude = true;
  if (e.customData?.diagram) s.diagram = e.customData.diagram;
  const steps = e.type === "frame" ? diagramSteps(e) : undefined;
  if (steps) s.steps = steps;
  return s;
}

function applyCamera(api: Api, rect: { x: number; y: number; width: number; height: number }) {
  const state = api.getAppState();
  const zoom = clamp(Math.min(state.width / rect.width, state.height / rect.height), 0.1, 30);
  return setZoom(api, zoom, [rect.x + rect.width / 2, rect.y + rect.height / 2]);
}

function setZoom(api: Api, value: number, focus: [number, number]) {
  const state = api.getAppState();
  const zoom = clamp(value, 0.1, 30);
  const scrollX = -focus[0] + state.width / 2 / zoom;
  const scrollY = -focus[1] + state.height / 2 / zoom;
  api.updateScene({
    appState: { zoom: { value: zoom } as never, scrollX, scrollY },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  return viewportFrom(state.width, state.height, scrollX, scrollY, zoom);
}

function currentViewport(api: Api) {
  const s = api.getAppState();
  return viewportFrom(s.width, s.height, s.scrollX, s.scrollY, s.zoom.value);
}

function viewportFrom(screenWidth: number, screenHeight: number, scrollX: number, scrollY: number, zoom: number) {
  return {
    x: round(-scrollX),
    y: round(-scrollY),
    width: round(screenWidth / zoom),
    height: round(screenHeight / zoom),
    zoom: Math.round(zoom * 100) / 100,
  };
}

function viewportCenter(api: Api): [number, number] {
  const v = currentViewport(api);
  return [v.x + v.width / 2, v.y + v.height / 2];
}

function boundsInViewport(api: Api, [minX, minY, maxX, maxY]: Bounds) {
  const v = currentViewport(api);
  return minX >= v.x && minY >= v.y && maxX <= v.x + v.width && maxY <= v.y + v.height;
}

function fitElements(api: Api, elements: readonly El[], maxZoom: number) {
  return fitBounds(api, getCommonBounds(elements as never) as Bounds, maxZoom);
}

// Camera moves are applied directly: Excalidraw's animated scrolling stalls when the tab isn't rendering.
function fitBounds(api: Api, [minX, minY, maxX, maxY]: Bounds, maxZoom: number) {
  const state = api.getAppState();
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const zoom = clamp(Math.min((state.width * 0.85) / width, (state.height * 0.85) / height), 0.1, maxZoom);
  return setZoom(api, zoom, [(minX + maxX) / 2, (minY + maxY) / 2]);
}

function placementOffset(created: El[], existing: readonly El[], placement: "right_of_existing" | "below_existing") {
  const others = existing.filter((e) => !e.isDeleted);
  if (!others.length) return { dx: 0, dy: 0 };
  const [minX, minY] = getCommonBounds(created as never);
  const [exMinX, exMinY, exMaxX, exMaxY] = getCommonBounds(others as never);
  return placement === "right_of_existing"
    ? { dx: exMaxX + 120 - minX, dy: exMinY - minY }
    : { dx: exMinX - minX, dy: exMaxY + 120 - minY };
}

function showActivity(api: Api, message: string) {
  api.setToast({ message, duration: 1500 });
}

function boundTextId(e: El | undefined): string | undefined {
  return e?.boundElements?.find((b: El) => b.type === "text")?.id;
}

function labelDefaults(label: El) {
  return { textAlign: "center", verticalAlign: "middle", ...label };
}

function geometry(e: El) {
  const g: El = { x: e.x, y: e.y, width: e.width, height: e.height };
  if (Array.isArray(e.points)) g.points = e.points;
  return g;
}

function overlaps(a: El, b: El) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function center(e: El): [number, number] {
  return [e.x + e.width / 2, e.y + e.height / 2];
}

function boundsCenter(elements: readonly El[]): [number, number] {
  const [minX, minY, maxX, maxY] = getCommonBounds(elements as never);
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Where the line from an element's center toward `toward` crosses its bounding box (plus a small gap). */
function edgePoint(e: El, toward: [number, number]): [number, number] {
  const [cx, cy] = center(e);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (!dx && !dy) return [cx, cy];
  const scale = Math.min(dx ? (e.width / 2 + 6) / Math.abs(dx) : Infinity, dy ? (e.height / 2 + 6) / Math.abs(dy) : Infinity);
  return [cx + dx * scale, cy + dy * scale];
}

function pointsSize(points: number[][]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function splitIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  return list.map((id) => String(id).trim()).filter(Boolean);
}

async function fontsReady() {
  // Measuring text before the fonts load gives boxes the wrong size.
  try {
    await Promise.race([
      Promise.all([document.fonts.load("20px Excalifont"), document.fonts.load("20px Nunito")]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    // measurement falls back to whatever font is available
  }
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(n: number) {
  return Math.round(n);
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
