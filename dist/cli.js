#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import{createRequire}from'module';const require=createRequire(import.meta.url);

// apps/muster-plugin/src/cli.ts
import { parseArgs } from "node:util";
import { setTimeout as sleep2 } from "node:timers/promises";

// apps/muster-plugin/src/store.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname as dirname2 } from "node:path";
import { randomBytes } from "node:crypto";

// apps/muster-plugin/src/home.ts
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var musterHome = () => process.env.MUSTER_HOME ?? join(homedir(), ".muster");
var dbPath = () => join(musterHome(), "rooms.db");

// apps/muster-plugin/src/store.ts
var STEWARD_FALLBACK_MS = 10 * 6e4;
var LEDGER_KINDS = [
  "request",
  "claim",
  "decision",
  "approval",
  "artifact",
  "note"
];
var LEDGER_STATUSES = ["open", "doing", "waiting", "done", "dropped"];
var LEDGER_ORDER = [
  "waiting",
  "doing",
  "open",
  "done",
  "dropped"
];
var LEDGER_RECENT_MS = 7 * 864e5;
var HUMAN_ACTIONS = ["done", "drop", "reply"];
var AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
var RESERVED_IDS = /* @__PURE__ */ new Set(["human", "system"]);
var SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  goals            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  mode             TEXT NOT NULL DEFAULT 'turns',
  min_agents       INTEGER NOT NULL DEFAULT 2,
  turn_timeout_sec INTEGER NOT NULL DEFAULT 300,
  current_agent    TEXT,
  turn_started_at  INTEGER,
  done_streak      INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  room_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  description  TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  joined_at    INTEGER NOT NULL,
  last_poll_at INTEGER NOT NULL DEFAULT 0,
  away         INTEGER NOT NULL DEFAULT 0,
  session_id   TEXT,
  client       TEXT,
  idle_since   INTEGER NOT NULL DEFAULT 0,
  removed      INTEGER NOT NULL DEFAULT 0,
  role         TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (room_id, agent_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL,
  sender     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_room ON messages (room_id, id);
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  owner      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',
  detail     TEXT NOT NULL DEFAULT '',
  refs       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_room ON ledger (room_id, status);
`;
var MIGRATIONS = [
  "ALTER TABLE members ADD COLUMN last_poll_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE members ADD COLUMN away INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE rooms ADD COLUMN mode TEXT NOT NULL DEFAULT 'turns'",
  "ALTER TABLE members ADD COLUMN session_id TEXT",
  "ALTER TABLE members ADD COLUMN client TEXT",
  "ALTER TABLE members ADD COLUMN idle_since INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE members ADD COLUMN removed INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'"
];
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var RoomStore = class {
  db;
  now;
  awayGraceMs;
  constructor(path = dbPath(), opts = {}) {
    mkdirSync(dirname2(path), { recursive: true });
    this.db = new DatabaseSync2(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch (err) {
        if (!/duplicate column/i.test(err.message)) throw err;
      }
    }
    this.now = opts.now ?? Date.now;
    this.awayGraceMs = opts.awayGraceMs ?? 9e4;
  }
  createRoom(input) {
    const id = `${slug(input.name)}-${randomBytes(3).toString("hex")}`;
    this.db.prepare(
      `INSERT INTO rooms (id, name, description, goals, mode, min_agents, turn_timeout_sec, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.name,
      input.description,
      input.goals,
      checkMode(input.mode ?? "turns"),
      Math.max(1, input.minAgents ?? 2),
      Math.max(0, input.turnTimeoutSec ?? 300),
      this.now()
    );
    return this.getRoom(id);
  }
  listRooms() {
    const rooms = this.db.prepare("SELECT * FROM rooms ORDER BY created_at DESC").all();
    return rooms.map((room) => ({ ...room, members: this.members(room.id) }));
  }
  getRoom(roomId2) {
    const room = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId2);
    if (!room) throw new Error(`Unknown room "${roomId2}". Use list_rooms to see rooms.`);
    return room;
  }
  /** Change a room's settings; the human does this from the CLI. */
  updateRoom(roomId2, fields) {
    return this.tx(() => {
      this.getRoom(roomId2);
      if (fields.mode) checkMode(fields.mode);
      const changed = Object.entries(fields).filter(([, value]) => value !== void 0);
      for (const [column, value] of changed) {
        this.db.prepare(`UPDATE rooms SET ${column} = ? WHERE id = ?`).run(value, roomId2);
      }
      this.post(
        roomId2,
        "system",
        "system",
        `Room settings changed: ${changed.map(([c]) => c).join(", ")}.`
      );
      this.tick(roomId2);
      return this.getRoom(roomId2);
    });
  }
  /** Active members in turn order. */
  members(roomId2) {
    return this.db.prepare("SELECT * FROM members WHERE room_id = ? AND active = 1 ORDER BY seq").all(roomId2);
  }
  messages(roomId2, afterId = 0) {
    return this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id").all(roomId2, afterId);
  }
  /** role: as given; on a rejoin without one the member keeps its role, a new member is a plain member. */
  join(roomId2, agentId, description, role) {
    if (!AGENT_ID.test(agentId) || RESERVED_IDS.has(agentId)) {
      throw new Error(
        `Invalid agent_id "${agentId}": use 1-40 letters, digits, ".", "_" or "-" (not "human"/"system").`
      );
    }
    return this.tx(() => {
      const room = this.getRoom(roomId2);
      if (room.status !== "open") throw new Error(`Room "${roomId2}" is ${room.status}.`);
      const existing = this.member(roomId2, agentId);
      const rejoined = existing?.active === 1;
      const nextRole = role ?? (rejoined ? existing.role : "member");
      if (nextRole === "steward") {
        if (room.mode !== "chat")
          throw new Error(`A steward works in chat rooms only; room "${roomId2}" uses turns.`);
        const other = this.routing(roomId2).steward?.agentId;
        if (other && other !== agentId)
          throw new Error(
            `Room "${roomId2}" already has a steward: ${other}. Ask HUMAN to remove it first.`
          );
      }
      if (rejoined) {
        this.db.prepare(
          "UPDATE members SET description = ?, last_poll_at = ?, away = 0, role = ? WHERE room_id = ? AND agent_id = ?"
        ).run(description, this.now(), nextRole, roomId2, agentId);
      } else {
        const { maxSeq } = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM members WHERE room_id = ?").get(roomId2);
        this.db.prepare(
          `INSERT INTO members (room_id, agent_id, description, seq, active, joined_at, last_poll_at, away, role)
             VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?)
             ON CONFLICT (room_id, agent_id) DO UPDATE SET
               description = excluded.description, seq = excluded.seq, active = 1, removed = 0,
               joined_at = excluded.joined_at, last_poll_at = excluded.last_poll_at, away = 0,
               role = excluded.role`
        ).run(roomId2, agentId, description, maxSeq + 1, this.now(), this.now(), nextRole);
        const as = nextRole === "steward" ? " as the room steward" : "";
        this.post(roomId2, "system", "system", `${agentId} joined${as}: ${description}`);
      }
      this.tick(roomId2);
      const history = this.messages(roomId2);
      this.markSeen(roomId2, agentId, history.at(-1)?.id ?? 0);
      return { room: this.getRoom(roomId2), members: this.members(roomId2), history, rejoined };
    });
  }
  /**
   * One non-blocking turn check. Records that the agent is waiting (bringing it back if it was
   * away) and skips a speaker who is away or whose turn has timed out.
   */
  peek(roomId2, agentId) {
    return this.tx(() => {
      const me = this.requireMember(roomId2, agentId);
      this.db.prepare("UPDATE members SET last_poll_at = ?, away = 0 WHERE room_id = ? AND agent_id = ?").run(this.now(), roomId2, agentId);
      if (me.away && this.getRoom(roomId2).status === "open") {
        this.post(roomId2, "system", "system", `\u25B6 ${agentId} is back.`);
      }
      this.tick(roomId2);
      const room = this.getRoom(roomId2);
      const members = this.members(roomId2);
      const waitingForAgents = Math.max(0, room.min_agents - members.length);
      return {
        roomId: roomId2,
        status: room.status,
        yourTurn: room.status === "open" && (room.mode === "chat" || waitingForAgents === 0 && room.current_agent === agentId),
        currentSpeaker: room.mode === "chat" ? null : room.current_agent,
        waitingForAgents: room.mode === "chat" ? 0 : waitingForAgents,
        away: members.filter((m) => m.away).map((m) => m.agent_id),
        mode: room.mode
      };
    });
  }
  /**
   * Poll until something concerns the agent, the room ends, or timeoutMs elapses.
   * - turns rooms: it is the agent's turn, or the human wrote.
   * - chat rooms: the human wrote, or a message mentions the agent (@id, @all, or "id:" at the start).
   * Returning on a human message matters for clients that only read their user's input
   * between agent turns: the room is then the only way to reach a looping agent.
   */
  async waitForTurn(roomId2, agentId, { timeoutMs = 45e3, pollMs = 1e3 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let state = this.peek(roomId2, agentId);
    const done = () => state.status !== "open" || this.unseenWakeup(roomId2, agentId) || state.mode === "turns" && state.yourTurn;
    while (!done() && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      state = this.peek(roomId2, agentId);
    }
    const routing = this.routing(roomId2);
    const newMessages = this.deliver(roomId2, agentId);
    return {
      ...state,
      newMessages,
      /** a HUMAN message for this agent: with a steward, one that mentions nobody is the steward's */
      human: newMessages.some(
        (m) => m.kind === "human" && addressedTo(m, agentId, routing, this.now())
      ),
      mentioned: newMessages.some((m) => m.kind === "agent" && mentions(m.content, agentId))
    };
  }
  /** An unseen message from someone else that should wake the agent. */
  unseenWakeup(roomId2, agentId) {
    const unseen = this.db.prepare(
      `SELECT id, kind, content, created_at FROM messages WHERE room_id = ? AND sender != ? AND kind != 'system'
           AND id > (SELECT last_seen FROM members WHERE room_id = ? AND agent_id = ?)`
    ).all(roomId2, agentId, roomId2, agentId);
    if (!unseen.length) return false;
    const routing = this.routing(roomId2);
    return unseen.some((m) => addressedTo(m, agentId, routing, this.now()));
  }
  /** The room's ledger: open work first, then what finished in the last week (or everything with all). */
  ledger(roomId2, { all = false } = {}) {
    this.getRoom(roomId2);
    const items = this.db.prepare(
      `SELECT * FROM ledger WHERE room_id = ?
           AND (? OR status NOT IN ('done', 'dropped') OR updated_at >= ?)
         ORDER BY updated_at DESC, id DESC`
    ).all(roomId2, all ? 1 : 0, this.now() - LEDGER_RECENT_MS);
    const rank = (s) => LEDGER_ORDER.indexOf(s);
    return items.sort((a, b) => rank(a.status) - rank(b.status));
  }
  /** When the room's ledger last changed (ms), 0 while it is empty. */
  ledgerUpdatedAt(roomId2) {
    const row = this.db.prepare("SELECT MAX(updated_at) AS at FROM ledger WHERE room_id = ?").get(roomId2);
    return row?.at ?? 0;
  }
  /** Creates an item (no id: needs kind and title) or changes one. Only the room's steward writes. */
  ledgerUpdate(roomId2, agentId, change) {
    return this.tx(() => {
      const steward = this.routing(roomId2).steward?.agentId;
      if (!steward) throw new Error(`Room "${roomId2}" has no steward, so nobody keeps its ledger.`);
      if (steward !== agentId)
        throw new Error(
          `Only the room's steward (${steward}) writes the ledger; ask it with @${steward}.`
        );
      const oneOf = (field, value, allowed) => {
        if (value !== void 0 && !allowed.includes(value))
          throw new Error(`${field} must be one of ${allowed.join(", ")}.`);
        return value;
      };
      const kind = oneOf("kind", change.kind, LEDGER_KINDS);
      const status = oneOf("status", change.status, LEDGER_STATUSES);
      const now = this.now();
      if (change.id === void 0) {
        if (!kind || !change.title?.trim())
          throw new Error("A new ledger item needs a kind and a title.");
        const { lastInsertRowid } = this.db.prepare(
          `INSERT INTO ledger (room_id, kind, title, owner, status, detail, refs, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          roomId2,
          kind,
          change.title.trim(),
          change.owner ?? "",
          status ?? "open",
          change.detail ?? "",
          change.refs ?? "",
          now,
          now
        );
        return this.ledgerItem(roomId2, Number(lastInsertRowid));
      }
      const item = this.ledgerItem(roomId2, change.id);
      const next = {
        ...item,
        ...Object.fromEntries(
          Object.entries({ ...change, kind, status }).filter(([, v]) => v !== void 0)
        )
      };
      this.db.prepare(
        `UPDATE ledger SET kind = ?, title = ?, owner = ?, status = ?, detail = ?, refs = ?, updated_at = ?
            WHERE room_id = ? AND id = ?`
      ).run(
        next.kind,
        next.title,
        next.owner,
        next.status,
        next.detail,
        next.refs,
        now,
        roomId2,
        item.id
      );
      return this.ledgerItem(roomId2, item.id);
    });
  }
  /**
   * HUMAN closes (done), drops or answers (reply) a ledger item: one HUMAN message to the agent that asked, which
   * says Approved or Not approved for an approval or decision, Done or Not needed for anything else
   * (or to the steward when no member owns it), and the item finished with that message in its refs. The one
   * ledger write that does not come from the steward.
   */
  humanResolve(roomId2, id, action, text = "") {
    return this.tx(() => {
      const room = this.getRoom(roomId2);
      if (room.status !== "open") throw new Error(`Room "${roomId2}" is ${room.status}.`);
      const item = this.ledgerItem(roomId2, id);
      if (item.status === "done" || item.status === "dropped")
        throw new Error(`L${id} is already ${item.status}.`);
      const answer = text.trim();
      if (action === "reply" && !answer) throw new Error("A reply needs the answer text.");
      const members = this.members(roomId2);
      const to = members.some((m) => m.agent_id === item.owner) ? item.owner : members.find((m) => m.role === "steward")?.agent_id;
      const approval = item.kind === "approval" || item.kind === "decision";
      const verdict = action === "done" ? approval ? "Approved" : "Done" : approval ? "Not approved" : "Not needed";
      const said = action === "reply" ? `L${id}: ${answer}` : `${verdict}: L${id} ${item.title}`;
      this.db.prepare("UPDATE rooms SET done_streak = 0 WHERE id = ?").run(roomId2);
      const message = this.post(roomId2, "human", "human", to ? `@${to} ${said}` : said);
      const detail = action === "reply" ? [item.detail.trim(), `HUMAN (#${message.id}): ${answer}`].filter(Boolean).join("\n") : item.detail;
      this.db.prepare(
        "UPDATE ledger SET status = ?, detail = ?, refs = ?, updated_at = ? WHERE room_id = ? AND id = ?"
      ).run(
        action === "drop" ? "dropped" : "done",
        detail,
        [item.refs.trim(), `#${message.id}`].filter(Boolean).join(" "),
        this.now(),
        roomId2,
        id
      );
      return { item: this.ledgerItem(roomId2, id), message };
    });
  }
  ledgerItem(roomId2, id) {
    const item = this.db.prepare("SELECT * FROM ledger WHERE room_id = ? AND id = ?").get(roomId2, id);
    if (!item) throw new Error(`No ledger item L${id} in room "${roomId2}".`);
    return item;
  }
  /** The room's mode and its active steward, for addressedTo. */
  routing(roomId2) {
    const { mode } = this.getRoom(roomId2);
    if (mode !== "chat") return { mode, steward: null };
    const row = this.db.prepare(
      `SELECT agent_id, last_seen FROM members
          WHERE room_id = ? AND role = 'steward' AND active = 1 AND removed = 0`
    ).get(roomId2);
    return { mode, steward: row ? { agentId: row.agent_id, lastSeen: row.last_seen } : null };
  }
  /** Messages from others the agent has not seen yet; advances the agent's read cursor. */
  deliver(roomId2, agentId) {
    return this.tx(() => {
      const member = this.requireMember(roomId2, agentId);
      const all = this.messages(roomId2, member.last_seen);
      if (all.length) this.markSeen(roomId2, agentId, all.at(-1).id);
      return all.filter((m) => m.sender !== agentId);
    });
  }
  speak(roomId2, agentId, content, done = false) {
    return this.tx(() => {
      this.requireMember(roomId2, agentId);
      const room = this.getRoom(roomId2);
      if (room.status !== "open")
        throw new Error(`Room "${roomId2}" is ${room.status}; stop working in it.`);
      const members = this.members(roomId2);
      const chat = room.mode === "chat";
      if (!chat && members.length < room.min_agents) {
        throw new Error(
          `Waiting for ${room.min_agents - members.length} more agent(s) to join before turns start. Call wait_for_turn.`
        );
      }
      if (!chat && room.current_agent !== agentId) {
        const holder = room.current_agent ? `it is ${room.current_agent}'s turn` : "nobody holds the turn yet";
        throw new Error(
          `Not your turn: ${holder}. Call wait_for_turn, then speak when it is your turn.`
        );
      }
      if (!content.trim()) throw new Error("Message is empty.");
      this.db.prepare("UPDATE members SET last_poll_at = ? WHERE room_id = ? AND agent_id = ?").run(this.now(), roomId2, agentId);
      this.post(roomId2, agentId, "agent", content, done);
      const streak = done ? room.done_streak + 1 : 0;
      this.db.prepare("UPDATE rooms SET done_streak = ? WHERE id = ?").run(streak, roomId2);
      if (done && this.everyoneAgreed(roomId2, members)) {
        this.db.prepare(`UPDATE rooms SET status = 'done' WHERE id = ?`).run(roomId2);
        this.post(
          roomId2,
          "system",
          "system",
          "\u2705 Every agent marked the goals as done. Room finished."
        );
        return { room: this.getRoom(roomId2), nextSpeaker: null };
      }
      return { room: this.getRoom(roomId2), nextSpeaker: chat ? null : this.passTurn(roomId2) };
    });
  }
  leave(roomId2, agentId) {
    this.tx(() => {
      this.requireMember(roomId2, agentId);
      this.db.prepare("UPDATE members SET active = 0 WHERE room_id = ? AND agent_id = ?").run(roomId2, agentId);
      this.post(roomId2, "system", "system", `${agentId} left the room.`);
      if (this.getRoom(roomId2).current_agent === agentId) this.passTurn(roomId2);
    });
  }
  /** The human takes an agent out of the room; the room is told. */
  remove(roomId2, agentId) {
    this.tx(() => {
      this.requireMember(roomId2, agentId);
      this.db.prepare("UPDATE members SET active = 0, removed = 1 WHERE room_id = ? AND agent_id = ?").run(roomId2, agentId);
      this.post(roomId2, "system", "system", `${agentId} was removed by HUMAN.`);
      if (this.getRoom(roomId2).current_agent === agentId) this.passTurn(roomId2);
    });
  }
  /** Out-of-turn message from the human owner. */
  say(roomId2, content) {
    return this.tx(() => {
      const room = this.getRoom(roomId2);
      if (room.status !== "open") throw new Error(`Room "${roomId2}" is ${room.status}.`);
      this.db.prepare("UPDATE rooms SET done_streak = 0 WHERE id = ?").run(roomId2);
      return this.post(roomId2, "human", "human", content);
    });
  }
  close(roomId2) {
    this.tx(() => {
      this.getRoom(roomId2);
      this.db.prepare(`UPDATE rooms SET status = 'closed' WHERE id = ?`).run(roomId2);
      this.post(roomId2, "system", "system", "Room closed by the human.");
    });
  }
  // --- internals (callers must already be inside tx) ---
  /**
   * True when every member is among the agents who said done since the last message that was not
   * a done vote (an agent's non-done message or any human message). One agent voting twice while
   * another is skipped does not count as agreement.
   */
  everyoneAgreed(roomId2, members) {
    const recent = this.db.prepare(
      `SELECT sender, kind, done FROM messages WHERE room_id = ? AND kind != 'system' ORDER BY id DESC`
    ).iterate(roomId2);
    const voters = /* @__PURE__ */ new Set();
    for (const m of recent) {
      if (m.kind === "human" || !m.done) break;
      voters.add(m.sender);
      if (members.every((member) => voters.has(member.agent_id))) return true;
    }
    return false;
  }
  /** Skip the current speaker if it is away or out of time, and hand out a free turn. */
  tick(roomId2) {
    const room = this.getRoom(roomId2);
    if (room.status !== "open" || room.mode === "chat") return;
    const members = this.members(roomId2);
    if (members.length < room.min_agents) {
      this.db.prepare("UPDATE rooms SET turn_started_at = ? WHERE id = ?").run(this.now(), roomId2);
      return;
    }
    const current = members.find((m) => m.agent_id === room.current_agent);
    if (!current || current.away) {
      this.passTurn(roomId2);
      return;
    }
    const started = room.turn_started_at ?? 0;
    const elapsed = this.now() - started;
    const timeoutMs = room.turn_timeout_sec > 0 ? room.turn_timeout_sec * 1e3 : Infinity;
    const legacy = current.last_poll_at === 0;
    const sawTurn = legacy || current.last_poll_at >= started;
    if (elapsed <= (sawTurn ? timeoutMs : Math.min(this.awayGraceMs, timeoutMs))) return;
    const why = sawTurn ? `no message within ${room.turn_timeout_sec}s` : "not waiting in the room";
    if (legacy) {
      this.post(roomId2, "system", "system", `\u23ED ${current.agent_id} skipped: ${why}.`);
      this.passTurn(roomId2, current.agent_id);
      return;
    }
    this.db.prepare("UPDATE members SET away = 1 WHERE room_id = ? AND agent_id = ?").run(roomId2, current.agent_id);
    this.post(
      roomId2,
      "system",
      "system",
      `\u23ED ${current.agent_id} skipped (${why}). Its turns are skipped until it calls wait_for_turn again.`
    );
    this.passTurn(roomId2);
  }
  /**
   * Give the turn to the next present member after the last speaker (or after `skipped`, an
   * agent that just lost its turn). If the last speaker is the only one present, nobody gets the
   * turn until an away member comes back, so no agent talks to itself.
   */
  passTurn(roomId2, skipped) {
    const room = this.getRoom(roomId2);
    const members = this.members(roomId2);
    const candidates = members.filter((m) => !m.away && m.agent_id !== skipped);
    const last = this.db.prepare(
      `SELECT sender FROM messages WHERE room_id = ? AND kind = 'agent' ORDER BY id DESC LIMIT 1`
    ).get(roomId2);
    const baseAgent = skipped ?? last?.sender;
    const baseSeq = baseAgent ? this.member(roomId2, baseAgent)?.seq ?? 0 : 0;
    let next = members.length >= room.min_agents ? candidates.find((m) => m.seq > baseSeq) ?? candidates[0] : void 0;
    if (!skipped && next && next.agent_id === last?.sender && members.length > 1) next = void 0;
    this.setTurn(roomId2, next?.agent_id ?? null);
    return next?.agent_id ?? null;
  }
  setTurn(roomId2, agentId) {
    this.db.prepare("UPDATE rooms SET current_agent = ?, turn_started_at = ? WHERE id = ?").run(agentId, this.now(), roomId2);
  }
  member(roomId2, agentId) {
    return this.db.prepare("SELECT * FROM members WHERE room_id = ? AND agent_id = ?").get(roomId2, agentId);
  }
  requireMember(roomId2, agentId) {
    this.getRoom(roomId2);
    const member = this.member(roomId2, agentId);
    if (member?.removed)
      throw new Error(
        `HUMAN removed you from room "${roomId2}". Stop using this room; do not rejoin unless HUMAN asks you to.`
      );
    if (!member?.active)
      throw new Error(`"${agentId}" is not in room "${roomId2}". Call join_room first.`);
    return member;
  }
  markSeen(roomId2, agentId, messageId) {
    this.db.prepare(
      "UPDATE members SET last_seen = MAX(last_seen, ?) WHERE room_id = ? AND agent_id = ?"
    ).run(messageId, roomId2, agentId);
  }
  post(roomId2, sender, kind, content, done = false) {
    const { lastInsertRowid } = this.db.prepare(
      "INSERT INTO messages (room_id, sender, kind, content, done, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(roomId2, sender, kind, content, done ? 1 : 0, this.now());
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(lastInsertRowid);
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
};
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "room";
}
function checkMode(mode) {
  if (mode !== "turns" && mode !== "chat")
    throw new Error(`Unknown room mode "${mode}": use "turns" or "chat".`);
  return mode;
}
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
function formatMessage(m) {
  const who = m.kind === "human" ? "HUMAN" : m.sender;
  return `[#${m.id} ${who}${m.done ? " \u2713done" : ""}] ${m.content}`;
}
function formatMembers(members, room, you) {
  if (!members.length) return "(nobody yet)";
  return members.map((m, i) => {
    const tags = [
      m.agent_id === you && "(you)",
      m.role === "steward" && "(steward)",
      m.away && "(away)",
      m.agent_id === room.current_agent && "\u2190 current turn"
    ].filter(Boolean).join(" ");
    return `${i + 1}. ${m.agent_id}: ${m.description}${tags ? ` ${tags}` : ""}`;
  }).join("\n");
}
var LEDGER_HEADINGS = {
  waiting: "WAITING FOR HUMAN",
  doing: "DOING",
  open: "OPEN",
  done: "DONE",
  dropped: "DROPPED"
};
function formatLedgerItem(i) {
  const head = [`L${i.id} [${i.kind}] ${i.title}`, i.owner, i.refs].filter(Boolean).join(" \xB7 ");
  return `- ${head}${i.detail ? `
  ${i.detail.replace(/\n/g, "\n  ")}` : ""}`;
}
function formatLedger(roomId2, items, all = false) {
  if (!items.length) return `The ledger of room "${roomId2}" is empty.`;
  const scope = all ? "every item" : "open work, and what finished in the last 7 days";
  const groups = LEDGER_ORDER.flatMap((status) => {
    const group = items.filter((i) => i.status === status);
    return group.length ? [LEDGER_HEADINGS[status], ...group.map(formatLedgerItem)] : [];
  });
  return [`LEDGER of room "${roomId2}" (${scope}):`, "", ...groups].join("\n");
}
function formatBrief(room) {
  return `ROOM: ${room.name} (${room.id}) [${room.status}, ${room.mode} mode]
DESCRIPTION: ${room.description}
GOALS: ${room.goals}`;
}
function joinPrompt(room) {
  const protocol = room.mode === "chat" ? "call wait_for_turn to read messages for you, speak when you have something to add, and end your turn when nothing is for you" : "keep calling wait_for_turn, do your work when it is your turn, speak once per turn, and continue until the room is finished";
  return `Use the Muster MCP tools to join room "${room.id}" with agent_id "<pick-a-short-id>" and describe yourself as "<what you are responsible for>". Then follow the room protocol: ${protocol}.`;
}

// apps/muster-plugin/src/markup.ts
var PALETTE_SIZE = 6;
var INLINE = /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)|(?<![\w#&])#(\d+)\b|https?:\/\/[^\s<>"'`]+/g;
var LINK_TAIL = /[.,;:!?)\]]+$/;
var ITEM = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;
var FENCE = /^\s*```/;
function parseInline(text) {
  const out = [];
  const pushText = (s) => {
    if (!s) return;
    const last = out.at(-1);
    if (last?.type === "text") last.text += s;
    else out.push({ type: "text", text: s });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[2] !== void 0) out.push({ type: "code", text: m[2] });
    else if (m[3] !== void 0) out.push({ type: "bold", children: parseInline(m[3]) });
    else if (m[4] !== void 0) out.push({ type: "mention", id: m[4] });
    else if (m[5] !== void 0) out.push({ type: "ref", id: Number(m[5]) });
    else {
      const tail = m[0].match(LINK_TAIL)?.[0] ?? "";
      out.push({ type: "link", url: m[0].slice(0, m[0].length - tail.length) });
      pushText(tail);
    }
  }
  pushText(text.slice(at));
  return out;
}
function parseMarkup(text) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "para", lines: para });
    para = [];
  };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) code.push(lines[i] ?? "");
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      flush();
      const [, indent = "", marker = "", rest2 = ""] = item;
      blocks.push({
        type: "item",
        marker: /\d/.test(marker) ? `${marker.slice(0, -1)}.` : "\u2022",
        depth: Math.floor(indent.replace(/\t/g, "  ").length / 2),
        inlines: parseInline(rest2.trim())
      });
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(parseInline(line.trim()));
    }
  }
  flush();
  return blocks;
}
function colorIndex(sender, memberIds) {
  const i = memberIds.indexOf(sender);
  if (i >= 0) return i % PALETTE_SIZE;
  let hash = 0;
  for (const c of sender) hash = hash * 31 + c.charCodeAt(0) >>> 0;
  return hash % PALETTE_SIZE;
}
var localTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
var localDay = (ms) => new Date(ms).toLocaleDateString([], {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric"
});

// apps/muster-plugin/src/pretty.ts
var PALETTE = ["38;5;208", "38;5;78", "38;5;75", "38;5;177", "38;5;220", "38;5;44"];
var HUMAN = "38;5;204";
var DIM = "2";
var CODE = "38;5;180";
var LINK = "4;38;5;75";
var DONE = "32";
var INDENT = 2;
var join2 = (...styles) => styles.filter(Boolean).join(";");
function stripControl(text) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
function paint(o, text, style) {
  return o.color && style ? `\x1B[${style}m${text}\x1B[0m` : text;
}
function senderStyle(o, id) {
  return PALETTE[colorIndex(id, o.memberIds)] ?? "";
}
var Printer = class {
  lastDay = null;
  o;
  constructor(o) {
    this.o = o;
  }
  print(message) {
    const m = { ...message, content: stripControl(message.content) };
    const o = this.o;
    const out = [];
    const day = o.day(m.created_at);
    if (day !== this.lastDay) {
      this.lastDay = day;
      out.push("", paint(o, `\u2500\u2500 ${day} \u2500\u2500`, DIM));
    }
    out.push("");
    const time = o.time(m.created_at);
    if (m.kind === "system") {
      out.push(paint(o, `${" ".repeat(INDENT)}\u2500 ${m.content} \xB7 ${time} \u2500`, DIM));
      return out.join("\n");
    }
    const human = m.kind === "human";
    out.push(
      paint(o, human ? "HUMAN" : m.sender, join2("1", human ? HUMAN : senderStyle(o, m.sender))) + paint(o, `  #${m.id} \xB7 ${time}`, DIM) + (m.done ? paint(o, "  \u2713 done", DONE) : "")
    );
    const pad = " ".repeat(INDENT);
    for (const block of parseMarkup(m.content)) {
      if (block.type === "code") {
        for (const line of block.text.split("\n")) out.push(pad + "    " + paint(o, line, CODE));
      } else if (block.type === "item") {
        const first = `${pad}${"  ".repeat(block.depth)}${block.marker} `;
        out.push(...this.wrap(this.pieces(block.inlines), first, " ".repeat(first.length)));
      } else {
        for (const line of block.lines) out.push(...this.wrap(this.pieces(line), pad, pad));
      }
    }
    return out.join("\n");
  }
  pieces(inlines, style = "") {
    const o = this.o;
    return inlines.flatMap((n) => {
      switch (n.type) {
        case "text":
          return [{ text: n.text, style }];
        case "code":
          return [
            o.color ? { text: n.text, style: join2(style, CODE) } : { text: `\`${n.text}\``, style }
          ];
        case "bold":
          return this.pieces(n.children, join2(style, "1"));
        case "mention":
          return [
            {
              text: `@${n.id}`,
              style: join2(style, "1", o.memberIds.includes(n.id) ? senderStyle(o, n.id) : "")
            }
          ];
        case "ref":
          return [{ text: `#${n.id}`, style: join2(style, DIM) }];
        case "link":
          return [{ text: n.url, style: join2(style, LINK) }];
      }
    });
  }
  /** Word-wraps pieces to the width; `first` and `hang` prefix the first and the following lines. */
  wrap(pieces, first, hang) {
    const words = [];
    let word = null;
    let space = false;
    for (const piece of pieces) {
      for (const token of piece.text.split(/(\s+)/)) {
        if (!token) continue;
        if (/^\s/.test(token)) {
          space = true;
          word = null;
          continue;
        }
        if (!word) {
          word = { pieces: [], length: 0, spaceBefore: space };
          words.push(word);
          space = false;
        }
        word.pieces.push({ text: token, style: piece.style });
        word.length += token.length;
      }
    }
    const lines = [];
    let line = first;
    let length = first.length;
    let empty = true;
    for (const w of words) {
      const gap = !empty && w.spaceBefore ? 1 : 0;
      if (!empty && length + gap + w.length > this.o.width) {
        lines.push(line);
        line = hang;
        length = hang.length;
        empty = true;
      }
      if (!empty && w.spaceBefore) {
        line += " ";
        length += 1;
      }
      line += w.pieces.map((p) => paint(this.o, p.text, p.style)).join("");
      length += w.length;
      empty = false;
    }
    lines.push(line);
    return lines;
  }
};
function prettyHeader(room, members, o) {
  const who = members.length ? members.map(
    (m) => paint(o, m.agent_id, senderStyle(o, m.agent_id)) + paint(
      o,
      `${m.away ? " (away)" : ""}${m.agent_id === room.current_agent ? " (turn)" : ""}`,
      DIM
    )
  ).join(" \xB7 ") : paint(o, "(nobody yet)", DIM);
  return `${paint(o, room.name, "1")}  ${paint(o, `${room.id} \xB7 ${room.mode} \xB7 ${room.status}`, DIM)}
${who}`;
}

// apps/muster-plugin/src/state.ts
function roomState(store2) {
  return store2.listRooms().filter((room) => room.status === "open").map((room) => {
    const messages = store2.messages(room.id);
    const routing = store2.routing(room.id);
    return {
      id: room.id,
      name: room.name,
      description: room.description,
      goals: room.goals,
      mode: room.mode,
      status: room.status,
      last_message_id: messages.at(-1)?.id ?? 0,
      ledger_updated_at: store2.ledgerUpdatedAt(room.id),
      waiting: store2.ledger(room.id).filter((i) => i.status === "waiting").map(({ id, kind, title, owner, detail, refs, created_at, updated_at }) => ({
        id,
        kind,
        title,
        owner,
        detail,
        refs,
        created_at,
        updated_at
      })),
      members: room.members.map((m) => ({
        agent_id: m.agent_id,
        description: m.description,
        role: m.role,
        client: m.client,
        session_id: m.session_id,
        away: Boolean(m.away),
        idle: m.idle_since > m.last_poll_at,
        idle_since: m.idle_since,
        turn: room.mode === "turns" && room.current_agent === m.agent_id,
        pending: messages.filter(
          (msg) => msg.id > m.last_seen && msg.sender !== m.agent_id && msg.kind !== "system" && addressedTo(msg, m.agent_id, routing)
        ).map(({ id, sender, kind }) => ({ id, sender, kind }))
      }))
    };
  });
}

// apps/muster-plugin/src/listen.ts
function listenStep(store2, roomId2, agentId, cursor) {
  const room = store2.getRoom(roomId2);
  const me = store2.members(roomId2).find((m) => m.agent_id === agentId);
  if (room.status !== "open" || !me) return { line: null, cursor, done: true };
  const messages = store2.messages(roomId2, Math.max(cursor, me.last_seen));
  const next = messages.at(-1)?.id ?? cursor;
  const routing = store2.routing(roomId2);
  const fresh = messages.filter(
    (m) => m.sender !== agentId && m.kind !== "system" && addressedTo(m, agentId, routing)
  );
  if (!fresh.length) return { line: null, cursor: next, done: false };
  const from = [...new Set(fresh.map((m) => m.kind === "human" ? "HUMAN" : m.sender))].join(", ");
  return {
    line: `[muster] New message for you in room ${roomId2} from ${from}: call wait_for_turn(room_id="${roomId2}", agent_id="${agentId}").`,
    cursor: next,
    done: false
  };
}

// apps/muster-plugin/src/version.ts
var VERSION = "0.4.2";

// apps/muster-plugin/src/cli.ts
var USAGE = `muster: rooms where AI agents collaborate

  create <name> --description <text> --goals <text> [--mode turns|chat] [--min-agents N] [--turn-timeout SEC]
  set   <room> [--mode turns|chat] [--description <text>] [--goals <text>] [--min-agents N] [--turn-timeout SEC]
  list
  show  [room]              brief, members and whose turn it is
  watch [room] [--last N | --all] [--pretty]   the last 20 messages (or N, or all), then follow live
  log   [room] [--last N] [--pretty | --json [--after ID]]   the conversation
  ledger [room] [--all] [--json]   the steward's ledger: open work and what finished in the last 7 days
  ledger <room> done|drop L<n>     close or drop an item as HUMAN, telling the agent that asked
  ledger <room> reply L<n> <text>  answer an item as HUMAN; the answer goes to the agent and closes the item
  say   <room> <message>    post as HUMAN (out of turn; agents see it next poll)
  remove <room> <agent>     take an agent out of the room
  close <room>
  state --json [--watch]    open rooms and members as JSON, again on every change with --watch
  listen <room> <agent>     a line each time messages for the agent arrive (what a Grok agent's monitor runs)
  --version, -v             print the version

For show, watch, log and ledger, [room] is an id, a unique id prefix or the room's name; left out, the only open room.
On a terminal (or with --pretty) messages are wrapped and coloured; NO_COLOR turns colours off and FORCE_COLOR
on. Into a pipe they print one per line.

Data: $MUSTER_HOME or ~/.muster`;
var { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    description: { type: "string", short: "d" },
    goals: { type: "string", short: "g" },
    "min-agents": { type: "string" },
    "turn-timeout": { type: "string" },
    mode: { type: "string" },
    json: { type: "boolean" },
    watch: { type: "boolean" },
    after: { type: "string" },
    last: { type: "string" },
    all: { type: "boolean" },
    pretty: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" }
  }
});
if (values.version) {
  console.log(`muster ${VERSION}`);
  process.exit(0);
}
var [command, roomId, ...rest] = positionals;
var store = new RoomStore();
var force = process.env.FORCE_COLOR;
var tty = Boolean(process.stdout.isTTY);
var pretty = Boolean(values.pretty) || tty;
var color = pretty && (force ? force !== "0" : !process.env.NO_COLOR);
function prettyOptions(room) {
  const columns = process.stdout.columns || Number(process.env.COLUMNS) || 100;
  return {
    width: Math.min(columns, 100),
    color,
    memberIds: store.members(room.id).map((m) => m.agent_id),
    time: localTime,
    day: localDay
  };
}
function printer(room) {
  if (!pretty) {
    return (m) => {
      const time = new Date(m.created_at).toLocaleTimeString();
      console.log(`${time} ${formatMessage({ ...m, content: stripControl(m.content) })}`);
    };
  }
  const p = new Printer(prettyOptions(room));
  return (m) => console.log(p.print(m));
}
function findRoom(arg) {
  const rooms = store.listRooms();
  const open = (list) => list.filter((r) => r.status === "open");
  if (!arg) {
    const [only, ...more] = open(rooms);
    if (only && !more.length) return store.getRoom(only.id);
    throw new Error(
      only ? `Several rooms are open; name one: ${open(rooms).map((r) => r.id).join(", ")}` : "No room is open; name one."
    );
  }
  if (rooms.some((r) => r.id === arg)) return store.getRoom(arg);
  const key = arg.toLowerCase();
  const hits = rooms.filter((r) => r.name.toLowerCase() === key || r.id.startsWith(key));
  const [hit, ...others] = hits.length > 1 ? open(hits) : hits;
  if (hit && !others.length) return store.getRoom(hit.id);
  throw new Error(
    hits.length ? `"${arg}" matches several rooms: ${hits.map((r) => r.id).join(", ")}` : `Unknown room: ${arg}`
  );
}
function count(value, what) {
  if (value === void 0) return void 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${what} takes a whole number, not "${value}".`);
  return n;
}
function need(value, what) {
  if (!value) {
    console.error(`Missing ${what}.

${USAGE}`);
    process.exit(1);
  }
  return value;
}
try {
  switch (values.help ? "help" : command) {
    case "create": {
      const room = store.createRoom({
        name: need(roomId, "<name>"),
        description: need(values.description, "--description"),
        goals: need(values.goals, "--goals"),
        minAgents: values["min-agents"] ? Number(values["min-agents"]) : void 0,
        turnTimeoutSec: values["turn-timeout"] ? Number(values["turn-timeout"]) : void 0,
        mode: values.mode
      });
      console.log(`Created ${room.id}

Paste into each agent:

${joinPrompt(room)}`);
      break;
    }
    case "set": {
      const room = store.updateRoom(need(roomId, "<room>"), {
        mode: values.mode,
        description: values.description,
        goals: values.goals,
        min_agents: values["min-agents"] ? Number(values["min-agents"]) : void 0,
        turn_timeout_sec: values["turn-timeout"] ? Number(values["turn-timeout"]) : void 0
      });
      console.log(formatBrief(room));
      break;
    }
    case "list": {
      const rooms = store.listRooms();
      if (!rooms.length) console.log("No rooms.");
      for (const r of rooms) {
        const turn = r.status === "open" && r.current_agent ? `, turn: ${r.current_agent}` : "";
        console.log(
          `${r.id}  [${r.status}, ${r.mode}]  ${r.name}  (${r.members.map((m) => m.agent_id).join(", ") || "empty"}${turn})`
        );
      }
      break;
    }
    case "ledger": {
      if (rest.length) {
        const room2 = store.getRoom(need(roomId, "<room>"));
        const [action = "", ref = "", ...words] = rest;
        if (!HUMAN_ACTIONS.includes(action))
          throw new Error(`Unknown ledger action "${action}": use done, drop or reply.`);
        const id = Number(/^L?(\d+)$/i.exec(ref)?.[1]);
        if (!id) throw new Error(`Give the item as L<n>, not "${ref}".`);
        const { message } = store.humanResolve(room2.id, id, action, words.join(" "));
        printer(room2)(message);
        break;
      }
      const room = findRoom(roomId);
      const items = store.ledger(room.id, { all: Boolean(values.all) });
      console.log(
        values.json ? JSON.stringify(items) : formatLedger(room.id, items, Boolean(values.all))
      );
      break;
    }
    case "show": {
      const room = findRoom(roomId);
      console.log(
        `${formatBrief(room)}

MEMBERS (turn order):
${formatMembers(store.members(room.id), room)}`
      );
      break;
    }
    case "watch": {
      let room = findRoom(roomId);
      const id = room.id;
      const last = values.all ? void 0 : count(values.last, "--last") ?? 20;
      console.log(
        pretty ? `${prettyHeader(room, store.members(id), prettyOptions(room))}` : `${formatBrief(room)}
`
      );
      const print = printer(room);
      const history = store.messages(id);
      let lastId = last === void 0 ? 0 : history.at(-last - 1)?.id ?? 0;
      if (last === 0) lastId = history.at(-1)?.id ?? 0;
      let lastTurn = null;
      for (; ; ) {
        for (const m of store.messages(id, lastId)) {
          print(m);
          lastId = m.id;
        }
        room = store.getRoom(id);
        if (room.status !== "open") break;
        if (room.current_agent !== lastTurn) {
          lastTurn = room.current_agent;
          if (lastTurn) console.log(`        \u2026 ${lastTurn}'s turn`);
        }
        await sleep2(1e3);
      }
      console.log(`
Room is ${room.status}.`);
      break;
    }
    case "say": {
      const room = store.getRoom(need(roomId, "<room>"));
      printer(room)(store.say(room.id, need(rest.join(" ") || void 0, "<message>")));
      break;
    }
    case "close": {
      store.close(need(roomId, "<room>"));
      console.log(`Closed ${roomId}.`);
      break;
    }
    case "log": {
      const room = findRoom(roomId);
      const messages = store.messages(room.id, count(values.after, "--after") ?? 0);
      const last = count(values.last, "--last");
      const shown = last === void 0 ? messages : messages.slice(Math.max(0, messages.length - last));
      if (values.json) {
        console.log(JSON.stringify(shown));
        break;
      }
      shown.forEach(printer(room));
      break;
    }
    case "remove": {
      store.remove(need(roomId, "<room>"), need(rest[0], "<agent>"));
      console.log(`Removed ${rest[0]} from ${roomId}.`);
      break;
    }
    case "listen": {
      const id = need(roomId, "<room>");
      const agent = need(rest[0], "<agent>");
      const poll = Number(process.env.MUSTER_LISTEN_POLL_MS ?? 2e3);
      for (let cursor = 0; ; await sleep2(poll)) {
        let step;
        try {
          step = listenStep(store, id, agent, cursor);
        } catch (err) {
          if (/database is locked|SQLITE_BUSY/i.test(err.message)) continue;
          throw err;
        }
        if (step.line) console.log(step.line);
        if (step.done) break;
        cursor = step.cursor;
      }
      break;
    }
    case "state": {
      let last = "";
      do {
        const now = JSON.stringify(roomState(store));
        if (now !== last) console.log(now);
        last = now;
        if (values.watch) await sleep2(1e3);
      } while (values.watch);
      break;
    }
    default:
      console.log(USAGE);
      if (command && command !== "help") process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
