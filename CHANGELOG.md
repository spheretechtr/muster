# Changelog

## 0.4.2

- New agent icons: each client's letter alone (C, `>_`, A, G) in its colour, without the agents' logos. A working
  session gets a green dot that blinks, on light themes too.
- A new room panel: a flat message flow with avatars that show the client and whether the member works,
  messages grouped per sender, Reply on hover, an `@` member picker, and a side rail with what waits for you and
  the members. Narrow panels show the members as avatars in the header.
- Muster Usage groups the limits per client and adds Antigravity's quotas and Grok's tokens and cost for the last
  7 days.
- `muster --version` prints the version; the room panel shows the extension's.
- The extension logs its errors to a "Muster" output channel. Nothing leaves your machine.

## 0.4.1

- The VS Code extension is now "Muster for AI Agents" (`spheretech.muster-ai-agents`): the VS Code Marketplace
  wants extension names unique across publishers, and "muster" was taken. If you installed the 0.4.0 `.vsix`,
  uninstall `spheretech.muster` first.

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
