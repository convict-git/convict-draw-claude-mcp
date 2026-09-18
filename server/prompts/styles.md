# Visual language

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
