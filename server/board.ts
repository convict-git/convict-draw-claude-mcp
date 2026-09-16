import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import type { SceneSnapshot, ServerToTab, TabCommand, TabToServer } from "../shared/protocol.js";
import { snapshotElements, type Snapshot } from "./describe.js";

export class BoardNotOpenError extends Error {}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The live board is the Excalidraw instance in the browser tab. This class forwards commands to
 * the most recently connected tab, stores the saved scene on disk, and remembers what Claude last
 * saw so it can report the user's changes.
 */
export class Board {
  private tab: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private readonly file: string;

  /** What the board looked like the last time Claude read it (null until the first read). */
  lastSeen: Snapshot | null = null;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "board.excalidraw");
  }

  get isOpen() {
    return this.tab !== null;
  }

  attachTab(ws: WebSocket) {
    if (this.tab && this.tab !== ws) this.send(this.tab, { type: "superseded" });
    this.tab = ws;
    log("board tab connected");

    ws.on("message", (data) => {
      let message: TabToServer;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type !== "response") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
    });

    ws.on("close", () => {
      if (this.tab !== ws) return;
      this.tab = null;
      log("board tab disconnected");
    });
  }

  call<T>(command: TabCommand, args: unknown = {}, timeoutMs = 15_000): Promise<T> {
    const tab = this.tab;
    if (!tab) return Promise.reject(new BoardNotOpenError("board not open"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The board didn't respond to "${command}" within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send(tab, { type: "request", id, command, args });
    });
  }

  /** Read the live scene. `quiet` skips the "Claude looked at the board" toast. */
  scene(quiet = false) {
    return this.call<SceneSnapshot>("scene", { quiet });
  }

  /** Remember the current scene as "seen by Claude". */
  markSeen(scene: SceneSnapshot) {
    this.lastSeen = snapshotElements(scene.elements);
  }

  /** After Claude draws, record its own elements as seen so they aren't reported as the user's changes. */
  markSeenIds(scene: SceneSnapshot, ids: Iterable<string>) {
    if (!this.lastSeen) return;
    const current = snapshotElements(scene.elements);
    for (const id of ids) {
      const entry = current.get(id);
      if (entry) this.lastSeen.set(id, entry);
      else this.lastSeen.delete(id);
    }
  }

  loadFile(): string | null {
    try {
      return fs.readFileSync(this.file, "utf8");
    } catch {
      return null;
    }
  }

  saveFile(json: string) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, json);
    fs.renameSync(temp, this.file);
  }

  get filePath() {
    return this.file;
  }

  private send(ws: WebSocket, message: ServerToTab) {
    ws.send(JSON.stringify(message));
  }
}

export function log(...args: unknown[]) {
  console.error(new Date().toISOString().slice(11, 19), ...args);
}
