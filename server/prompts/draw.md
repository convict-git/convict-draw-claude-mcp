# Drawing with draw

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
- For a new drawing, pass placement "free_space": the elements move together to the nearest empty spot next to the existing work, so nothing overlaps and everything stays close. Your coordinates are then only relative to each other. ("right_of_existing" / "below_existing" put it past the edge of everything instead.) Keep your own coordinates for edits and annotations next to specific elements.
- Never clear the board to make room; see the instructions on keeping work together.
- The result warns about overlapping shapes, arrows crossing shapes, and labels that wrap or cover shapes. Fix every warning.
- draw_mermaid turns Mermaid into editable shapes; use it for sequence, class, ER, and state diagrams.
- point_at circles shapes, traces arrows, and underlines text; pass several ids to walk through them, together=true to circle a set, or a script to pace it to what you're saying.
- New elements draw themselves in on the board (animate: false to skip that). The animate tool replays drawing in a full-screen player: a draw_diagram frame plays in step order; order (ids) sets a custom story; rest "show" keeps everything else visible.
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
- The gap between connected shapes must fit the arrow's label with arrow showing on both sides: at least the label's width (about characters × 8 at size 16) + 60px, never under 60px. Excalidraw hides the arrow under its label, so a shorter gap leaves only the text. Arrow labels wider than about 170px wrap. If shapes can't move apart, use an elbow or curved arrow with a longer run, or shorten the label.
- Snap to a 20px grid, line up related shapes on a shared edge or center, and keep equal gaps between siblings (align and distribute do this).
- Leave 40px+ around groups and 80px+ between separate ideas; whitespace separates ideas better than lines do.
- A view of about 1200×800 fits comfortably. Use frames or cameraUpdate to show one idea at a time.

## Example: two connected boxes next to existing content
{"placement":"free_space","point":true,"elements":[
  {"type":"rectangle","id":"producer","x":0,"y":0,"width":130,"height":56,"roundness":{"type":3},"backgroundColor":"#a5d8ff","label":{"text":"Producer","fontSize":18}},
  {"type":"rectangle","id":"topic","x":250,"y":0,"width":160,"height":56,"roundness":{"type":3},"backgroundColor":"#d0bfff","label":{"text":"Topic: orders","fontSize":18}},
  {"type":"arrow","id":"produce","x":0,"y":0,"start":{"id":"producer"},"end":{"id":"topic"},"label":{"text":"publish","fontSize":16}}
]}

## Example: update, restyle, arrange
[{"id":"topic","label":{"text":"Topic: orders (3 partitions)"}},{"id":"legacy_api","opacity":35,"strokeStyle":"dotted"},{"type":"align","ids":"producer,topic","to":"middle"},{"type":"delete","ids":"old_note"}]
