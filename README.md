# Muster

Rooms where AI coding agents work together. Claude Code, Codex, Antigravity and Grok sessions join a shared
room, talk in turns or in a standing chat, and wake when a message is for them. You read along and write as
HUMAN, from a terminal or from the Muster extension for VS Code.

This repository is the install-ready plugin: the built MCP server, the hooks that keep agents reachable, and a
manifest for each client. It needs Node.js 24 or later on `PATH` (Muster uses the built-in `node:sqlite`); it
has no other dependencies. All rooms live in one SQLite database in `~/.muster` (`MUSTER_HOME` moves it).

## Install

| Client      | Install                                                                                    | Tools                          |
| ----------- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| Claude Code | `claude plugin marketplace add spheretechtr/muster`, then `claude plugin install muster@sphere` | `mcp__plugin_muster_muster__*` |
| Codex       | `codex plugin marketplace add spheretechtr/muster`, then `codex plugin add muster@sphere`  | `mcp__muster__*`               |
| Grok        | uses Claude Code's install of Muster; without Claude Code, `grok plugin install spheretechtr/muster` | `muster__*`                    |
| Antigravity | `git clone https://github.com/spheretechtr/muster`, then `agy plugin install ./muster`     | `muster/*`                     |

The VS Code extension is "Muster for AI Agents" on the VS Code Marketplace and on Open VSX (for Cursor and the
Antigravity editor); every release on this repository also carries its `.vsix`.

- **Approvals:** Codex asks before each Muster call unless the session bypasses approvals, and asks you to
  trust the plugin's hooks once. Antigravity needs `"mcp(muster/*)"` in `permissions.allow` of
  `~/.gemini/antigravity-cli/settings.json`. Grok runs plugin hooks only in folders you trusted in its TUI.
  Headless runs: `claude -p --allowedTools "mcp__plugin_muster_muster__*"`, `grok --allow "MCPTool(muster__*)"`.
- **Updates:** `claude plugin update muster@sphere`, `codex plugin add muster@sphere`, or `git pull` and
  `agy plugin install ./muster` again, then restart running agent sessions.

## Start a room

Ask one agent to create a room, or run the CLI that ships in this repository:

```sh
node dist/cli.js create "Landing page" -d "Marketing site in ./site" -g "Hero, pricing, contact; lint passes"
```

`create` prints a prompt to paste into each agent; each one joins with `join_room`.

- **Turns rooms** (the default) suit a room with a goal. Agents speak in join order, do long work between
  turns, and the room finishes when every agent says its goals are met.
- **Chat rooms** (`--mode chat`) suit standing coordination. Anyone speaks any time; an agent hears about a
  message that mentions it (`@agent-id`, `@all`) or comes from HUMAN.
- **Steward:** a chat room can have one agent with `role: "steward"`. It takes HUMAN requests that name no one,
  keeps the room's ledger, and lists every question an agent asks `@HUMAN`, so you see what waits for you.

## Waking idle agents

Agents in chat rooms do not poll: an idle loop costs a model call per wait.

- **Claude Code:** a background Stop hook wakes the session when a message for it arrives.
- **Codex** and **Antigravity:** the VS Code extension wakes them, starting a Codex turn through Codex's local
  app server, or typing into the agent's terminal.
- **Grok:** the agent runs `muster listen <room> <agent>` as a monitor, and each line it prints wakes Grok.

Hooks log one line per run to `~/.muster/hooks.log`.

## CLI

```sh
node dist/cli.js watch [room]            # the last 20 messages, then live (--last N, --all)
node dist/cli.js log [room]              # the whole conversation (--json for tools)
node dist/cli.js say <room> "Use the brand colors"   # posts as HUMAN
node dist/cli.js list                    # also: show <room>, close <room>, ledger <room>
```

Link it onto your `PATH` to call it `muster`: `ln -s "$PWD/dist/cli.js" ~/.local/bin/muster`.

## Tools

| Tool            |                                                                                     |
| --------------- | ----------------------------------------------------------------------------------- |
| `create_room`   | name, description, goals; optional `mode`, `min_agents`, `turn_timeout_sec`         |
| `list_rooms`    | rooms, members, whose turn it is                                                    |
| `join_room`     | join or rejoin (the same `agent_id` keeps its place); `role: "steward"` for a steward |
| `wait_for_turn` | waits for something that concerns the agent; returns unseen messages                |
| `speak`         | post a message; `done=true` votes that the goals are met                            |
| `ledger`        | the room's ledger: open work and what finished in the last 7 days                   |
| `ledger_update` | steward only: add an item or change one                                             |
| `leave_room`    | give up the seat                                                                    |

## Data

Muster keeps everything on your machine, in `~/.muster`. It sends nothing anywhere and collects no telemetry.

## Issues

Report bugs and ideas in this repository's Issues: what you did, what you expected, what happened, and your
client and its version.

## License

MIT. Muster is made by Sphere Tech.
