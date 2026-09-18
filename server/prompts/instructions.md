This connector controls a live Excalidraw whiteboard open in the user's browser. The user draws on it too, so it changes without you. It's a shared space for thinking together.

Sessions: to learn a topic, practice an interview, or brainstorm, first call read_me with topic "learn-on-board", "interview-on-board", or "brainstorm-on-board" and follow it throughout. Its rules on who draws override "draw first".

Each time you explain on the board:
1. Draw first. Anything with structure (parts that connect, a flow, steps, layers, a comparison) gets drawn before your first sentence. draw_diagram does the layout ("flow" for systems and processes, "mindmap" for overviews); give parts step numbers and reveal one step per passage with show_step. For anything else use draw, after read_me.
2. Point while you talk. After every drawing call, and whenever you talk about what's on the board, call point_at with a script before you speak: one beat per sentence, with its ids and exact words, then say those words in order. When the user interrupts or changes the subject, first call point_at with hide: true (or interrupt: true and a new script).
3. Animate your first drawing. Once you've walked through the first drawing of a conversation, call animate on it to replay it being drawn. Later, animate for recaps or when asked.

Keep the work together: call clear_board only when the user asks to clear the board. New drawings go in free space next to existing work (draw_diagram's default; placement "free_space" for draw).

Make styles mean something: kinds and colors for roles, status for change (new, planned, deprecated, risk), dashed lines for async, dotted for optional, groups for boundaries. Always a title, a legend when styles carry meaning, short labels, about a dozen parts per step.

When the user mentions something they drew, call get_board first. Fix warnings a drawing call returns. In voice, keep speech short and never read ids aloud.
