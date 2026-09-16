// Instructions and element format reference for Claude.
// The element format, palette, and sizing rules are adapted from the official
// excalidraw/excalidraw-mcp cheat sheet (MIT), trimmed for a shared, persistent board.

export const SERVER_INSTRUCTIONS = `This connector controls a live Excalidraw whiteboard that the user has open in their browser. The user draws and edits on the same board while you talk, so the board changes without you.

- Call read_me once before your first drawing in a conversation.
- When the user mentions something they drew or changed, points at "this", or asks whether you can see their changes, call get_board first. Never guess what's on the board. Use get_board_image when they drew freehand or when layout matters.
- Draw in small steps while you explain, rather than one huge diagram.
- In voice conversations, keep what you say short and never read ids or coordinates aloud.`;

export const GUIDE = `# Excalidraw board guide

You've read the guide; no need to call read_me again in this conversation.

## How this board works
- It's one shared, persistent board. The user sees every change immediately and can undo your changes with Ctrl+Z.
- get_board lists every element with its id and what the user changed since you last looked. Use it before editing or placing things next to existing content.
- draw takes an array of elements:
  - an element whose id is NOT on the board is created
  - an element whose id IS on the board is updated: only the fields you pass change (e.g. {"id":"b1","label":{"text":"New"}} or {"id":"b1","x":400})
  - {"type":"delete","ids":"b1,a1"} removes elements
  - {"type":"cameraUpdate","x":0,"y":0,"width":800,"height":600} moves the user's view
- Use placement "right_of_existing" or "below_existing" in draw to put a new diagram next to what's already there without computing coordinates. Your coordinates are then relative to each other.
- draw_mermaid turns Mermaid (flowchart, sequence, class, ER, state) into editable shapes and is the fastest way to lay out a graph. Other Mermaid types become a single image.
- Give your elements short, meaningful ids ("producer", "topic_orders") so you can update them later. Never reuse the id of a deleted element.

## Element types
Required: type, id, x, y (and width/height for shapes). Defaults: strokeColor "#1e1e1e", backgroundColor "transparent", fillStyle "solid", strokeWidth 2, roughness 1, opacity 100.

- Rectangle: {"type":"rectangle","id":"r1","x":100,"y":100,"width":200,"height":80}
  - rounded corners: "roundness":{"type":3}; filled: "backgroundColor":"#a5d8ff"
- Ellipse / diamond: same fields with "type":"ellipse" or "type":"diamond"
- Labeled shape (preferred): add "label":{"text":"Hello","fontSize":20}. The text is centered and the shape grows to fit. No separate text element needed.
- Standalone text (titles, notes): {"type":"text","id":"t1","x":100,"y":40,"text":"Title","fontSize":28}. x is the left edge; width ≈ characters × fontSize × 0.5.
- Arrow between shapes (preferred): {"type":"arrow","id":"a1","x":0,"y":0,"start":{"id":"r1"},"end":{"id":"r2"},"label":{"text":"calls"}}
  - start/end can point at shapes in the same draw call or already on the board; the arrow is routed and stays attached when shapes move.
  - Free arrow: {"type":"arrow","id":"a2","x":300,"y":150,"points":[[0,0],[200,0]],"endArrowhead":"arrow"}. Points are offsets from x,y.
  - Arrowheads: null | "arrow" | "bar" | "dot" | "triangle". Dashed: "strokeStyle":"dashed".
- Line: like a free arrow with "type":"line".
- Frame (a named section, good for one topic): {"type":"frame","id":"f_kafka","name":"Kafka","x":0,"y":0,"width":1000,"height":700}. Put elements inside with "frameId":"f_kafka".

Array order is drawing order: background first, then each shape followed by its arrows.

## Colors
Strokes/accents: blue #4a9eed, amber #f59e0b, green #22c55e, red #ef4444, purple #8b5cf6, pink #ec4899, cyan #06b6d4.
Pastel fills: light blue #a5d8ff (inputs, sources), light green #b2f2bb (outputs, success), light orange #ffd8a8 (external, pending), light purple #d0bfff (processing), light red #ffc9c9 (errors), light yellow #fff3bf (notes, decisions), light teal #c3fae8 (storage, data).
Background zones (use "opacity":35): #dbe4ff, #e5dbff, #d3f9d8.
Text on white must be #757575 or darker. Don't use emoji; the hand-drawn font can't render them.

## Sizing
- Font size: at least 16 for labels, 20+ for titles, 14 only for small annotations.
- Labeled shapes: at least 120×60. Leave 40px+ gaps between shapes. Prefer fewer, larger elements.
- Keep arrow labels short, or make the arrow long enough for the label.
- The user's screen is large; a diagram of about 1000×700 fits comfortably. Use cameraUpdate (4:3, e.g. 800×600 or 1200×900) to focus the user's view on what you're explaining.

## Example: two connected boxes, placed next to existing content
{"placement":"right_of_existing","elements":[
  {"type":"rectangle","id":"producer","x":0,"y":0,"width":180,"height":80,"roundness":{"type":3},"backgroundColor":"#a5d8ff","label":{"text":"Producer","fontSize":20}},
  {"type":"rectangle","id":"topic","x":300,"y":0,"width":200,"height":80,"roundness":{"type":3},"backgroundColor":"#c3fae8","label":{"text":"Topic: orders","fontSize":20}},
  {"type":"arrow","id":"produce","x":0,"y":0,"start":{"id":"producer"},"end":{"id":"topic"},"label":{"text":"publish","fontSize":16}}
]}

## Example: update and delete
[{"id":"topic","label":{"text":"Topic: orders (3 partitions)"}},{"id":"producer","backgroundColor":"#b2f2bb"},{"type":"delete","ids":"old_note"}]
`;
