// Runs the board server and a Cloudflare tunnel together, then copies the connector URL to the clipboard: `npm run share`.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3170);
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? ".data");

const children: ChildProcess[] = [];
let stopping = false;

function run(name: string, command: string, args: string[], onLine?: (line: string) => void) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const forward = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        out.write(`[${name}] ${line}\n`);
        onLine?.(line);
      }
    });
  };
  forward(child.stdout!, process.stdout);
  forward(child.stderr!, process.stderr);
  child.on("error", (err) => {
    console.error(`[${name}] failed to start: ${err.message}`);
    if (name === "tunnel") console.error("Install cloudflared first: brew install cloudflared");
    stop(1);
  });
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`[${name}] exited with code ${code}`);
    stop(code ?? 1);
  });
  return child;
}

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

async function readSecret(): Promise<string> {
  if (process.env.CONNECTOR_SECRET) return process.env.CONNECTOR_SECRET;
  const file = path.join(DATA_DIR, "connector-secret");
  // The server writes the secret on startup, so give it a moment on a first run.
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`No connector secret at ${file}`);
}

function copyToClipboard(text: string): boolean {
  const candidates: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  return candidates.some(([command, args]) => spawnSync(command, args, { input: text }).status === 0);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run("server", "npm", ["start"]);

let announced = false;
run("tunnel", "cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], async (line) => {
  const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!match || announced) return;
  announced = true;
  const url = `${match[0]}/mcp/${await readSecret()}`;
  const copied = copyToClipboard(url);
  console.log(`
  Connector URL${copied ? " (copied to clipboard)" : ""}:

    ${url}

  Add or update it in Claude: Settings → Connectors. Press Ctrl+C to stop the server and tunnel.
`);
});
