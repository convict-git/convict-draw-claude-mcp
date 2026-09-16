# Claude Whiteboard

A local Excalidraw board that Claude can draw on and read through a connector (MCP server), while you draw on the same board in your browser.

```
 you ──draw──► Excalidraw tab (localhost:3170) ◄──WebSocket──► board server ◄── connector (/mcp/<secret>) ◄── Claude
```

- **Claude draws:** the `draw` / `draw_mermaid` tools send changes to the board server, which applies them to the open tab.
- **Claude reads:** `get_board` pulls the live board on demand, including what you changed since Claude last looked. `get_board_image` returns a picture, which helps with freehand sketches.
- **You draw:** use the board at http://localhost:3170 as normal. Everything is saved to `.data/board.excalidraw`.

## Setup (once)

```bash
npm install
npm run build
```

To reach the board from the Claude app (web, desktop, phone, voice mode) you also need a tunnel, because Claude connects to connectors from Anthropic's cloud rather than from your computer:

```bash
brew install cloudflared
```

## Each session

1. **Start the server**

   ```bash
   npm start
   ```

   It prints the board URL and your connector path, `/mcp/<secret>`. The secret is generated once and stored in `.data/connector-secret`.

2. **Open the board**: http://localhost:3170 in Chrome. The badge at the bottom right should say **Claude connector: live**.

3. **Start a tunnel** in a second terminal:

   ```bash
   npm run tunnel
   ```

   Copy the `https://….trycloudflare.com` address it prints.

4. **Add the connector in Claude** (first time, or whenever the tunnel address changes): Settings → Connectors → **Add custom connector**.
   - URL: `https://<tunnel-address>/mcp/<secret>`
   - Leave the OAuth fields empty.

   Then, in the connector's settings, set its tools to **Always allow**, so Claude doesn't stop to ask permission mid-conversation.

5. **Talk to Claude.** Make sure the connector is enabled for the chat, then start voice mode and try:
   - "Let's learn Kafka. Sketch the producer side on my whiteboard as you explain."
   - "I added a box for partitions. Can you see it?"
   - "Turn that into a flowchart with the consumers on the right."
   - "Zoom to show everything."

To check the tunnel and connector from your computer:

```bash
npm run smoke -- https://<tunnel-address>/mcp/<secret>
```

This draws a small diagram on the board and removes it again.

### Check that voice mode can use it

Claude's voice mode officially lists built-in connectors (Gmail, Calendar, and so on), and there are reports of custom connector tools failing only in voice mode. Test it once:

1. In a **text** chat with the connector enabled, ask "What's on my whiteboard?". Claude should call `get_board`.
2. Ask the same in **voice mode**.

If voice mode can't call the tools, the same server still works from:
- **Claude app text chat:** type instead of talking.
- **Claude Code on this computer:** no tunnel needed. Add the connector with `claude mcp add --transport http excalidraw-board http://localhost:3170/mcp/<secret>`, then use `/voice` to dictate.

### A tunnel address that doesn't change

`cloudflared tunnel --url` gives a new address every run, so you'd update the connector URL each session. For a fixed address, use either of these:

- **Tailscale Funnel** (Tailscale is already installed on this Mac): run `tailscale funnel --bg 3170`, then use `https://<machine>.<tailnet>.ts.net/mcp/<secret>`. Funnel must be enabled for your tailnet.
- **A named Cloudflare tunnel** on your own domain.

## Tools Claude gets

| Tool | What it does |
|---|---|
| `read_me` | Explains the board and the element format (shapes, labels, arrows, frames, colors, sizing). Claude calls it once per chat. |
| `get_board` | The live board as text: every element with its id, label, position and whether you or Claude drew it; what you've selected; and **your changes since Claude last looked**. |
| `get_board_image` | A PNG of the whole board, your current view, or your selection. |
| `draw` | Create elements (new id), update existing ones (existing id, only the fields given), delete (`{"type":"delete","ids":"a,b"}`), or move your view (`cameraUpdate`). Arrows can connect to any shape, including ones you drew. |
| `draw_mermaid` | Mermaid → editable shapes with automatic layout (flowchart, sequence, class, ER, state). |
| `set_view` | Fit everything, the selection, or given elements; show an area; or set the zoom level. |
| `clear_board` | Start over. You can undo it. |

## Good to know

- **The board tab has to be open.** Claude's drawing runs inside the tab, because Excalidraw only runs in a browser. If it's closed, Claude is told to ask you to open it.
- **You can undo Claude.** Each Claude change is one undo step (Cmd/Ctrl+Z or the undo button).
- **Claude sees your changes when it looks.** A connector can't push messages into a Claude conversation. Claude is instructed to call `get_board` whenever you mention the board. After Claude draws, it's also told if you've changed things it hasn't seen yet.
- **One board per server.** It's saved to `.data/board.excalidraw`. You can open that file on excalidraw.com, or copy it to keep a session.
- **Only one tab is live.** If you open the board in a second tab, that tab takes over. The first shows a "Use this tab" button.
- **The secret URL is the password.** Through a tunnel, only `/mcp/<secret>` is reachable. The board page, its API and the WebSocket are limited to this computer. Anyone with the full connector URL can read and draw on your board while the tunnel runs, so stop the tunnel when you're done. For a new secret, delete `.data/connector-secret` and restart.

## Development

```bash
npm run dev:web     # board UI with hot reload on http://localhost:5173 (keep `npm start` running)
npm run typecheck
npm run smoke       # exercise the tools against http://localhost:3170
npx tsx scripts/call-tool.ts get_board '{}'   # call a single tool
```

| Path | Contents |
|---|---|
| `server/index.ts` | HTTP server: MCP endpoint, board API, WebSocket, access rules |
| `server/tools.ts` | The connector's tools |
| `server/describe.ts` | Board outline and change detection that Claude reads |
| `server/guide.ts` | Instructions and element format for Claude (adapted from [excalidraw/excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp), MIT) |
| `server/board.ts` | Forwards commands to the open tab; saves the board file |
| `web/src/commands.ts` | Runs Claude's commands on the live Excalidraw board |
| `web/src/App.tsx`, `bridge.ts` | The board page and its connection to the server |
| `shared/protocol.ts` | Message types shared by server and page |
