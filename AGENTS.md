# Notes for coding agents

See README.md for setup, scripts, and where things live. This file covers what's easy to break without noticing.

## Prompts Claude reads

The connector's behaviour is mostly prose: `server/prompts/instructions.md` (sent as the MCP server instructions), the `read_me` topics and session playbooks in `server/prompts/`, and the tool descriptions in `server/tools.ts`.

- **Clients cut text off at 2048 characters**, for the instructions and for each tool description, without telling Claude. Anything past the limit silently stops happening. That's how the laser pointer stopped being used: a paragraph added at the top of the instructions pushed the pointing rules past the cutoff.
- The server refuses to start if `instructions.md` is over the limit, and `npm run typecheck` (or `npm run check:prompts`) checks the instructions and every tool description. Run it after any prompt change.
- Keep `instructions.md` well under the limit and put the most important behaviour first. Anything added near the top pushes everything below it toward the cutoff. Put detail in the tool it's about or in a `read_me` topic, which have no such limit.
- These behaviours are relied on; don't word them away: draw before explaining, a `point_at` script after every drawing call and whenever the board is discussed, and `animate` after walking through the first drawing of a conversation. Softening phrases ("you don't need X", "only use X when...") stop the model from doing X at all.
- Instructions are read when a client connects. After changing prompts, restart the server and reconnect the connector before judging the result.
