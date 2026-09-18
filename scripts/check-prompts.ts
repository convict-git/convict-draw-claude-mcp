// Checks what a client actually receives against the limits clients cut text off at: `npm run check:prompts`.
// Connects in memory, so it needs no running server or open board.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/board.js";
import { MAX_INSTRUCTIONS, MAX_TOOL_DESCRIPTION } from "../server/guide.js";
import { createMcpServer } from "../server/tools.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-prompts-"));
const server = createMcpServer(new Board(dataDir), "http://localhost");
const client = new Client({ name: "check-prompts", version: "0.1.0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

const rows: [string, number, number][] = [["instructions", client.getInstructions()?.length ?? 0, MAX_INSTRUCTIONS]];
for (const tool of (await client.listTools()).tools) rows.push([`tool ${tool.name}`, tool.description?.length ?? 0, MAX_TOOL_DESCRIPTION]);
await client.close();
fs.rmSync(dataDir, { recursive: true, force: true });

const over = rows.filter(([, length, max]) => length > max);
for (const [name, length, max] of rows) console.log(`${length > max ? "OVER" : "ok  "} ${String(length).padStart(5)} / ${max}  ${name}`);
if (over.length) {
  console.error(`\n${over.length} over the limit: clients drop everything past it without telling Claude.`);
  process.exit(1);
}
