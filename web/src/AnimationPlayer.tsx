import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { closeAnimation, currentAnimation, serializeAnimation, subscribeAnimation, type Animation } from "./animate";

// Shapes that are already visible get a moment on screen before the drawing starts.
const LEAD_IN_MS = 700;

/** Full-screen player for the current animation. Esc closes it, Space pauses, R replays. */
export function AnimationPlayer() {
  const animation = useSyncExternalStore(subscribeAnimation, currentAnimation);
  return animation ? <Player key={animation.id} animation={animation} /> : null;
}

function Player({ animation }: { animation: Animation }) {
  const playerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const leadIn = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const { svg, finishedMs, startMs } = animation;

  const replay = useCallback(() => {
    clearTimeout(leadIn.current);
    svg.pauseAnimations();
    svg.setCurrentTime(startMs / 1000);
    setPaused(false);
    leadIn.current = setTimeout(() => svg.unpauseAnimations(), startMs ? LEAD_IN_MS : 0);
  }, [svg, startMs]);

  const togglePause = useCallback(() => {
    clearTimeout(leadIn.current);
    if (paused) {
      // Resuming after the end starts over.
      if (svg.getCurrentTime() * 1000 >= finishedMs) svg.setCurrentTime(startMs / 1000);
      svg.unpauseAnimations();
    } else svg.pauseAnimations();
    setPaused(!paused);
  }, [svg, finishedMs, startMs, paused]);

  // Mount the SVG, scaled to fit the screen, and start playing.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const scale = Math.min((stage.clientWidth * 0.94) / animation.width, (stage.clientHeight * 0.94) / animation.height, 2);
      svg.style.width = `${animation.width * scale}px`;
      svg.style.height = `${animation.height * scale}px`;
    };
    fit();
    stage.appendChild(svg);
    // Take focus from whatever opened the player, so Space doesn't press that button again.
    playerRef.current?.focus();
    replay();
    window.addEventListener("resize", fit);
    return () => {
      clearTimeout(leadIn.current);
      window.removeEventListener("resize", fit);
      svg.remove();
    };
  }, [animation, svg, replay]);

  // Progress bar
  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      const done = Math.min(1, Math.max(0, (svg.getCurrentTime() * 1000 - startMs) / Math.max(1, finishedMs - startMs)));
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${done})`;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [svg, finishedMs, startMs]);

  // Keys go to the player, not to the board underneath.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.type === "keyup") return;
      if (event.key === "Escape") closeAnimation();
      else if (event.key === " ") {
        event.preventDefault();
        togglePause();
      } else if (event.key.toLowerCase() === "r" && !event.metaKey && !event.ctrlKey) replay();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [togglePause, replay]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([serializeAnimation(animation)], { type: "image/svg+xml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `whiteboard-animation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div ref={playerRef} tabIndex={-1} className={`animation-player${animation.dark ? " dark" : ""}`} role="dialog" aria-label="Board animation">
      <div className="stage" ref={stageRef} onClick={togglePause} />
      <div className="controls">
        <div className="progress">
          <div ref={progressRef} />
        </div>
        <button onClick={togglePause} title="Space">
          {paused ? "Play" : "Pause"}
        </button>
        <button onClick={replay} title="R">
          Replay
        </button>
        <button onClick={download} title="Save as an animated SVG">
          Save SVG
        </button>
        <button onClick={closeAnimation} title="Esc">
          Close
        </button>
      </div>
    </div>
  );
}

