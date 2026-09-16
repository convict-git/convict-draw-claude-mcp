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
  DrawArgs,
  DrawResult,
  ImageArgs,
  ImageResult,
  MermaidArgs,
  MermaidResult,
  SceneSnapshot,
  SlimElement,
  TabCommand,
  ViewArgs,
} from "../../shared/protocol";

type Api = ExcalidrawImperativeAPI;
// Excalidraw's element types are branded and readonly; this bridge works with plain objects.
type El = any;

// Fields Claude may change on an existing element through `draw`.
const UPDATABLE_FIELDS = [
  "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth",
  "strokeStyle", "roughness", "opacity", "roundness", "text", "fontSize", "fontFamily", "textAlign",
  "verticalAlign", "points", "startArrowhead", "endArrowhead", "frameId", "groupIds", "locked", "link", "name",
];
const LABEL_FIELDS = ["fontSize", "fontFamily", "strokeColor", "textAlign", "verticalAlign"];

export async function runCommand(api: Api, command: TabCommand, args: any): Promise<unknown> {
  switch (command) {
    case "draw":
      return draw(api, args);
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
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// draw: create, update (by existing id), delete, and move the camera
// ---------------------------------------------------------------------------

async function draw(api: Api, { elements, placement = "as_given" }: DrawArgs): Promise<DrawResult> {
  if (!Array.isArray(elements)) throw new Error("`elements` must be an array of element objects");
  await fontsReady();

  const current = api.getSceneElementsIncludingDeleted() as readonly El[];
  const live = new Map(current.filter((e) => !e.isDeleted).map((e) => [e.id, e]));
  const warnings: string[] = [];

  let camera: El | null = null;
  const deleteIds: string[] = [];
  const patches: El[] = [];
  const skeletons: El[] = [];
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as El;
    if (el.type === "cameraUpdate") camera = el;
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
  if (placement !== "as_given" && created.length) {
    const offset = placementOffset(created, [...live.values()].filter((e) => !deleteIds.includes(e.id)), placement);
    for (const e of created) {
      e.x += offset.dx;
      e.y += offset.dy;
    }
    if (camera) camera = { ...camera, x: camera.x + offset.dx, y: camera.y + offset.dy };
  }
  for (const e of created) e.customData = { ...(e.customData ?? {}), createdBy: "claude" };

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
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });

  const visibleCreated = created.filter((e) => !e.containerId);
  if (camera) applyCamera(api, camera);
  else if (visibleCreated.length && !isInViewport(api, visibleCreated)) followElements(api, visibleCreated);

  const parts = [
    visibleCreated.length && `drew ${visibleCreated.length}`,
    updated.length && `updated ${updated.length}`,
    deleted.length && `removed ${deleted.length}`,
  ].filter(Boolean);
  if (parts.length) api.setToast({ message: `Claude ${parts.join(", ")}`, duration: 2000 });

  for (const e of next) if (touched.has(e.id) && e.containerId) touched.add(e.containerId);
  return { created: visibleCreated.map((e) => e.id), updated, deleted, touched: [...touched], warnings };
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
    if (start && end && !Array.isArray(source?.points)) routeArrow(arrow, start, end);
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

/** Center each touched container's label, growing the container if the text doesn't fit. */
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
    replace.set(
      label.id,
      newElementWith(label, {
        x: container.x + (container.width - label.width) / 2,
        y: container.y + (container.height - label.height) / 2,
      } as never, true),
    );
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

let measureContext: CanvasRenderingContext2D | null = null;

/** Smallest shape width whose label can fit its longest word on one line. */
function minLabelWidth(type: string, label: El): number {
  if (typeof label?.text !== "string" || !label.text.trim()) return 0;
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return 0;
  measureContext.font = `${label.fontSize ?? 20}px Excalifont, Xiaolai, sans-serif`;
  const longest = Math.max(...label.text.split(/\s+/).map((word: string) => measureContext!.measureText(word).width));
  const inner = longest + 16; // Excalidraw pads bound text by 5px per side; keep a little slack
  if (type === "ellipse") return Math.ceil(inner * Math.SQRT2 + 4);
  if (type === "diamond") return Math.ceil(inner * 2 + 4);
  return Math.ceil(inner + 4);
}

function routeArrow(arrow: El, start: El, end: El) {
  const from = center(start);
  const to = center(end);
  const a = edgePoint(start, to);
  const b = edgePoint(end, from);
  arrow.x = a[0];
  arrow.y = a[1];
  arrow.points = [[0, 0], [b[0] - a[0], b[1] - a[1]]];
  Object.assign(arrow, pointsSize(arrow.points));
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
  api.updateScene({
    elements: [...(api.getSceneElementsIncludingDeleted() as readonly El[]), ...created],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  followElements(api, created);
  api.setToast({ message: "Claude drew a diagram", duration: 2000 });

  return {
    created: created.filter((e) => !e.containerId).map((e) => e.id),
    touched: created.map((e) => e.id),
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
  const elements = api.getSceneElementsIncludingDeleted() as readonly El[];
  const count = elements.filter((e) => !e.isDeleted).length;
  api.updateScene({
    elements: elements.map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true } as never))),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  api.setToast({ message: "Claude cleared the board (Ctrl+Z to undo)", duration: 3000 });
  return { removed: count };
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

function isInViewport(api: Api, elements: El[]) {
  const v = currentViewport(api);
  const [minX, minY, maxX, maxY] = getCommonBounds(elements as never);
  return minX >= v.x && minY >= v.y && maxX <= v.x + v.width && maxY <= v.y + v.height;
}

function followElements(api: Api, elements: El[]) {
  fitElements(api, elements, 1);
}

// Camera moves are applied directly: Excalidraw's animated scrolling stalls when the tab isn't rendering.
function fitElements(api: Api, elements: readonly El[], maxZoom: number) {
  const [minX, minY, maxX, maxY] = getCommonBounds(elements as never);
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
  // Measuring text before the hand-drawn font loads gives boxes the wrong size.
  try {
    await Promise.race([document.fonts.load("20px Excalifont"), new Promise((r) => setTimeout(r, 1500))]);
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

function round(n: number) {
  return Math.round(n);
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
