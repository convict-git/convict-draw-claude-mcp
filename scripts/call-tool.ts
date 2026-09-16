// Call one connector tool from the command line: npx tsx scripts/call-tool.ts <tool> '<json args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";

const [tool, json = "{}"] = process.argv.slice(2);
const secret = process.env.CONNECTOR_SECRET ?? fs.readFileSync(".data/connector-secret", "utf8").trim();
const client = new Client({ name: "call-tool", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${process.env.PORT ?? 3170}/mcp/${secret}`)));
const result = await client.callTool({ name: tool, arguments: JSON.parse(json) });
for (const c of result.content as { type: string; text?: string; data?: string }[]) {
  console.log(c.type === "text" ? c.text : `[${c.type}: ${c.data?.length ?? 0} base64 chars]`);
}
await client.close();
