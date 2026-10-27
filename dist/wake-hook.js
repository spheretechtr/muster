#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import{createRequire}from'module';const require=createRequire(import.meta.url);

// apps/muster-plugin/src/wake-hook.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// apps/muster-plugin/src/store.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// apps/muster-plugin/src/home.ts
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var musterHome = () => process.env.MUSTER_HOME ?? join(homedir(), ".muster");
var dbPath = () => join(musterHome(), "rooms.db");

// apps/muster-plugin/src/store.ts
var STEWARD_FALLBACK_MS = 10 * 6e4;
var LEDGER_RECENT_MS = 7 * 864e5;
function addressedTo(m, agentId, routing, now = Date.now()) {
  const { mode, steward } = routing;
  if (m.kind !== "human")
    return mode === "chat" && (mentions(m.content, agentId) || steward?.agentId === agentId && mentions(m.content, "human"));
  if (mode !== "chat" || !steward || steward.agentId === agentId) return true;
  return mentions(m.content, agentId) || steward.lastSeen < m.id && now - m.created_at >= STEWARD_FALLBACK_MS;
}
function mentions(content, agentId) {
  const id = agentId.toLowerCase();
  const text = content.toLowerCase();
  if (text.trimStart().startsWith(`${id}:`)) return true;
  return [...text.matchAll(/@([a-z0-9._-]+)/g)].some(([, raw = ""]) => {
    const name = raw.replace(/[.]+$/, "");
    return name === id || name === "all" || name === "everyone";
  });
}

// apps/muster-plugin/src/format.ts
var QUIET_SESSION = "Handle room messages in the room. In your own session, write at most one short line about them (or nothing): your user reads every session and does not want room traffic summarized there. Anything your user must approve or do goes to the room as one message that mentions @HUMAN and starts with the action, not to your session.";
var CHAT_PROTOCOL = `HOW THIS ROOM WORKS (chat mode: no turns)
- Speak any time with speak(room_id, agent_id, message). There is no turn order.
- wait_for_turn returns when something concerns you: a message that mentions you (@your-id, @all, or "your-id:" at the start) or any HUMAN message. In a room with a steward (marked in MEMBERS), a HUMAN message that mentions nobody goes to the steward, which forwards what concerns you. Other messages are delivered with your next wakeup.
- When wait_for_turn says nothing is for you, end your turn instead of calling it again. Idling costs nothing: a message for you wakes you (Claude Code through its hook, Grok through its monitor, Codex and Antigravity through a line Muster types into your terminal), or reaches you when your next turn ends.
- Mention the agents who need to know (@agent-id); use @all only when everyone must act or know.
- Speak only when you have something to add: results, decisions, requests, blockers. Never post acknowledgements, thanks or "no update" messages.
- Messages from HUMAN come from the person who owns the room. They take priority: act on the ones addressed to you (or to everyone) as soon as you see them.
- ${QUIET_SESSION}
- Edit files shared with other agents only after announcing it, so two agents never edit the same file at once.
- When you need something from HUMAN (an approval, an answer, an action), ask in one message that mentions @HUMAN and starts with what HUMAN should do. Ask one thing per message: a yes-or-no question ("Approve \u2026", "Shall I \u2026?", with your recommendation when there are options) or one thing HUMAN has to do. In a room with a steward, the steward lists it for HUMAN; the answer may come as "@your-id L7: \u2026", where L7 is the item in the steward's ledger.
- When the steward asks for room-wide information (figures, a summary of your product), send it with @steward-id.
- Stay a member until wait_for_turn says the room is finished or closed, or HUMAN tells you to leave (then call leave_room).`;
var STEWARD_PROTOCOL = `HOW THIS ROOM WORKS (you are the steward)
You are this chat room's steward: you keep its ledger and do its room-wide work, so the other agents can stay on their own products. There are no turns: speak any time with speak(room_id, agent_id, message).
- What wakes you: every HUMAN message (the ones that mention nobody come to you alone), messages that mention you, and messages that mention @HUMAN. On each wake read all the new messages, not only the ones for you.
- HUMAN requests: one for a single product, forward to that product's agent with @agent-id. One for everyone (collect figures, build a shared page, write a summary): claim it in the room, ask the agents with @agent-id for what you need, collect it, build the shared artifact or summary, and report to HUMAN.
- Ledger: after every wake, record with ledger_update the new requests, who claimed what, decisions, what waits for HUMAN's approval, and shared artifacts (link, where the data lives, how to update it). Close items when they are done. Read it with ledger.
- Asks to HUMAN: when an agent asks HUMAN for something (an approval, a decision, an answer, an action), record one item per thing asked, with status "waiting": kind = "approval" when HUMAN answers yes or no (approve, go or no-go, shall I, confirm, decide, pick an option, where yes takes the recommended one), even when the ask explains why; "request" only when HUMAN has to do something themselves (run a command, test on a phone, press a button, review a text). An ask with both (test this, then say yes or no to that) is two items. VS Code lists them as approvals and tasks, with OK and No for approvals, Done and Not needed for tasks, and Reply for both. title = what HUMAN should do, in the imperative ("Approve the Core redeploy for Postala"); owner = the agent that asked; refs = the message number; detail = what HUMAN needs to know to do it. These items are HUMAN's to-do list in VS Code. A message that only informs HUMAN is not an item. Close the item when HUMAN answers it or the agent says it is resolved. HUMAN can also close items from VS Code; those arrive as HUMAN messages such as "@web Approved: L7 \u2026", "@web Not approved: L7 \u2026", "@web Done: L7 \u2026", "@web Not needed: L7 \u2026" or "@web L7: <answer>", and the item is already closed.
- Coordinate: when two agents take the same work, use the same decision number, or are about to touch the same shared deploy or file, tell both with @agent-id.
- Questions from HUMAN about the room: answer from the ledger and the history; ask an agent only when they don't say.
- Digest: on your first wake each day, post one digest to HUMAN: what waits for approval, what is in progress, what finished since the last digest. Record it in the ledger as a note.
- Limits: you don't write product code, push, deploy, change cloud or GitHub settings, or decide for a product. Ask HUMAN or the product's agent.
- Keep messages short and concrete, with no acknowledgements. When wait_for_turn says nothing is for you, end your turn: a message for you wakes you.
- ${QUIET_SESSION} Your daily digest in the room is the one summary HUMAN wants.
- Stay until wait_for_turn says the room is finished or closed, or HUMAN tells you to leave (then call leave_room).`;

// apps/muster-plugin/src/session.ts
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";
var CACHE_PATH = join2(musterHome(), "stop-hook-cache.v1.json");
function joinsInLine(line) {
  if (!line.includes("join_room")) return [];
  const entry = JSON.parse(line);
  const found = [];
  if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
    for (const block of entry.message.content) {
      if (block?.type === "tool_use" && /join_room$/.test(block.name ?? ""))
        found.push(block.input);
    }
  }
  const payload = entry.type === "response_item" ? entry.payload : void 0;
  if (payload?.type === "function_call" && /join_room$/.test(payload.name ?? "")) {
    found.push(JSON.parse(payload.arguments));
  }
  if (payload?.type === "custom_tool_call" && typeof payload.input === "string") {
    for (const call of payload.input.matchAll(/join_room\(\s*\{([^}]*)\}/g)) {
      found.push({ room_id: field(call[1], "room_id"), agent_id: field(call[1], "agent_id") });
    }
  }
  if (entry.source === "MODEL" && Array.isArray(entry.tool_calls)) {
    for (const call of entry.tool_calls) {
      if (call?.name === "call_mcp_tool" && /^"?join_room"?$/.test(call.args?.ToolName ?? "")) {
        const args = call.args.Arguments;
        found.push(typeof args === "string" ? JSON.parse(args) : args);
      }
    }
  }
  const update = entry.method === "session/update" ? entry.params?.update : void 0;
  if (update?.sessionUpdate === "tool_call" && update.rawInput) {
    const input = update.rawInput;
    if (/join_room$/.test(input.tool_name ?? "")) found.push(input.tool_input);
    else if (/join_room$/.test(update._meta?.["x.ai/tool"]?.name ?? update.title ?? ""))
      found.push(input);
  }
  return found.filter(
    (m) => typeof m?.room_id === "string" && typeof m?.agent_id === "string"
  );
}
function field(objectSource, name) {
  return objectSource.match(new RegExp(`${name}\\s*:\\s*\\\\?["'\`]([^"'\`\\\\]+)`))?.[1];
}
function transcriptPath(input, home = homedir2()) {
  const given = input.transcript_path ?? input.transcriptPath;
  if (given && existsSync(given)) return given;
  const conversation = input.conversation_id ?? input.conversationId;
  if (conversation) {
    for (const app of ["antigravity-cli", "antigravity"]) {
      const p = join2(
        home,
        ".gemini",
        app,
        "brain",
        conversation,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      );
      if (existsSync(p)) return p;
    }
  }
  if (input.session_id) return findCodexRollout(join2(home, ".codex", "sessions"), input.session_id);
  return null;
}
function findCodexRollout(root, sessionId) {
  const desc = (dir) => existsSync(dir) ? readdirSync(dir).sort().reverse() : [];
  for (const y of desc(root))
    for (const m of desc(join2(root, y)))
      for (const d of desc(join2(root, y, m))) {
        const hit = desc(join2(root, y, m, d)).find((f) => f.endsWith(`-${sessionId}.jsonl`));
        if (hit) return join2(root, y, m, d, hit);
      }
  return null;
}
function scanTranscript(path, cachePath = CACHE_PATH) {
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
  }
  const size = statSync(path).size;
  let { offset, joins } = cache[path] ?? { offset: 0, joins: [] };
  if (offset > size) ({ offset, joins } = { offset: 0, joins: [] });
  if (size > offset) {
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, offset);
    } finally {
      closeSync(fd);
    }
    const end = buf.lastIndexOf(10) + 1;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      try {
        joins.push(...joinsInLine(line));
      } catch {
      }
    }
    offset += end;
    cache[path] = { offset, joins };
    const tmp = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, cachePath);
  }
  return joins;
}
function openMemberships(joins, path = dbPath()) {
  if (!joins.length || !existsSync(path)) return [];
  const db = new DatabaseSync3(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000;");
    const active = db.prepare(
      `SELECT r.mode, m.last_seen, m.last_poll_at FROM members m JOIN rooms r ON r.id = m.room_id
        WHERE m.room_id = ? AND m.agent_id = ? AND m.active = 1 AND r.status = 'open'`
    );
    const unread = db.prepare(
      `SELECT id, sender, kind, content, created_at FROM messages
        WHERE room_id = ? AND sender != ? AND kind != 'system' AND id > ? ORDER BY id`
    );
    let steward = null;
    try {
      steward = db.prepare(
        `SELECT agent_id, last_seen FROM members
          WHERE room_id = ? AND role = 'steward' AND active = 1 AND removed = 0`
      );
    } catch {
      steward = null;
    }
    const routingOf = (roomId, mode) => {
      const row = mode === "chat" ? steward?.get(roomId) : void 0;
      return {
        mode,
        steward: row ? { agentId: String(row.agent_id), lastSeen: Number(row.last_seen) } : null
      };
    };
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const j of [...joins].reverse()) {
      const key = `${j.room_id}/${j.agent_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = active.get(j.room_id, j.agent_id);
      if (!row) continue;
      const messages = unread.all(j.room_id, j.agent_id, row.last_seen);
      const routing = routingOf(j.room_id, row.mode);
      const pending = messages.filter((m) => addressedTo(m, j.agent_id, routing)).map(({ id, sender, kind }) => ({ id, sender, kind }));
      out.push({
        room_id: j.room_id,
        agent_id: j.agent_id,
        mode: row.mode,
        pending,
        last_poll_at: row.last_poll_at
      });
    }
    return out;
  } finally {
    db.close();
  }
}
var blockFile = (session) => join2(musterHome(), "blocks", `${session.replace(/[^\w.-]/g, "_")}.json`);
function heldAt(session) {
  try {
    return JSON.parse(readFileSync(blockFile(session), "utf8")).at ?? null;
  } catch {
    return null;
  }
}
function sessionStopped(session) {
  try {
    const [event] = readFileSync(join2(musterHome(), "state", session), "utf8").trim().split(" ");
    return event === "Stop" || event === "StopFailure";
  } catch {
    return true;
  }
}
function senders(pending) {
  return [...new Set(pending.map((m) => m.kind === "human" ? "HUMAN" : m.sender))].join(", ");
}
var LOG_PATH = join2(musterHome(), "hooks.log");
function log(entry) {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 256 * 1024) writeFileSync(LOG_PATH, "");
    appendFileSync(LOG_PATH, JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...entry }) + "\n");
  } catch {
  }
}
function clientOf(input) {
  if ("turn_id" in input) return "codex";
  if ("conversationId" in input) return "agy";
  if (String(input.transcript_path ?? input.transcriptPath ?? "").includes("/.grok/"))
    return "grok";
  if ("prompt_id" in input || String(input.transcript_path ?? "").includes("/.claude/"))
    return "claude";
  return "unknown";
}
function isEntry(moduleUrl) {
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}

// apps/muster-plugin/src/wake-hook.ts
var POLL_MS = Number(process.env.MUSTER_WAKE_POLL_MS ?? 2e3);
var IDLE_MS = Number(process.env.MUSTER_WAKE_IDLE_MS ?? 5e3);
var SAME_STOP_MS = 2e3;
function wakeText({ room_id, agent_id, pending }) {
  return `New messages for you in Muster room "${room_id}" (from ${senders(pending)}). Call wait_for_turn(room_id="${room_id}", agent_id="${agent_id}") to read them and act on them. ` + QUIET_SESSION;
}
async function main() {
  const input = JSON.parse(readFileSync2(0, "utf8") || "{}");
  if (clientOf(input) !== "claude") return 0;
  const transcript = transcriptPath(input);
  if (!transcript) return 0;
  const joins = scanTranscript(transcript);
  const session = String(input.session_id ?? "unknown");
  const chatRooms = (all) => all.filter((m) => m.mode === "chat");
  const first = openMemberships(joins);
  if (!chatRooms(first).length || first.some((m) => m.mode === "turns")) return 0;
  const started = Date.now();
  const lock = join3(musterHome(), "wake", session);
  const wokenFile = `${lock}.woken.json`;
  const woken = () => {
    try {
      return JSON.parse(readFileSync2(wokenFile, "utf8"));
    } catch {
      return {};
    }
  };
  const key = (m) => `${m.room_id}/${m.agent_id}`;
  mkdirSync2(dirname2(lock), { recursive: true });
  writeFileSync2(lock, String(process.pid));
  const parent = process.ppid;
  log({
    hook: "wake",
    event: "start",
    rooms: chatRooms(first).map((m) => m.room_id),
    pid: process.pid
  });
  for (; ; ) {
    await sleep(POLL_MS);
    if (readFileSync2(lock, "utf8") !== String(process.pid)) return 0;
    if (process.ppid !== parent) return 0;
    let rooms;
    try {
      rooms = chatRooms(openMemberships(joins));
    } catch {
      continue;
    }
    if (!rooms.length) return 0;
    const seen = woken();
    const ready = rooms.find((m) => m.pending.some((p) => p.id > (seen[key(m)] ?? 0)));
    const idle = sessionStopped(session) && Date.now() - statSync2(transcript).mtimeMs > IDLE_MS;
    if (ready && idle) {
      if ((heldAt(session) ?? 0) >= started - SAME_STOP_MS) continue;
      seen[key(ready)] = Math.max(...ready.pending.map((p) => p.id));
      writeFileSync2(wokenFile, JSON.stringify(seen));
      log({ hook: "wake", event: "wake", room: ready.room_id, agent: ready.agent_id });
      process.stderr.write(wakeText(ready) + "\n");
      return 2;
    }
  }
}
if (isEntry(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log({ hook: "wake", error: err.message });
      process.exit(0);
    }
  );
}
export {
  wakeText
};
