import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ServerToTab, TabToServer } from "../../shared/protocol";
import { runCommand } from "./commands";

export type BridgeStatus = "connecting" | "connected" | "disconnected" | "superseded";

/** Keeps a WebSocket open to the board server and runs the commands it sends against the live board. */
export function connectBridge(getApi: () => ExcalidrawImperativeAPI | null, onStatus: (status: BridgeStatus) => void) {
  let socket: WebSocket | null = null;
  let attempts = 0;
  let superseded = false;
  let stopped = false;

  const connect = () => {
    onStatus("connecting");
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    socket = ws;

    ws.onopen = () => {
      attempts = 0;
      onStatus("connected");
    };

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data) as ServerToTab;
      if (message.type === "superseded") {
        superseded = true;
        onStatus("superseded");
        ws.close();
        return;
      }
      const reply = (response: TabToServer) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(response));
      try {
        const api = getApi();
        if (!api) throw new Error("The board is still loading; try again in a moment.");
        const result = await runCommand(api, message.command, message.args);
        reply({ type: "response", id: message.id, ok: true, result });
      } catch (error) {
        reply({ type: "response", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    ws.onclose = () => {
      if (socket !== ws || superseded || stopped) return;
      onStatus("disconnected");
      setTimeout(connect, Math.min(5000, 500 * 2 ** attempts++));
    };
  };

  connect();

  return {
    /** Make this tab the one Claude draws on again (after another tab took over). */
    takeOver() {
      superseded = false;
      connect();
    },
    stop() {
      stopped = true;
      socket?.close();
    },
  };
}
