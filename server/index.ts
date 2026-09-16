import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Board, log } from "./board.js";
import { createMcpServer } from "./tools.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 3170);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR ?? ".data");
const WEB_DIR = path.join(ROOT, "dist", "web");
const BOARD_URL = `http://localhost:${PORT}`;

const board = new Board(DATA_DIR);
const secret = loadSecret();
const app = express();

// ---------------------------------------------------------------------------
// MCP endpoint for the Claude connector. This is the only route reachable through a tunnel;
// the random path segment is what keeps strangers out.
// ---------------------------------------------------------------------------

app.post("/mcp/:secret", express.json({ limit: "10mb" }), async (req, res) => {
  if (!secretMatches(String(req.params.secret))) {
    res.status(404).end();
    return;
  }
  const server = createMcpServer(board, BOARD_URL);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    log("mcp request failed:", error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

app.all("/mcp/:secret", (req, res) => {
  if (!secretMatches(String(req.params.secret))) res.status(404).end();
  else res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

// ---------------------------------------------------------------------------
// Board UI and its API: this computer only.
// ---------------------------------------------------------------------------

app.use(localOnly);

app.get("/api/board", (_req, res) => {
  const saved = board.loadFile();
  if (!saved) res.status(404).json({ error: "no saved board yet" });
  else res.type("application/json").send(saved);
});

app.put("/api/board", express.text({ type: "*/*", limit: "50mb" }), (req, res) => {
  try {
    JSON.parse(req.body);
    board.saveFile(req.body);
    res.status(204).end();
  } catch (error) {
    log("save failed:", error);
    res.status(400).json({ error: "invalid board JSON" });
  }
});

app.use(express.static(WEB_DIR));
app.get("/", (_req, res) => {
  res.status(503).type("text").send("The board UI hasn't been built yet. Run `npm run build`, then restart the server.");
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  // Browsers don't apply CORS to WebSockets, so check that the board page itself is connecting.
  const origin = req.headers.origin ?? "";
  const allowedOrigin = /^http:\/\/(localhost|127\.0\.0\.1):(\d+)$/.test(origin);
  if (pathname !== "/ws" || !isLocalRequest(req) || !allowedOrigin) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => board.attachTab(ws));
});

httpServer.listen(PORT, HOST, () => {
  const localMcp = `http://localhost:${PORT}/mcp/${secret}`;
  console.error(`
Excalidraw board server is running.

  1. Open the board in your browser:  ${BOARD_URL}
  2. MCP endpoint on this computer:   ${localMcp}
     (Claude Code: claude mcp add --transport http excalidraw-board ${localMcp})
  3. For the Claude app (web, desktop, mobile, voice), expose it with a tunnel:
       cloudflared tunnel --url http://localhost:${PORT}
     then add a custom connector with the URL:
       https://<your-tunnel-host>/mcp/${secret}

Board file: ${board.filePath}
`);
});

// ---------------------------------------------------------------------------

function loadSecret(): string {
  if (process.env.CONNECTOR_SECRET) return process.env.CONNECTOR_SECRET;
  const file = path.join(DATA_DIR, "connector-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const value = randomBytes(18).toString("base64url");
    fs.writeFileSync(file, value, { mode: 0o600 });
    return value;
  }
}

function secretMatches(candidate: string) {
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True for requests made directly on this computer, not relayed through a tunnel or proxy. */
function isLocalRequest(req: IncomingMessage) {
  const relayed = ["x-forwarded-for", "x-forwarded-host", "forwarded", "cf-connecting-ip", "tailscale-funnel-request"].some((h) => h in req.headers);
  const host = req.headers.host ?? "";
  return !relayed && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

function localOnly(req: Request, res: Response, next: NextFunction) {
  if (isLocalRequest(req)) next();
  else res.status(404).end();
}
