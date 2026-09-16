import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DrawResult, ImageResult, MermaidResult, ViewArgs } from "../shared/protocol.js";
import { Board, BoardNotOpenError, log } from "./board.js";
import { describeBoard, describeChanges } from "./describe.js";
import { GUIDE, SERVER_INSTRUCTIONS } from "./guide.js";

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
  const pendingChangesNote = async (ownIds: string[]) => {
    const scene = await board.scene(true);
    board.markSeenIds(scene, ownIds);
    if (!board.lastSeen) return "";
    const changes = describeChanges(board.lastSeen, scene);
    return changes.length ? `\nThe user has made ${changes.length} change${changes.length === 1 ? "" : "s"} since you last looked. Call get_board to see them.` : "";
  };

  server.registerTool(
    "read_me",
    {
      title: "Whiteboard guide",
      description: "Returns how this whiteboard works and the element format, colors, and sizing rules. Call it once before your first drawing.",
      annotations: { readOnlyHint: true },
    },
    async () => textResult(GUIDE),
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
    "draw",
    {
      title: "Draw on the whiteboard",
      description:
        "Creates, updates, or deletes elements on the shared whiteboard; the user sees changes instantly. Elements with a new id are created; an element whose id already exists is updated with only the fields you pass; {\"type\":\"delete\",\"ids\":\"a,b\"} removes elements; {\"type\":\"cameraUpdate\",\"x\":0,\"y\":0,\"width\":800,\"height\":600} moves the user's view. Call read_me first for the element format.",
      inputSchema: {
        elements: z.array(z.record(z.string(), z.any())).describe("Excalidraw elements and pseudo-elements, in drawing order. See read_me."),
        placement: z
          .enum(["as_given", "right_of_existing", "below_existing"])
          .optional()
          .describe("as_given (default) uses your coordinates. right_of_existing / below_existing shifts the new elements next to the existing content."),
      },
    },
    async ({ elements, placement }) =>
      run("draw", async () => {
        const result = await board.call<DrawResult>("draw", { elements, placement });
        const lines = [
          result.created.length && `Created: ${result.created.join(", ")}`,
          result.updated.length && `Updated: ${result.updated.join(", ")}`,
          result.deleted.length && `Deleted: ${result.deleted.join(", ")}`,
          !result.created.length && !result.updated.length && !result.deleted.length && "Nothing changed.",
          ...result.warnings.map((w) => `Warning: ${w}`),
        ].filter(Boolean);
        return textResult(lines.join("\n") + (await pendingChangesNote(result.touched)));
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
        return textResult(text + (await pendingChangesNote(result.touched)));
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
    "clear_board",
    {
      title: "Clear the whiteboard",
      description: "Removes everything from the whiteboard (the user can undo with Ctrl+Z). Only use when the user asks to start over.",
      inputSchema: { confirm: z.boolean().describe("Must be true") },
      annotations: { destructiveHint: true },
    },
    async ({ confirm }) =>
      run("clear_board", async () => {
        if (!confirm) return textResult("Not cleared: pass confirm=true.", true);
        const { removed } = await board.call<{ removed: number }>("clear");
        board.markSeen(await board.scene(true));
        return textResult(`Cleared ${removed} elements.`);
      }),
  );

  return server;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}
