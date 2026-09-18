// Instructions and reference guides for Claude, written in server/prompts/*.md. read_me returns one
// topic at a time, so a conversation only pays for the parts it uses.
// The element format and palette started from the excalidraw/excalidraw-mcp cheat sheet (MIT).
import fs from "node:fs";

/** Clients cut server instructions off after this many characters (Claude Code does), and tool descriptions too. */
export const MAX_INSTRUCTIONS = 2048;
export const MAX_TOOL_DESCRIPTION = 2048;

export const PLAYBOOKS = ["learn-on-board", "interview-on-board", "brainstorm-on-board"] as const;
export type Playbook = (typeof PLAYBOOKS)[number];
export const GUIDE_TOPICS = ["draw", "styles", "patterns", ...PLAYBOOKS] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

function prompt(name: string) {
  return fs.readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");
}

export const SERVER_INSTRUCTIONS = prompt("instructions").trimEnd();
// Anything past the limit never reaches Claude, and nothing says so: refuse to start instead.
if (SERVER_INSTRUCTIONS.length > MAX_INSTRUCTIONS) {
  throw new Error(
    `server/prompts/instructions.md is ${SERVER_INSTRUCTIONS.length} characters; clients cut it off after ${MAX_INSTRUCTIONS}. Shorten it, or move detail into tool descriptions or read_me topics.`,
  );
}

// Session playbooks are about how to behave as a companion on the board, not how to draw. Each one is
// served by read_me and as an MCP prompt of the same name.
export const GUIDES = Object.fromEntries(GUIDE_TOPICS.map((topic) => [topic, prompt(topic)])) as Record<GuideTopic, string>;

export const PLAYBOOK_INFO: Record<Playbook, { title: string; description: string; argument: string }> = {
  "learn-on-board": {
    title: "Learn on the board",
    description: "Learn a topic with Claude as a tutor at the whiteboard: it checks what you know, explains step by step, and has you draw to check your understanding.",
    argument: "What you want to learn, e.g. \"Kafka\" or \"how TLS works\".",
  },
  "interview-on-board": {
    title: "Interview on the board",
    description: "Practice an interview with Claude as the interviewer: you design on the whiteboard, Claude asks questions, then gives feedback marked on your diagram.",
    argument: "The kind of interview or a problem, e.g. \"system design, senior\" or \"design a URL shortener\".",
  },
  "brainstorm-on-board": {
    title: "Brainstorm on the board",
    description: "Brainstorm with Claude as a thinking partner: collect ideas on the whiteboard, group them, pick the best, and plan next steps.",
    argument: "The question or problem to brainstorm, e.g. \"features for our next release\".",
  },
};
