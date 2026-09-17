// Instructions and reference guides for Claude. read_me returns one topic at a time, so a
// conversation only pays for the parts it uses.
// The element format and palette started from the excalidraw/excalidraw-mcp cheat sheet (MIT).

export const SERVER_INSTRUCTIONS = `This connector controls a live Excalidraw whiteboard that the user has open in their browser. The user draws and edits on the same board while you talk, so the board changes without you. Many users learn visually: the board is your main way of explaining.

Draw first, then talk:
- Whenever an answer has structure (parts that connect, a flow, steps, layers, a lifecycle, a hierarchy, a comparison, a set of related ideas), draw it. Make the drawing call before your first sentence of explanation, and don't describe in words a picture you could draw.
- draw_diagram does the layout for you: layout "flow" for systems, processes, and concept maps; layout "mindmap" for brainstorming, overviews, and study notes. It needs no read_me.
- Build up while you explain: give parts step numbers and reveal them with show_step, with point: true so your laser pointer sweeps over what just appeared. When you talk about something already on the board, call point_at on it. Use animate to replay a diagram being drawn.
- For anything else (timelines, matrices, comparisons, annotations, free sketches), use draw, and call read_me first. read_me topic "styles" covers every visual property and what it should mean; topic "patterns" has layouts for common explanations.

Make it visual, and make every style mean something:
- The node kind sets shape and color by role. Status marks change: highlight, new, planned (dashed, hatched), deprecated (faded), risk (red).
- Line style is the kind of connection: solid = direct call or main flow, dashed = async, event, or response, dotted = optional or indirect. Arrowheads can carry relationships too (triangle = is a, diamond = owns, crowfoot = many).
- Groups are boundaries; give a group a color to make it a tinted zone. Use size for importance and color for categories, not decoration.
- Add a legend (legend: true, or name the meanings) whenever a diagram uses more than one kind, line style, or status. Give every diagram a title.
- Keep labels to a few words, and keep a step to about a dozen parts.

Reading the board:
- When the user mentions something they drew or changed, points at "this", or asks whether you can see their changes, call get_board first. Never guess what's on the board. Use get_board_image when they drew freehand or when layout matters.
- If a drawing result lists warnings (overlaps, crossings, cramped labels), fix them with another call.

In voice conversations, keep what you say short and never read ids or coordinates aloud.`;

export const GUIDE_TOPICS = ["draw", "styles", "patterns"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

const DRAW = `# Drawing with draw

## How this board works
- It's one shared, persistent board. The user sees every change immediately and can undo your changes with Ctrl+Z.
- get_board lists every element with its id and what the user changed since you last looked. Use it before editing or placing things next to existing content.
- For boxes and arrows, prefer draw_diagram: it does the layout and routing that are hard to get right by hand. Its parts are ordinary elements, so draw can still edit them (a later draw_diagram call on the same diagram re-applies the layout).
- draw takes an array of elements, applied as one undo step:
  - an element whose id is NOT on the board is created
  - an element whose id IS on the board is updated: only the fields you pass change (e.g. {"id":"b1","label":{"text":"New"}} or {"id":"b1","x":400})
  - {"type":"delete","ids":"b1,a1"} removes elements
  - {"type":"cameraUpdate","x":0,"y":0,"width":800,"height":600} moves the user's view (the view also follows new drawings on its own)
  - {"type":"group","ids":"a,b,c"} groups elements so they select and move together; {"type":"ungroup","ids":"a,b"}
  - {"type":"align","ids":"a,b,c","to":"left|center|right|top|middle|bottom"}
  - {"type":"distribute","ids":"a,b,c","axis":"horizontal|vertical"} spaces three or more elements evenly
  - {"type":"order","ids":"zone1","to":"back|front"} changes layers: backgrounds to the back, callouts to the front
  - "point": true (next to "elements") sweeps your laser pointer over what you drew
- placement "right_of_existing" or "below_existing" puts new content next to what's there; your coordinates are then relative to each other.
- The result warns about overlapping shapes, arrows crossing shapes, and labels that wrap or cover shapes. Fix every warning.
- draw_mermaid turns Mermaid into editable shapes; use it for sequence, class, ER, and state diagrams.
- point_at circles shapes, traces arrows, and underlines text; pass several ids to walk through them, or together=true to circle a set.
- animate replays drawing on the user's screen: a draw_diagram frame plays in step order; order (ids) sets a custom story; rest "show" keeps everything else visible.
- Give elements short, meaningful ids ("producer", "topic_orders") so you can update them later.

## Element types
Required: type, id, x, y (and width/height for shapes). Defaults: strokeColor "#1e1e1e", backgroundColor "transparent", fillStyle "solid", strokeWidth 2, roughness 1, opacity 100, fontFamily 5.

- Rectangle: {"type":"rectangle","id":"r1","x":100,"y":100,"width":140,"height":56,"roundness":{"type":3},"backgroundColor":"#a5d8ff"}
- Ellipse / diamond: same fields with "type":"ellipse" or "type":"diamond"
- Labeled shape (preferred): add "label":{"text":"Hello","fontSize":18}. Label options: fontSize, fontFamily, strokeColor (text color), textAlign "left|center|right", verticalAlign "top|middle|bottom" (top-left suits zone titles). The shape grows to fit.
- Standalone text: {"type":"text","id":"t1","x":100,"y":40,"text":"Title","fontSize":28,"fontFamily":7,"strokeColor":"#1971c2"}. x is the left edge; width ≈ characters × fontSize × 0.5.
- Arrow between shapes (preferred): {"type":"arrow","id":"a1","x":0,"y":0,"start":{"id":"r1"},"end":{"id":"r2"},"label":{"text":"calls"}}
  - start/end can be shapes from this call or already on the board; the arrow is routed and stays attached when shapes move.
  - Routing: "elbowed":true for right angles, "roundness":{"type":2} for a curve, neither for straight.
  - Free arrow: {"type":"arrow","id":"a2","x":300,"y":150,"points":[[0,0],[200,0]]}. Points are offsets from x,y; add middle points to route around shapes.
  - "startArrowhead" / "endArrowhead": see read_me topic "styles".
- Line: like a free arrow with "type":"line" (dividers, axes, timelines).
- Frame (a titled section, like a slide): {"type":"frame","id":"f_kafka","name":"Kafka","x":0,"y":0,"width":1000,"height":700}. Put elements inside with "frameId":"f_kafka". set_view on a frame id presents it.
- Any element: "link":"https://..." makes it clickable; "locked":true stops accidental drags (good for background zones).

Array order is layer order: backgrounds first, then shapes, then arrows and callouts.

## Sizing, spacing, alignment
- Fonts: 36 hero title, 28 frame title, 20 section heading, 18 shape labels, 16 arrow labels and body, 14 small annotations.
- Size shapes to their label: about label width + 32 wide and 48-56 tall. Oversized boxes leave arrows too short for their labels.
- The gap between connected shapes must fit the arrow's label: at least the label's width (about characters × 8 at size 16) + 40px, never under 60px. Arrow labels wider than about 170px wrap.
- Snap to a 20px grid, line up related shapes on a shared edge or center, and keep equal gaps between siblings (align and distribute do this).
- Leave 40px+ around groups and 80px+ between separate ideas; whitespace separates ideas better than lines do.
- A view of about 1200×800 fits comfortably. Use frames or cameraUpdate to show one idea at a time.

## Example: two connected boxes next to existing content
{"placement":"right_of_existing","point":true,"elements":[
  {"type":"rectangle","id":"producer","x":0,"y":0,"width":130,"height":56,"roundness":{"type":3},"backgroundColor":"#a5d8ff","label":{"text":"Producer","fontSize":18}},
  {"type":"rectangle","id":"topic","x":250,"y":0,"width":160,"height":56,"roundness":{"type":3},"backgroundColor":"#d0bfff","label":{"text":"Topic: orders","fontSize":18}},
  {"type":"arrow","id":"produce","x":0,"y":0,"start":{"id":"producer"},"end":{"id":"topic"},"label":{"text":"publish","fontSize":16}}
]}

## Example: update, restyle, arrange
[{"id":"topic","label":{"text":"Topic: orders (3 partitions)"}},{"id":"legacy_api","opacity":35,"strokeStyle":"dotted"},{"type":"align","ids":"producer,topic","to":"middle"},{"type":"delete","ids":"old_note"}]
`;

const STYLES = `# Visual language

Give each visual channel one meaning and keep it for the whole board. Explain the meanings in a legend.

## Color (backgroundColor fill / strokeColor for borders and text)
| Name | Fill | Stroke/text | Zone tint | Default meaning |
|---|---|---|---|---|
| blue | #a5d8ff | #1971c2 | #e7f5ff | components, steps, main content |
| yellow | #ffec99 | #f08c00 | #fff9db | people, entry points, central topic, decisions |
| teal | #c3fae8 | #0c8599 | #e6fcf5 | data, storage |
| purple | #d0bfff | #6741d9 | #f3f0ff | queues, events, processing |
| orange | #ffd8a8 | #e8590c | #fff4e6 | external or third-party |
| green | #b2f2bb | #2f9e44 | #ebfbee | success, outputs, new |
| red | #ffc9c9 | #e03131 | #fff5f5 | errors, risks, warnings |
| pink | #fcc2d7 | #c2255c | #fff0f6 | questions, ideas to explore |
| gray | #e9ecef | #495057 | #f8f9fa | notes, context, out of scope |
- Text: #1e1e1e body, #495057 secondary, #868e96 annotations (the lightest you should use on white). Colored text (a stroke color) ties words to a category or mind map branch.
- Use at most about five colors in one view, and don't let color be the only cue (pair it with shape, border, or a label) for color-blind viewers.

## Fill (fillStyle; needs a backgroundColor)
- "solid": the default, clearest.
- "hachure": sketchy diagonal lines. Drafts, planned or estimated parts, "work in progress".
- "cross-hatch": dense lines. Blocked, restricted, or hot areas.
- "zigzag": a lively highlight for callouts.
- backgroundColor "transparent": outline only, for secondary items or containers.

## Stroke
- strokeWidth: 1 thin (secondary items, boundaries, deep mind map branches), 2 normal, 4 bold (the key path, what's new, main branches).
- strokeStyle: "solid" direct or definite, "dashed" asynchronous, planned, or logical boundaries, "dotted" optional, indirect, weak, or deprecated.
- Boundaries: dashed thin border = logical boundary (a service, team, module); solid thin border with a zone tint = hard boundary (network, trust zone, account); dotted = loose or proposed grouping. Put zones at the back (order op) and title them top-left (label textAlign "left", verticalAlign "top").
- roughness: 0 architect (clean and formal), 1 artist (default hand-drawn), 2 cartoonist (brainstorming, playful). Keep one roughness per diagram.
- roundness: {"type":3} rounded boxes for components and friendly concepts; null sharp corners for data, documents, and formal things.

## Opacity (0-100)
- 100 normal. 30-50: deprecated, removed, "before" state, ghosted future steps, or background context. Zones and watermarks: 20-40.
- Opacity fades the whole element, so also fade its label (label opacity) and keep it readable (at least 30).

## Arrows
- Type: straight (default), curved ("roundness":{"type":2}; organic, mind maps, feedback loops), elbow ("elbowed":true; architecture, tidy flows).
- endArrowhead / startArrowhead: "arrow" direction or flow; "triangle" is a / inherits; "triangle_outline" implements; "diamond" owns (composition); "diamond_outline" has (aggregation); "dot" uses or association; "circle" / "circle_outline" optional end; "bar" stop, blocked, or limit; "crowfoot_one", "crowfoot_many", "crowfoot_one_or_many" cardinality in data models; null for plain connections (mind maps, trees, undirected relations).
- Two-way: set both arrowheads. Weight and color work as for shapes: bold for the main path, a branch or category color to tie arrows to their source.

## Text and fonts (fontFamily)
- 5 Excalifont: hand-drawn, the default. 6 Nunito: clean and very readable for dense text. 7 Lilita One: bold display face for titles and big numbers. 8 Comic Shanns: code, identifiers, commands. 3 Cascadia: monospace alternative.
- Size shows hierarchy: 36 hero, 28 title, 20 heading, 16-18 body, 14 annotation. Use no more than three sizes in one view.
- No emoji: the fonts can't render them. Draw a small shape instead.

## Structure
- Frames: one idea or chapter per frame, each with a name. Lay frames out left to right like slides and use set_view to present one.
- Groups (group op): elements that belong together (a legend, a card with its caption) so they move as one.
- Layers (order op): zones and backgrounds at the back, callouts and highlights at the front.
- Alignment (align, distribute): shared edges and even gaps make a diagram look deliberate.
- Legend: a small titled box with one sample per style and its meaning, below or at the right of the diagram. draw_diagram builds one with legend: true.
- Locked elements ("locked":true) for zones and backgrounds the user shouldn't move by accident.
`;

const PATTERNS = `# Patterns for explaining visually

Pick the shape of the picture from the shape of the idea. Every picture gets a title, and a legend when styles carry meaning.

## Built with draw_diagram
- Mind map (brainstorming, a topic overview, study notes): layout "mindmap". The first node is the center; connect each idea to the one it branches from. One to three words per node, four to seven main branches, details one level deeper. Branch colors, curved branches, and shrinking sizes are automatic. Mark open questions with kind "question" and link related ideas across branches with a dotted edge and a verb label.
- Concept map (how ideas relate): layout "flow", arrows "curved", every edge labeled with a verb ("causes", "is part of", "depends on"). Kinds or colors for categories, plus a legend.
- Process or flowchart: layout "flow", direction "right" (or "down" for long ones). Decisions as kind "decision" with "yes"/"no" edge labels; end states as "success" and "error".
- System architecture: groups as boundaries (dashed for services and teams, colored zones for networks and trust zones), kinds for roles, line styles for sync or async, status "new" and "deprecated" for a change, legend: true.
- Hierarchy or taxonomy (org chart, class tree): layout "flow", direction "down", arrows "elbow", head "none" (or "triangle" for inheritance).
- Data model: kinds "store", edges with head "crowfoot_many" and tail "crowfoot_one", labels naming the relation.
- Cycle or feedback loop: layout "flow", arrows "curved", with the last edge back to the first node.
- Swimlanes (who does what): one colored group per actor, direction "right", steps in order.
- Step-by-step story: step numbers on parts, show_step 1, 2, 3 with point: true while you explain each step; animate at the end to replay it.

## Built with draw
- Timeline: a long horizontal line (strokeWidth 2), small filled ellipses (16×16) as events, labels alternating above and below, dates in gray 14px, eras as tinted zones behind (opacity 40).
- Comparison (A vs B, pros and cons): two frames or two columns with identical structure and aligned rows, headers in Lilita One, differences highlighted with color or bold borders, matching items connected by dotted lines if helpful.
- 2×2 matrix: two axis lines with arrowheads, axis labels at the ends, four tinted zones (opacity 30) with titles top-left, items as small cards placed by position.
- Layered stack (OSI model, abstraction levels): full-width rectangles stacked top to bottom with equal heights, a color ramp from light to strong, and side arrows for requests going down and responses coming up (dashed).
- Before and after: two frames side by side with the same layout. Removed parts faded (opacity 35, dotted), added parts green and bold, and a shared legend.
- Venn or overlap: two or three ellipses with opacity 40 fills overlapping, labels outside, the shared item in the middle.
- Funnel or pipeline stages: shrinking rectangles stacked or in a row, numbers beside each stage in Lilita One.
- Callout: a note (gray or yellow fill, sharp corners) near the thing it explains, connected by a thin dotted line, brought to the front.
- Slides: one frame per idea in a row, each frame a single message; present with set_view on each frame while you talk.

## Principles
- One idea per shape, a few words per label. Put detail in a note, not on an arrow.
- Similar things look alike; different things look different; important things look bigger or bolder.
- Proximity shows relatedness: group related parts and leave space between unrelated ones.
- Read left to right or top to bottom; start from the entry point or the center.
- Chunk: about a dozen parts per view or step. Split a big picture into frames or steps.
- Show where attention should go right now: point_at, status "highlight", or fade what's not in focus.
`;

export const GUIDES: Record<GuideTopic, string> = { draw: DRAW, styles: STYLES, patterns: PATTERNS };
