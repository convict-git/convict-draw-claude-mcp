import { Excalidraw, hashElementsVersion, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildAnimation, showAnimation } from "./animate";
import { AnimationPlayer } from "./AnimationPlayer";
import { connectBridge, type BridgeStatus } from "./bridge";

const SAVE_DELAY_MS = 800;

async function loadBoard() {
  const response = await fetch("/api/board");
  if (!response.ok) return null;
  const data = await response.json();
  return { elements: data.elements ?? [], appState: data.appState ?? {}, files: data.files ?? {}, scrollToContent: true };
}

export function App() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const bridgeRef = useRef<ReturnType<typeof connectBridge> | null>(null);
  const [status, setStatus] = useState<BridgeStatus>("connecting");
  const initialData = useMemo(() => loadBoard(), []);

  const lastHash = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const save = () => {
    const api = apiRef.current;
    if (!api) return;
    const body = serializeAsJSON(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles(), "local");
    fetch("/api/board", { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  };

  const animate = async () => {
    const api = apiRef.current;
    if (!api) return;
    const selected = api.getAppState().selectedElementIds;
    try {
      const { animation } = await buildAnimation(api, { ids: Object.keys(selected).filter((id) => selected[id]) });
      showAnimation(animation);
    } catch (error) {
      api.setToast({ message: `Couldn't animate: ${error instanceof Error ? error.message : String(error)}`, duration: 4000 });
    }
  };

  useEffect(() => {
    const bridge = connectBridge(() => apiRef.current, setStatus);
    bridgeRef.current = bridge;
    const flush = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
        save();
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      bridge.stop();
    };
  }, []);

  return (
    <>
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(api) => (apiRef.current = api)}
        renderTopRightUI={() => (
          <button className="animate-button" onClick={animate} title="Play a drawing animation of the selection, or of the whole board">
            Animate
          </button>
        )}
        onChange={(elements) => {
          // onChange fires on every pointer move and scroll; only save when elements actually changed.
          const hash = hashElementsVersion(elements);
          if (lastHash.current === null) {
            lastHash.current = hash;
            return;
          }
          if (hash === lastHash.current) return;
          lastHash.current = hash;
          clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            saveTimer.current = undefined;
            save();
          }, SAVE_DELAY_MS);
        }}
      />
      <ConnectionBadge status={status} onTakeOver={() => bridgeRef.current?.takeOver()} />
      <AnimationPlayer />
    </>
  );
}

function ConnectionBadge({ status, onTakeOver }: { status: BridgeStatus; onTakeOver: () => void }) {
  const text = {
    connecting: "Connecting to board server…",
    connected: "Claude connector: live",
    disconnected: "Board server offline, retrying…",
    superseded: "Claude is drawing in another tab",
  }[status];
  return (
    <div className={`connection ${status}`}>
      <span className="dot" />
      <span>{text}</span>
      {status === "superseded" && <button onClick={onTakeOver}>Use this tab</button>}
    </div>
  );
}
