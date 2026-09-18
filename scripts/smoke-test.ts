// Calls the connector like Claude would: `npm run smoke` (with the server running and the board open).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";

const secret = process.env.CONNECTOR_SECRET ?? fs.readFileSync(".data/connector-secret", "utf8").trim();
const url = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 3170}/mcp/${secret}`;

const client = new Client({ name: "smoke-test", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string; data?: string }[];
  const text = content.map((c) => (c.type === "text" ? c.text : `[${c.type}, ${c.data?.length ?? 0} base64 chars]`)).join("\n");
  console.log(`\n=== ${name}${result.isError ? " (error)" : ""} ===\n${text}`);
  return result;
};

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

await call("get_board");
await call("draw", {
  elements: [
    { type: "frame", id: "f_smoke", name: "Smoke test", x: 0, y: 0, width: 760, height: 320 },
    { type: "rectangle", id: "smoke_producer", x: 40, y: 80, width: 180, height: 80, frameId: "f_smoke", roundness: { type: 3 }, backgroundColor: "#a5d8ff", label: { text: "Producer", fontSize: 20 } },
    { type: "rectangle", id: "smoke_topic", x: 320, y: 80, width: 200, height: 80, frameId: "f_smoke", roundness: { type: 3 }, backgroundColor: "#c3fae8", label: { text: "Topic: orders", fontSize: 20 } },
    { type: "arrow", id: "smoke_publish", x: 0, y: 0, frameId: "f_smoke", start: { id: "smoke_producer" }, end: { id: "smoke_topic" }, label: { text: "publish", fontSize: 16 } },
  ],
});
await call("draw", {
  elements: [
    { type: "ellipse", id: "smoke_consumer", x: 600, y: 200, width: 140, height: 80, frameId: "f_smoke", backgroundColor: "#b2f2bb", label: { text: "Consumer" } },
    { type: "arrow", id: "smoke_consume", x: 0, y: 0, start: { id: "smoke_topic" }, end: { id: "smoke_consumer" }, frameId: "f_smoke" },
    { id: "smoke_topic", label: { text: "Topic: orders (3 partitions)" } },
  ],
});
await call("draw", {
  elements: [
    { type: "align", ids: "smoke_producer,smoke_topic", to: "middle" },
    { type: "group", ids: "smoke_producer,smoke_topic" },
  ],
});
await call("get_board");
await call("point_at", { ids: ["smoke_producer", "smoke_publish", "smoke_topic"], ms: 1000 });
await call("point_at", { script: [{ ids: ["smoke_producer"], say: "The producer writes events." }, { ids: ["smoke_publish", "smoke_topic"], say: "It publishes them to a topic." }] });
await call("animate", { ids: ["f_smoke"], order: ["smoke_producer", "smoke_publish", "smoke_topic"], pointer: true });
await call("read_me", { topic: "styles" });
await call("draw_diagram", {
  id: "smoke_flow",
  title: "Smoke test flow",
  placement: "below_existing",
  legend: true,
  show_step: 1,
  point: true,
  nodes: [
    { id: "smoke_client", label: "Client", kind: "actor" },
    { id: "smoke_api", label: "API", group: "smoke_backend", status: "new" },
    { id: "smoke_db", label: "Database", kind: "store", group: "smoke_backend", step: 2 },
  ],
  groups: [{ id: "smoke_backend", label: "Backend", color: "blue" }],
  edges: [
    { from: "smoke_client", to: "smoke_api", label: "request" },
    { from: "smoke_api", to: "smoke_db", label: "query", line: "dashed", head: "crowfoot_many" },
  ],
});
await call("draw_diagram", { id: "smoke_flow", show_step: 2 });
await call("draw_diagram", {
  id: "smoke_map",
  layout: "mindmap",
  placement: "below_existing",
  nodes: [
    { id: "smoke_center", label: "Topic" },
    { id: "smoke_a", label: "Idea A" },
    { id: "smoke_b", label: "Idea B" },
    { id: "smoke_a1", label: "Detail", kind: "question" },
  ],
  edges: [
    { from: "smoke_center", to: "smoke_a" },
    { from: "smoke_center", to: "smoke_b" },
    { from: "smoke_a", to: "smoke_a1" },
  ],
});
if (process.env.SMOKE_KEEP !== "1") {
  const scene = JSON.stringify((await client.callTool({ name: "get_board", arguments: { include_json: true } })).content);
  const ids = [...new Set([...scene.matchAll(/\\"id\\":\\"((?:smoke_|f_smoke)[^\\"]*)\\"/g)].map((m) => m[1]))];
  await call("draw", { elements: [{ type: "delete", ids: ids.join(",") }] });
}
await client.close();
