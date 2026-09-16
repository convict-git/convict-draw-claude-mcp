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
await call("get_board");
if (process.env.SMOKE_KEEP !== "1") {
  await call("draw", { elements: [{ type: "delete", ids: "f_smoke,smoke_producer,smoke_topic,smoke_publish,smoke_consumer,smoke_consume" }] });
}
await client.close();
