import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  AnimateResult,
  ChangeResult,
  DiagramArgs,
  DiagramResult,
  DrawResult,
  ImageResult,
  MermaidResult,
  PointArgs,
  PointResult,
  ViewArgs,
} from "../shared/protocol.js";
import { Board, BoardNotOpenError, log } from "./board.js";
import { describeBoard, describeChanges } from "./describe.js";
import { GUIDE_TOPICS, GUIDES, SERVER_INSTRUCTIONS } from "./guide.js";

// Style vocabulary shared by the draw_diagram schema.
const COLOR = z.enum(["blue", "green", "yellow", "orange", "red", "purple", "teal", "pink", "gray"]);
const LINE = z.enum(["solid", "dashed", "dotted"]);
const STATUS = z
  .enum(["highlight", "new", "planned", "deprecated", "risk"])
  .describe("highlight: bold border. new: bold green. planned: dashed and hatched. deprecated: faded and dotted. risk: bold red.");
const STEP = z.number().int().min(1).describe("When this part appears (default 1).");
const HEAD = z.enum([
  "arrow", "triangle", "triangle_outline", "dot", "circle", "circle_outline", "diamond", "diamond_outline",
  "bar", "crowfoot_one", "crowfoot_many", "crowfoot_one_or_many", "none",
]);

/** Builds the MCP server that the Claude connector talks to. One instance is created per request. */
export function createMcpServer(board: Board, boardUrl: string): McpServer {
  const server = new McpServer({ name: "excalidraw-board", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  const run = async (tool: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    log(`tool ${tool}`);
    try {
      return await fn();
    } catch (error) {
      if (error instanceof BoardNotOpenError) {
        return textResult(`The whiteboard isn't open in a browser right now. Ask the user to open ${boardUrl} on their computer, then try again.`, true);
      }
      return textResult(`Whiteboard error: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  // Mentioned after every change so Claude knows to look when the user has been drawing too.
  // Uses the scene that came back with the change, so there's no second round trip to the board.
  const pendingChangesNote = ({ scene, touched }: ChangeResult) => {
    board.markSeenIds(scene, touched);
    if (!board.lastSeen) return "";
    const changes = describeChanges(board.lastSeen, scene);
    return changes.length ? `\nThe user has made ${changes.length} change${changes.length === 1 ? "" : "s"} since you last looked. Call get_board to see them.` : "";
  };

  server.registerTool(
    "read_me",
    {
      title: "Whiteboard guide",
      description:
        "Returns a guide. Topic draw (default): the element format, arrangement operations, and sizing rules for the draw tool; read it once before your first draw call. styles: every visual property (colors, fills, strokes, opacity, arrowheads, fonts, frames, layers) and what to use it for. patterns: how to picture common explanations (mind maps, concept maps, timelines, comparisons, matrices, stacks, before/after). draw_diagram, point_at, and animate need no guide.",
      inputSchema: { topic: z.enum(GUIDE_TOPICS).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ topic }) => textResult(`${GUIDES[topic ?? "draw"]}\n(read_me topics: ${GUIDE_TOPICS.join(", ")}. You don't need to read a topic twice in a conversation.)`),
  );

  server.registerTool(
    "get_board",
    {
      title: "Read the whiteboard",
      description:
        "Returns everything currently on the shared whiteboard (with ids, labels, positions, and who drew each element), what the user has selected, and what the user changed since you last looked. Call this whenever the user refers to the board, asks if you can see their changes, or before you edit existing content.",
      inputSchema: {
        include_json: z.boolean().optional().describe("Also include raw element data (positions, points, bindings) as JSON."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ include_json }) =>
      run("get_board", async () => {
        const scene = await board.scene();
        const parts: string[] = [];
        if (!board.lastSeen) parts.push("This is your first look at the board in this session.");
        else {
          const changes = describeChanges(board.lastSeen, scene);
          parts.push(changes.length ? `Changes since you last looked:\n${changes.map((c) => `- ${c}`).join("\n")}` : "No changes since you last looked.");
        }
        parts.push(describeBoard(scene));
        if (include_json) parts.push(`Elements JSON:\n${JSON.stringify(scene.elements)}`);
        board.markSeen(scene);
        return textResult(parts.join("\n\n"));
      }),
  );

  server.registerTool(
    "get_board_image",
    {
      title: "See the whiteboard",
      description:
        "Returns a PNG image of the whiteboard. Use it to see freehand sketches, handwriting, or the overall layout, which the text from get_board can't convey.",
      inputSchema: {
        area: z.enum(["all", "viewport", "selection"]).optional().describe("all = whole board (default), viewport = what the user is looking at, selection = selected elements"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ area }) =>
      run("get_board_image", async () => {
        const image = await board.call<ImageResult>("image", { area: area ?? "all" }, 30_000);
        return { content: [{ type: "image", data: image.base64, mimeType: image.mimeType }] };
      }),
  );

  server.registerTool(
    "draw_diagram",
    {
      title: "Draw a diagram",
      description:
        "Draws a diagram with automatic layout: boxes sized to their labels, arrows routed around boxes with room for their labels, a styled legend, and the user's view moved there first. Use it whenever you explain something with parts that connect (a system, process, pipeline, lifecycle, concept map) or ideas that branch (mind map, overview, study notes), before you start talking about it. No read_me needed. Build it up while you explain: give parts step numbers and reveal them with show_step, or call again with the same id to add, change, or remove parts. Node and group ids become element ids (edge ids default to \"from->to\"), so you can point_at or animate them.",
      inputSchema: {
        id: z.string().describe("Diagram id, e.g. \"kafka\". Call again with the same id to change it; pass only what's new or different."),
        title: z.string().optional(),
        layout: z
          .enum(["flow", "mindmap"])
          .optional()
          .describe("flow (default): boxes and arrows in a direction. mindmap: the first node is the center; branches get their own colors, curves, and smaller sizes with depth."),
        direction: z.enum(["right", "down"]).optional().describe("Flow direction. Default right; down for hierarchies and long processes."),
        arrows: z.enum(["elbow", "curved", "straight"]).optional().describe("Flow arrow routing. Default elbow; curved for concept maps and cycles."),
        look: z.enum(["sketch", "clean"]).optional().describe("sketch (default): hand-drawn. clean: smooth lines, plain font, for formal diagrams."),
        legend: z
          .union([z.boolean(), z.record(z.string(), z.string())])
          .optional()
          .describe("true: a legend for the kinds, statuses, line styles, and arrowheads used. Or name meanings by kind, status, line style, arrowhead, or color: {\"dashed\": \"Kafka event\", \"orange\": \"vendor\"}."),
        nodes: z
          .array(
            z.object({
              id: z.string(),
              label: z.string().describe("1-4 words. \\n starts a new line."),
              kind: z
                .enum(["topic", "service", "actor", "store", "queue", "external", "decision", "question", "note", "success", "error"])
                .optional()
                .describe("Shape and color by role. topic: big central idea. service (default): component, step, concept. actor: person, client, entry point. store: data. queue: events, streams. external: third party. decision: diamond. question: open question. note. success / error: outcomes."),
              color: COLOR.optional().describe("Overrides the kind's color (in a mind map, a main branch's color)."),
              fill: z.enum(["solid", "hachure", "cross-hatch", "zigzag", "none"]).optional().describe("hachure: draft or estimated. cross-hatch: blocked or hot. none: outline only."),
              border: LINE.optional(),
              status: STATUS.optional(),
              size: z.enum(["small", "medium", "large"]).optional().describe("Importance."),
              group: z.string().optional().describe("Id of the group it sits in (flow only)."),
              step: STEP.optional(),
            }),
          )
          .optional(),
        edges: z
          .array(
            z.object({
              from: z.string().describe("Node or group id"),
              to: z.string().describe("Node or group id"),
              label: z.string().optional().describe("1-3 words, ideally a verb."),
              line: LINE.optional().describe("solid (default): direct call or main flow. dashed: async, event, response. dotted: optional, indirect."),
              weight: z.enum(["thin", "normal", "bold"]).optional().describe("bold: the main path."),
              head: HEAD.optional().describe("End marker. arrow (default in flows), triangle: is a, triangle_outline: implements, diamond: owns, diamond_outline: has, dot: uses, bar: blocked, crowfoot_*: cardinality, none (default in mind maps)."),
              tail: HEAD.optional().describe("Start marker; tail \"arrow\" makes it two-way."),
              color: COLOR.optional(),
              status: STATUS.optional(),
              step: STEP.optional().describe("When this arrow appears (default: when both ends are shown)."),
              id: z.string().optional().describe("Needed only for a second edge between the same two nodes."),
            }),
          )
          .optional(),
        groups: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              parent: z.string().optional().describe("Enclosing group id"),
              color: COLOR.optional().describe("Makes it a tinted zone."),
              border: z.enum(["dashed", "dotted", "solid", "none"]).optional().describe("dashed (default): logical boundary. solid: hard boundary such as a network. dotted: loose or proposed."),
              step: STEP.optional(),
            }),
          )
          .optional()
          .describe("Boundaries around related nodes in a flow: a service, a team, a network zone, a phase, a swimlane."),
        remove: z.array(z.string()).optional().describe("Node, edge, or group ids to take out."),
        show_step: z
          .union([z.number().int().min(1), z.literal("all")])
          .optional()
          .describe("Show parts up to this step. Default: all. Space is reserved for later steps, so nothing moves as you reveal them."),
        point: z.boolean().optional().describe("Sweep your laser pointer over the parts that just appeared, in order, once they're drawn."),
        animate: z.boolean().optional().describe("New parts draw themselves in, stroke by stroke in explanation order, on the user's screen (default true). false makes them appear at once."),
        placement: z.enum(["right_of_existing", "below_existing"]).optional().describe("Where a new diagram goes. Default right_of_existing."),
      },
    },
    async ({ show_step, ...rest }) =>
      run("draw_diagram", async () => {
        const args: DiagramArgs = { ...rest, showStep: show_step };
        const result = await board.call<DiagramResult>("diagram", args, 30_000);
        const { steps, frame: f } = result;
        const lines = [
          `Diagram "${args.id}": ${result.nodeCount} nodes, ${result.edgeCount} edges, frame at (${f.x}, ${f.y}) ${f.width}×${f.height}.` +
            (steps.total > 1 ? ` Showing step ${steps.shown} of ${steps.total}.` : "") +
            drawingInNote(result.drawInMs),
          ...result.warnings.map((w) => `Warning: ${w}`),
        ];
        const stretch = Math.max(f.width / f.height, f.height / f.width);
        if (stretch > 3 && Math.max(f.width, f.height) > 1800) lines.push(`It's ${stretch.toFixed(1)} times as ${f.width > f.height ? "wide as it is tall" : "tall as it is wide"}, so the user has to zoom out to read it. Consider the other direction, fewer parts per diagram, or two diagrams.`);
        return textResult(lines.join("\n") + pendingChangesNote(result));
      }),
  );

  server.registerTool(
    "draw",
    {
      title: "Draw on the whiteboard",
      description:
        "Low-level drawing: creates, updates, or deletes individual elements at coordinates you choose. For boxes and arrows (architecture, flows, processes, concepts), use draw_diagram instead, which lays them out for you. Use draw for free-form sketches, notes, titles, and edits to existing elements. Elements with a new id are created; an element whose id already exists is updated with only the fields you pass; {\"type\":\"delete\",\"ids\":\"a,b\"} removes elements; {\"type\":\"cameraUpdate\",\"x\":0,\"y\":0,\"width\":800,\"height\":600} moves the user's view; group, align, distribute, and order arrange elements. The result warns about overlaps, arrows crossing shapes, and cramped labels; fix them. Call read_me first for the element format.",
      inputSchema: {
        elements: z.array(z.record(z.string(), z.any())).describe("Excalidraw elements and pseudo-elements, in drawing order. See read_me."),
        placement: z
          .enum(["as_given", "right_of_existing", "below_existing"])
          .optional()
          .describe("as_given (default) uses your coordinates. right_of_existing / below_existing shifts the new elements next to the existing content."),
        point: z.boolean().optional().describe("Sweep your laser pointer over the new elements after drawing them, saving a point_at call."),
        animate: z.boolean().optional().describe("New elements draw themselves in, stroke by stroke, on the user's screen (default true)."),
      },
    },
    async ({ elements, placement, point, animate }) =>
      run("draw", async () => {
        const result = await board.call<DrawResult>("draw", { elements, placement, point, animate });
        const lines = [
          result.created.length && `Created: ${result.created.join(", ")}.${drawingInNote(result.drawInMs)}`,
          result.updated.length && `Updated: ${result.updated.join(", ")}`,
          result.deleted.length && `Deleted: ${result.deleted.join(", ")}`,
          result.offset && `Placement moved the new elements by (${result.offset.dx}, ${result.offset.dy}); add that to coordinates you use for them later.`,
          !result.created.length && !result.updated.length && !result.deleted.length && "Nothing changed.",
          ...result.warnings.map((w) => `Warning: ${w}`),
        ].filter(Boolean);
        return textResult(lines.join("\n") + pendingChangesNote(result));
      }),
  );

  server.registerTool(
    "draw_mermaid",
    {
      title: "Draw a Mermaid diagram",
      description:
        "Converts a Mermaid diagram into editable whiteboard shapes with automatic layout. Flowchart, sequence, class, ER, and state diagrams become editable; other types become a single image. Placed to the right of existing content unless x and y are given.",
      inputSchema: {
        definition: z.string().describe("Mermaid source, e.g. \"flowchart LR\\n  A[Producer] --> B[Topic] --> C[Consumer]\""),
        x: z.number().optional().describe("Left edge of the diagram"),
        y: z.number().optional().describe("Top edge of the diagram"),
      },
    },
    async ({ definition, x, y }) =>
      run("draw_mermaid", async () => {
        const result = await board.call<MermaidResult>("mermaid", { definition, x, y }, 30_000);
        const b = result.bounds;
        const text = [
          `Drew a diagram at (${b.x}, ${b.y}), ${b.width}×${b.height}.`,
          result.editable ? `Element ids: ${result.created.join(", ")}` : "This diagram type was inserted as a single image, so its parts can't be edited individually.",
        ].join("\n");
        return textResult(text + pendingChangesNote(result));
      }),
  );

  server.registerTool(
    "set_view",
    {
      title: "Move the user's view",
      description:
        "Pans and zooms the user's view of the whiteboard: fit everything, the selection, or specific elements; show a rectangle; or set a zoom level (1 = 100%).",
      inputSchema: {
        fit: z.enum(["all", "selection"]).optional(),
        ids: z.array(z.string()).optional().describe("Fit these elements (e.g. a frame id)"),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        zoom: z.number().optional().describe("Zoom level, e.g. 0.75 for 75%"),
      },
    },
    async (args) =>
      run("set_view", async () => {
        const v = await board.call<{ x: number; y: number; width: number; height: number; zoom: number }>("view", args as ViewArgs);
        return textResult(`The user's view now shows x=${v.x} y=${v.y} ${v.width}×${v.height} at ${Math.round(v.zoom * 100)}% zoom.`);
      }),
  );

  server.registerTool(
    "animate",
    {
      title: "Animate the whiteboard",
      description:
        "Replays a hand-drawing animation in a full-screen player: shapes, arrows, and text are drawn stroke by stroke in the order you choose. New drawings already draw themselves in on the board, so use this to replay something already there: a recap of a whole diagram in its step order, a custom story order, or saving the animation as a file. The player covers the board until the user closes it or you draw or move the view again.",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("Animate only these elements; a frame id includes everything inside it. Default: the whole board."),
        order: z
          .array(z.string())
          .optional()
          .describe("Element ids to draw first, in this order (each shape's label is drawn with it; a frame id draws its contents). Everything else follows in the order it was added to the board."),
        rest: z
          .enum(["animate", "show"])
          .optional()
          .describe("Elements not listed in order: animate (default) draws them afterwards; show displays them from the start, so only the listed ones are drawn."),
        element_ms: z.number().int().min(50).max(10_000).optional().describe("How long drawing each element takes, in milliseconds. Default 500 (grouped elements share 5 seconds)."),
        pointer: z.boolean().optional().describe("Show a pencil following the strokes."),
        save: z.boolean().optional().describe("Also save the animation as an animated SVG file on the user's computer."),
      },
    },
    async ({ ids, order, rest, element_ms, pointer, save }) =>
      run("animate", async () => {
        const result = await board.call<AnimateResult>("animate", { ids, order, rest, elementMs: element_ms, pointer, includeSvg: save }, 30_000);
        const lines = [
          `Playing a ${(result.durationMs / 1000).toFixed(1)}s animation of ${result.elementCount} element${result.elementCount === 1 ? "" : "s"} on the user's screen.`,
          ...result.warnings.map((w) => `Warning: ${w}`),
        ];
        if (result.svg) lines.push(`Saved the animation to ${board.saveAnimation(result.svg)}`);
        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "point_at",
    {
      title: "Point with a laser",
      description:
        "Points at part of the whiteboard with Claude's laser pointer so the user can follow what you're talking about: it circles shapes, traces arrows along their direction, and underlines text, scrolling the view if needed. Returns immediately; the pointer keeps moving while you talk.\n" +
        "To stay in step with speech (voice mode speaks more slowly than you write), pass a script once, right before a passage: one beat per sentence or clause, each with the ids it's about and the exact words you'll then say. Each beat lasts as long as saying its words takes. Then say those words, in that order, without further point_at calls in between. A call waits for pointing and drawing already under way, unless interrupt is true.",
      inputSchema: {
        script: z
          .array(
            z.object({
              ids: z.array(z.string()).optional().describe("What this beat is about. Several ids are pointed at one after another within the beat. None: the pointer stays where it is, or before the first target (an introduction) waits while you say it."),
              say: z.string().optional().describe("The words you'll speak during this beat, verbatim."),
              ms: z.number().int().min(300).max(20_000).optional().describe("Length of the beat when there's no say."),
              together: z.boolean().optional().describe("Circle this beat's ids as one area."),
              gesture: z.enum(["auto", "circle", "underline", "trace", "dot"]).optional(),
            }),
          )
          .optional()
          .describe("A passage, beat by beat, paced to your speech. Use instead of ids when you'll talk about several things in a row."),
        ids: z.array(z.string()).optional().describe("Elements to point at, in order. A frame id points at the whole frame."),
        together: z.boolean().optional().describe("Circle all ids at once as one area instead of one after another."),
        x: z.number().optional().describe("Point at a spot on the board instead (board coordinates, with y)."),
        y: z.number().optional(),
        ms: z.number().int().min(300).max(20_000).optional().describe("How long to point at each target, in milliseconds (default 2500)."),
        gesture: z
          .enum(["auto", "circle", "underline", "trace", "dot"])
          .optional()
          .describe("auto (default): trace arrows and lines, underline text, circle everything else."),
        hide: z.boolean().optional().describe("Stop pointing and remove the pointer now, including anything queued. Do this first when the user interrupts you and you won't point again right away."),
        interrupt: z.boolean().optional().describe("Start now, dropping the pointing already under way. Use it on your first point_at after the user interrupts you or changes the subject."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run("point_at", async () => {
        const result = await board.call<PointResult>("point", args as PointArgs);
        const lines = [
          args.hide
            ? "Hid the laser pointer."
            : `Pointing at ${result.targets.join(", then ")} for about ${seconds(result.durationMs)}` +
              (result.startsInMs > 300 ? `, starting in about ${seconds(result.startsInMs)} after what's already under way.` : "."),
          ...result.warnings.map((w) => `Warning: ${w}`),
        ];
        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "clear_board",
    {
      title: "Clear the whiteboard",
      description: "Removes everything from the whiteboard (the user can undo with Ctrl+Z). Only use when the user asks to start over.",
      inputSchema: { confirm: z.union([z.boolean(), z.literal("true")]).describe("Must be true") },
      annotations: { destructiveHint: true },
    },
    async ({ confirm }) =>
      run("clear_board", async () => {
        if (confirm !== true && confirm !== "true") return textResult("Not cleared: pass confirm=true.", true);
        const { removed } = await board.call<{ removed: number }>("clear");
        board.markSeen(await board.scene(true));
        return textResult(`Cleared ${removed} elements.`);
      }),
  );

  return server;
}

function seconds(ms: number) {
  return `${Math.round(ms / 100) / 10}s`;
}

function drawingInNote(ms: number | undefined) {
  return ms ? ` The new parts are drawing themselves in on the user's screen over about ${seconds(ms)}.` : "";
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}
