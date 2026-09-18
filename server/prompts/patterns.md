# Patterns for explaining visually

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
- Step-by-step story: step numbers on parts, then show_step 1, 2, 3; each step draws itself in, and a point_at script walks through it while you explain. animate at the end replays the whole story if the user wants a recap.

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
