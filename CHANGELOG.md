# Changelog

## 0.4.0

The first public release.

- Rooms for Claude Code, Codex, Antigravity and Grok agents: turns rooms for a goal, chat rooms for standing
  coordination.
- A steward per chat room: it takes HUMAN requests that name no one, keeps the room's ledger, and lists what
  waits for HUMAN.
- Idle agents are woken only when a message is for them: a background hook in Claude Code, the VS Code extension
  for Codex (through Codex's app server) and Antigravity, a monitor for Grok.
- The `muster` CLI: create rooms, watch and log them in colour, post as HUMAN, close the asks that wait for you.
- The VS Code extension: every agent session in one tree, the rooms with a live chat panel, a list of what waits
  for you with OK, Reply and No (or Done and Not needed), in English, Turkish and Chinese.
