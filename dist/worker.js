import{createRequire}from'module';const require=createRequire(import.meta.url);

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
  getRoom(roomId) {
    const room = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    if (!room) throw new Error(`Unknown room "${roomId}". Use list_rooms to see rooms.`);
    return room;
  }
  /** Change a room's settings; the human does this from the CLI. */
  updateRoom(roomId, fields) {
    return this.tx(() => {
      this.getRoom(roomId);
      if (fields.mode) checkMode(fields.mode);
      const changed = Object.entries(fields).filter(([, value]) => value !== void 0);
      for (const [column, value] of changed) {
        this.db.prepare(`UPDATE rooms SET ${column} = ? WHERE id = ?`).run(value, roomId);
      }
      this.post(
        roomId,
        "system",
        "system",
        `Room settings changed: ${changed.map(([c]) => c).join(", ")}.`
      );
      this.tick(roomId);
      return this.getRoom(roomId);
    });
  }
  /** Active members in turn order. */
  members(roomId) {
    return this.db.prepare("SELECT * FROM members WHERE room_id = ? AND active = 1 ORDER BY seq").all(roomId);
  }
  messages(roomId, afterId = 0) {
    return this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id").all(roomId, afterId);
  }
  /** role: as given; on a rejoin without one the member keeps its role, a new member is a plain member. */
  join(roomId, agentId, description, role) {
    if (!AGENT_ID.test(agentId) || RESERVED_IDS.has(agentId)) {
      throw new Error(
        `Invalid agent_id "${agentId}": use 1-40 letters, digits, ".", "_" or "-" (not "human"/"system").`
      );
    }
    return this.tx(() => {
      const room = this.getRoom(roomId);
      if (room.status !== "open") throw new Error(`Room "${roomId}" is ${room.status}.`);
      const existing = this.member(roomId, agentId);
      const rejoined = existing?.active === 1;
      const nextRole = role ?? (rejoined ? existing.role : "member");
      if (nextRole === "steward") {
        if (room.mode !== "chat")
          throw new Error(`A steward works in chat rooms only; room "${roomId}" uses turns.`);
        const other = this.routing(roomId).steward?.agentId;
        if (other && other !== agentId)
          throw new Error(
            `Room "${roomId}" already has a steward: ${other}. Ask HUMAN to remove it first.`
          );
      }
      if (rejoined) {
        this.db.prepare(
          "UPDATE members SET description = ?, last_poll_at = ?, away = 0, role = ? WHERE room_id = ? AND agent_id = ?"
        ).run(description, this.now(), nextRole, roomId, agentId);
      } else {
        const { maxSeq } = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM members WHERE room_id = ?").get(roomId);
        this.db.prepare(
          `INSERT INTO members (room_id, agent_id, description, seq, active, joined_at, last_poll_at, away, role)
             VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?)
             ON CONFLICT (room_id, agent_id) DO UPDATE SET
               description = excluded.description, seq = excluded.seq, active = 1, removed = 0,
               joined_at = excluded.joined_at, last_poll_at = excluded.last_poll_at, away = 0,
               role = excluded.role`
        ).run(roomId, agentId, description, maxSeq + 1, this.now(), this.now(), nextRole);
        const as = nextRole === "steward" ? " as the room steward" : "";
        this.post(roomId, "system", "system", `${agentId} joined${as}: ${description}`);
      }
      this.tick(roomId);
      const history = this.messages(roomId);
      this.markSeen(roomId, agentId, history.at(-1)?.id ?? 0);
      return { room: this.getRoom(roomId), members: this.members(roomId), history, rejoined };
    });
  }
  /**
   * One non-blocking turn check. Records that the agent is waiting (bringing it back if it was
   * away) and skips a speaker who is away or whose turn has timed out.
   */
  peek(roomId, agentId) {
    return this.tx(() => {
      const me = this.requireMember(roomId, agentId);
      this.db.prepare("UPDATE members SET last_poll_at = ?, away = 0 WHERE room_id = ? AND agent_id = ?").run(this.now(), roomId, agentId);
      if (me.away && this.getRoom(roomId).status === "open") {
        this.post(roomId, "system", "system", `\u25B6 ${agentId} is back.`);
      }
      this.tick(roomId);
      const room = this.getRoom(roomId);
      const members = this.members(roomId);
      const waitingForAgents = Math.max(0, room.min_agents - members.length);
      return {
        roomId,
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
  async waitForTurn(roomId, agentId, { timeoutMs = 45e3, pollMs = 1e3 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let state = this.peek(roomId, agentId);
    const done = () => state.status !== "open" || this.unseenWakeup(roomId, agentId) || state.mode === "turns" && state.yourTurn;
    while (!done() && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      state = this.peek(roomId, agentId);
    }
    const routing = this.routing(roomId);
    const newMessages = this.deliver(roomId, agentId);
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
  unseenWakeup(roomId, agentId) {
    const unseen = this.db.prepare(
      `SELECT id, kind, content, created_at FROM messages WHERE room_id = ? AND sender != ? AND kind != 'system'
           AND id > (SELECT last_seen FROM members WHERE room_id = ? AND agent_id = ?)`
    ).all(roomId, agentId, roomId, agentId);
    if (!unseen.length) return false;
    const routing = this.routing(roomId);
    return unseen.some((m) => addressedTo(m, agentId, routing, this.now()));
  }
  /** The room's ledger: open work first, then what finished in the last week (or everything with all). */
  ledger(roomId, { all = false } = {}) {
    this.getRoom(roomId);
    const items = this.db.prepare(
      `SELECT * FROM ledger WHERE room_id = ?
           AND (? OR status NOT IN ('done', 'dropped') OR updated_at >= ?)
         ORDER BY updated_at DESC, id DESC`
    ).all(roomId, all ? 1 : 0, this.now() - LEDGER_RECENT_MS);
    const rank = (s) => LEDGER_ORDER.indexOf(s);
    return items.sort((a, b) => rank(a.status) - rank(b.status));
  }
  /** When the room's ledger last changed (ms), 0 while it is empty. */
  ledgerUpdatedAt(roomId) {
    const row = this.db.prepare("SELECT MAX(updated_at) AS at FROM ledger WHERE room_id = ?").get(roomId);
    return row?.at ?? 0;
  }
  /** Creates an item (no id: needs kind and title) or changes one. Only the room's steward writes. */
  ledgerUpdate(roomId, agentId, change) {
    return this.tx(() => {
      const steward = this.routing(roomId).steward?.agentId;
      if (!steward) throw new Error(`Room "${roomId}" has no steward, so nobody keeps its ledger.`);
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
          roomId,
          kind,
          change.title.trim(),
          change.owner ?? "",
          status ?? "open",
          change.detail ?? "",
          change.refs ?? "",
          now,
          now
        );
        return this.ledgerItem(roomId, Number(lastInsertRowid));
      }
      const item = this.ledgerItem(roomId, change.id);
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
        roomId,
        item.id
      );
      return this.ledgerItem(roomId, item.id);
    });
  }
  /**
   * HUMAN closes (done), drops or answers (reply) a ledger item: one HUMAN message to the agent that asked, which
   * says Approved or Not approved for an approval or decision, Done or Not needed for anything else
   * (or to the steward when no member owns it), and the item finished with that message in its refs. The one
   * ledger write that does not come from the steward.
   */
  humanResolve(roomId, id, action, text = "") {
    return this.tx(() => {
      const room = this.getRoom(roomId);
      if (room.status !== "open") throw new Error(`Room "${roomId}" is ${room.status}.`);
      const item = this.ledgerItem(roomId, id);
      if (item.status === "done" || item.status === "dropped")
        throw new Error(`L${id} is already ${item.status}.`);
      const answer = text.trim();
      if (action === "reply" && !answer) throw new Error("A reply needs the answer text.");
      const members = this.members(roomId);
      const to = members.some((m) => m.agent_id === item.owner) ? item.owner : members.find((m) => m.role === "steward")?.agent_id;
      const approval = item.kind === "approval" || item.kind === "decision";
      const verdict = action === "done" ? approval ? "Approved" : "Done" : approval ? "Not approved" : "Not needed";
      const said = action === "reply" ? `L${id}: ${answer}` : `${verdict}: L${id} ${item.title}`;
      this.db.prepare("UPDATE rooms SET done_streak = 0 WHERE id = ?").run(roomId);
      const message = this.post(roomId, "human", "human", to ? `@${to} ${said}` : said);
      const detail = action === "reply" ? [item.detail.trim(), `HUMAN (#${message.id}): ${answer}`].filter(Boolean).join("\n") : item.detail;
      this.db.prepare(
        "UPDATE ledger SET status = ?, detail = ?, refs = ?, updated_at = ? WHERE room_id = ? AND id = ?"
      ).run(
        action === "drop" ? "dropped" : "done",
        detail,
        [item.refs.trim(), `#${message.id}`].filter(Boolean).join(" "),
        this.now(),
        roomId,
        id
      );
      return { item: this.ledgerItem(roomId, id), message };
    });
  }
  ledgerItem(roomId, id) {
    const item = this.db.prepare("SELECT * FROM ledger WHERE room_id = ? AND id = ?").get(roomId, id);
    if (!item) throw new Error(`No ledger item L${id} in room "${roomId}".`);
    return item;
  }
  /** The room's mode and its active steward, for addressedTo. */
  routing(roomId) {
    const { mode } = this.getRoom(roomId);
    if (mode !== "chat") return { mode, steward: null };
    const row = this.db.prepare(
      `SELECT agent_id, last_seen FROM members
          WHERE room_id = ? AND role = 'steward' AND active = 1 AND removed = 0`
    ).get(roomId);
    return { mode, steward: row ? { agentId: row.agent_id, lastSeen: row.last_seen } : null };
  }
  /** Messages from others the agent has not seen yet; advances the agent's read cursor. */
  deliver(roomId, agentId) {
    return this.tx(() => {
      const member = this.requireMember(roomId, agentId);
      const all = this.messages(roomId, member.last_seen);
      if (all.length) this.markSeen(roomId, agentId, all.at(-1).id);
      return all.filter((m) => m.sender !== agentId);
    });
  }
  speak(roomId, agentId, content, done = false) {
    return this.tx(() => {
      this.requireMember(roomId, agentId);
      const room = this.getRoom(roomId);
      if (room.status !== "open")
        throw new Error(`Room "${roomId}" is ${room.status}; stop working in it.`);
      const members = this.members(roomId);
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
      this.db.prepare("UPDATE members SET last_poll_at = ? WHERE room_id = ? AND agent_id = ?").run(this.now(), roomId, agentId);
      this.post(roomId, agentId, "agent", content, done);
      const streak = done ? room.done_streak + 1 : 0;
      this.db.prepare("UPDATE rooms SET done_streak = ? WHERE id = ?").run(streak, roomId);
      if (done && this.everyoneAgreed(roomId, members)) {
        this.db.prepare(`UPDATE rooms SET status = 'done' WHERE id = ?`).run(roomId);
        this.post(
          roomId,
          "system",
          "system",
          "\u2705 Every agent marked the goals as done. Room finished."
        );
        return { room: this.getRoom(roomId), nextSpeaker: null };
      }
      return { room: this.getRoom(roomId), nextSpeaker: chat ? null : this.passTurn(roomId) };
    });
  }
  leave(roomId, agentId) {
    this.tx(() => {
      this.requireMember(roomId, agentId);
      this.db.prepare("UPDATE members SET active = 0 WHERE room_id = ? AND agent_id = ?").run(roomId, agentId);
      this.post(roomId, "system", "system", `${agentId} left the room.`);
      if (this.getRoom(roomId).current_agent === agentId) this.passTurn(roomId);
    });
  }
  /** The human takes an agent out of the room; the room is told. */
  remove(roomId, agentId) {
    this.tx(() => {
      this.requireMember(roomId, agentId);
      this.db.prepare("UPDATE members SET active = 0, removed = 1 WHERE room_id = ? AND agent_id = ?").run(roomId, agentId);
      this.post(roomId, "system", "system", `${agentId} was removed by HUMAN.`);
      if (this.getRoom(roomId).current_agent === agentId) this.passTurn(roomId);
    });
  }
  /** Out-of-turn message from the human owner. */
  say(roomId, content) {
    return this.tx(() => {
      const room = this.getRoom(roomId);
      if (room.status !== "open") throw new Error(`Room "${roomId}" is ${room.status}.`);
      this.db.prepare("UPDATE rooms SET done_streak = 0 WHERE id = ?").run(roomId);
      return this.post(roomId, "human", "human", content);
    });
  }
  close(roomId) {
    this.tx(() => {
      this.getRoom(roomId);
      this.db.prepare(`UPDATE rooms SET status = 'closed' WHERE id = ?`).run(roomId);
      this.post(roomId, "system", "system", "Room closed by the human.");
    });
  }
  // --- internals (callers must already be inside tx) ---
  /**
   * True when every member is among the agents who said done since the last message that was not
   * a done vote (an agent's non-done message or any human message). One agent voting twice while
   * another is skipped does not count as agreement.
   */
  everyoneAgreed(roomId, members) {
    const recent = this.db.prepare(
      `SELECT sender, kind, done FROM messages WHERE room_id = ? AND kind != 'system' ORDER BY id DESC`
    ).iterate(roomId);
    const voters = /* @__PURE__ */ new Set();
    for (const m of recent) {
      if (m.kind === "human" || !m.done) break;
      voters.add(m.sender);
      if (members.every((member) => voters.has(member.agent_id))) return true;
    }
    return false;
  }
  /** Skip the current speaker if it is away or out of time, and hand out a free turn. */
  tick(roomId) {
    const room = this.getRoom(roomId);
    if (room.status !== "open" || room.mode === "chat") return;
    const members = this.members(roomId);
    if (members.length < room.min_agents) {
      this.db.prepare("UPDATE rooms SET turn_started_at = ? WHERE id = ?").run(this.now(), roomId);
      return;
    }
    const current = members.find((m) => m.agent_id === room.current_agent);
    if (!current || current.away) {
      this.passTurn(roomId);
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
      this.post(roomId, "system", "system", `\u23ED ${current.agent_id} skipped: ${why}.`);
      this.passTurn(roomId, current.agent_id);
      return;
    }
    this.db.prepare("UPDATE members SET away = 1 WHERE room_id = ? AND agent_id = ?").run(roomId, current.agent_id);
    this.post(
      roomId,
      "system",
      "system",
      `\u23ED ${current.agent_id} skipped (${why}). Its turns are skipped until it calls wait_for_turn again.`
    );
    this.passTurn(roomId);
  }
  /**
   * Give the turn to the next present member after the last speaker (or after `skipped`, an
   * agent that just lost its turn). If the last speaker is the only one present, nobody gets the
   * turn until an away member comes back, so no agent talks to itself.
   */
  passTurn(roomId, skipped) {
    const room = this.getRoom(roomId);
    const members = this.members(roomId);
    const candidates = members.filter((m) => !m.away && m.agent_id !== skipped);
    const last = this.db.prepare(
      `SELECT sender FROM messages WHERE room_id = ? AND kind = 'agent' ORDER BY id DESC LIMIT 1`
    ).get(roomId);
    const baseAgent = skipped ?? last?.sender;
    const baseSeq = baseAgent ? this.member(roomId, baseAgent)?.seq ?? 0 : 0;
    let next = members.length >= room.min_agents ? candidates.find((m) => m.seq > baseSeq) ?? candidates[0] : void 0;
    if (!skipped && next && next.agent_id === last?.sender && members.length > 1) next = void 0;
    this.setTurn(roomId, next?.agent_id ?? null);
    return next?.agent_id ?? null;
  }
  setTurn(roomId, agentId) {
    this.db.prepare("UPDATE rooms SET current_agent = ?, turn_started_at = ? WHERE id = ?").run(agentId, this.now(), roomId);
  }
  member(roomId, agentId) {
    return this.db.prepare("SELECT * FROM members WHERE room_id = ? AND agent_id = ?").get(roomId, agentId);
  }
  requireMember(roomId, agentId) {
    this.getRoom(roomId);
    const member = this.member(roomId, agentId);
    if (member?.removed)
      throw new Error(
        `HUMAN removed you from room "${roomId}". Stop using this room; do not rejoin unless HUMAN asks you to.`
      );
    if (!member?.active)
      throw new Error(`"${agentId}" is not in room "${roomId}". Call join_room first.`);
    return member;
  }
  markSeen(roomId, agentId, messageId) {
    this.db.prepare(
      "UPDATE members SET last_seen = MAX(last_seen, ?) WHERE room_id = ? AND agent_id = ?"
    ).run(messageId, roomId, agentId);
  }
  post(roomId, sender, kind, content, done = false) {
    const { lastInsertRowid } = this.db.prepare(
      "INSERT INTO messages (room_id, sender, kind, content, done, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(roomId, sender, kind, content, done ? 1 : 0, this.now());
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

// apps/muster-plugin/src/tools.ts
import { execFileSync } from "node:child_process";

// apps/muster-plugin/src/format.ts
var QUIET_SESSION = "Handle room messages in the room. In your own session, write at most one short line about them (or nothing): your user reads every session and does not want room traffic summarized there. Anything your user must approve or do goes to the room as one message that mentions @HUMAN and starts with the action, not to your session.";
var PROTOCOL = `HOW THIS ROOM WORKS
- Call wait_for_turn(room_id, agent_id). If it is not your turn, call wait_for_turn again right away. Keep looping: do not stop, end your session, or ask the user while you wait.
- Turns are for talking. On your turn, read the new messages and call speak(room_id, agent_id, message) within a few minutes. Speaking passes the turn to the next agent.
- Do long work (big edits, builds, test runs) between turns: say on your turn what you are about to do, speak, do the work, then call wait_for_turn again and report the results on your next turn. While you are busy the room skips your turns; calling wait_for_turn brings you back with every message you missed.
- Edit files shared with other agents only during your turn. Your own project you can work on at any time.
- Keep messages under about 200 words and concrete: what you did, the results, and what you need from which agent. If you have nothing to add, say so in one line.
- Messages from HUMAN come from the person who owns the room. They take priority: act on them as soon as you see them, even when it is not your turn.
- When you believe all room goals are met, speak with done=true. The room finishes when every agent says done in the same round.
- Stop looping only when wait_for_turn says the room is finished or closed, or when HUMAN tells you to leave (then call leave_room).`;
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
function protocolFor(room, role = "member") {
  if (role === "steward") return STEWARD_PROTOCOL;
  return room.mode === "chat" ? CHAT_PROTOCOL : PROTOCOL;
}
function formatMessage(m) {
  const who = m.kind === "human" ? "HUMAN" : m.sender;
  return `[#${m.id} ${who}${m.done ? " \u2713done" : ""}] ${m.content}`;
}
function formatMessages(messages, empty = "(no new messages)") {
  return messages.length ? messages.map(formatMessage).join("\n") : empty;
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
function formatLedger(roomId, items, all = false) {
  if (!items.length) return `The ledger of room "${roomId}" is empty.`;
  const scope = all ? "every item" : "open work, and what finished in the last 7 days";
  const groups = LEDGER_ORDER.flatMap((status) => {
    const group = items.filter((i) => i.status === status);
    return group.length ? [LEDGER_HEADINGS[status], ...group.map(formatLedgerItem)] : [];
  });
  return [`LEDGER of room "${roomId}" (${scope}):`, "", ...groups].join("\n");
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

// apps/muster-plugin/src/monitor.ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
var quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
function listenCommand(roomId, agentId) {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const cli = existsSync(`${dir}cli.js`) ? `${dir}cli.js` : `${dir}cli.ts`;
  return [
    quote(process.execPath),
    "--disable-warning=ExperimentalWarning",
    quote(cli),
    "listen",
    quote(roomId),
    quote(agentId)
  ].join(" ");
}
function monitorText(roomId, agentId) {
  return `You run in Grok CLI, so start your Muster monitor once per session: call the monitor tool with persistent: true, description: "Muster ${roomId}", command: ${listenCommand(roomId, agentId)}. It prints a line when a message for you arrives, which wakes you; then call wait_for_turn. It stops by itself when you leave the room.`;
}

// apps/muster-plugin/src/tools.ts
var WAIT_SEC_BY_CLIENT = {
  claude: 90,
  // interactive Claude Code moves MCP calls longer than 120 s to a background task, which loops the Stop hook
  codex: 55,
  // a plugin cannot raise Codex's default MCP tool timeout (60 s); also one code-mode yield
  agy: 170,
  // measured 2026-10-24: Antigravity cuts MCP calls at 3 minutes
  grok: 600,
  // Grok CLI's MCP tool timeout defaults to 6000 s (tool_timeout_sec)
  unknown: 45
};
function kindOf(cli) {
  const exe = cli.trim().split(/\s+/)[0] ?? "";
  if (/(^|\/)grok$/.test(exe) || exe.includes("/.grok/")) return "grok";
  if (/(^|\/)claude(\s|$)/.test(cli)) return "claude";
  if (/codex/.test(cli)) return "codex";
  if (/(^|\/)agy(\s|$)|antigravity/i.test(cli)) return "agy";
  return "unknown";
}
function clientKind() {
  if (process.env.MUSTER_CLIENT) return process.env.MUSTER_CLIENT;
  try {
    const ps = (pid, field) => execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim();
    return kindOf(ps(Number(ps(process.ppid, "ppid")), "command"));
  } catch {
  }
  return "unknown";
}
var CLIENT = clientKind();
var WAIT_MS = Number(process.env.MUSTER_WAIT_SEC ?? WAIT_SEC_BY_CLIENT[CLIENT] ?? WAIT_SEC_BY_CLIENT.unknown) * 1e3;
var CHAT_WAIT_MS = Math.min(WAIT_MS, 55e3);
function idleChat(roomId, agentId) {
  if (CLIENT === "claude")
    return "you are woken automatically when someone mentions you or HUMAN writes";
  if (CLIENT === "grok")
    return `your Muster monitor wakes you when a message for you arrives (if it is not running: ${monitorText(roomId, agentId)})`;
  return "Muster types a line into your terminal when a message for you arrives (otherwise you get it when your next turn ends)";
}
function str(args, key) {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing "${key}".`);
  return value;
}
function optional(args, key, type) {
  const value = args[key];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== type) throw new Error(`"${key}" must be a ${type}.`);
  return value;
}
var tools = {
  create_room(store2, args) {
    const room = store2.createRoom({
      name: str(args, "name"),
      description: str(args, "description"),
      goals: str(args, "goals"),
      minAgents: optional(args, "min_agents", "number"),
      turnTimeoutSec: optional(args, "turn_timeout_sec", "number"),
      mode: optional(args, "mode", "string")
    });
    return `Created room "${room.id}".

${formatBrief(room)}

Prompt for each agent:
${joinPrompt(room)}`;
  },
  list_rooms(store2) {
    const rooms = store2.listRooms();
    if (!rooms.length) return "No rooms yet. Create one with create_room.";
    return rooms.map(
      (r) => `${r.id} [${r.status}] "${r.name}": ${r.goals}
  members: ${r.members.map((m) => m.agent_id).join(", ") || "(none)"}` + (r.status === "open" && r.current_agent ? `; current turn: ${r.current_agent}` : "")
    ).join("\n");
  },
  join_room(store2, args) {
    const agentId = str(args, "agent_id");
    const role = optional(args, "role", "string");
    if (role !== void 0 && role !== "member" && role !== "steward")
      throw new Error('role must be "member" or "steward".');
    const { room, members, history, rejoined } = store2.join(
      str(args, "room_id"),
      agentId,
      str(args, "description"),
      role
    );
    const me = members.find((m) => m.agent_id === agentId);
    const position = members.findIndex((m) => m.agent_id === agentId) + 1;
    const waiting = Math.max(0, room.min_agents - members.length);
    return [
      `${rejoined ? "Rejoined" : "Joined"} as ${agentId}. You are #${position} in the turn order.`,
      formatBrief(room),
      `MEMBERS (turn order):
${formatMembers(members, room, agentId)}`,
      waiting ? `Turns start when ${waiting} more agent(s) join.` : "",
      `HISTORY:
${formatMessages(history, "(empty)")}`,
      protocolFor(room, me?.role),
      CLIENT === "grok" && room.mode === "chat" ? monitorText(room.id, agentId) : "",
      "Next: call wait_for_turn."
    ].filter(Boolean).join("\n\n");
  },
  async wait_for_turn(store2, args) {
    const roomId = str(args, "room_id");
    const agentId = str(args, "agent_id");
    const chat = store2.getRoom(roomId).mode === "chat";
    const t = await store2.waitForTurn(roomId, agentId, {
      timeoutMs: chat ? CHAT_WAIT_MS : WAIT_MS
    });
    const news = `New messages:
${formatMessages(t.newMessages)}`;
    if (t.status === "done") {
      return `\u25A0 ROOM FINISHED: every agent agreed the goals are met. Stop looping.

${news}`;
    }
    if (t.status === "closed") return `\u25A0 ROOM CLOSED by the human. Stop looping.

${news}`;
    if (t.mode === "chat") {
      if (t.human || t.mentioned) {
        return `\u2709 New messages for you (chat mode: no turns, speak any time).

${news}

Act on what is addressed to you. Speak only if you have something to add, mentioning who needs it (@agent-id, @all); no acknowledgements. Then call wait_for_turn again. ${QUIET_SESSION}`;
      }
      return `Nothing for you yet (chat mode). Continue your own work if you have any; otherwise end your turn now and do not call wait_for_turn again: ${idleChat(roomId, agentId)}.

${news}`;
    }
    if (t.yourTurn) {
      return `\u25B6 YOUR TURN.

${news}

Reply now with speak(room_id, agent_id, message). If you need long work, say what you will do, speak, do it, then call wait_for_turn.`;
    }
    const why = t.waitingForAgents ? `Waiting for ${t.waitingForAgents} more agent(s) to join.` : t.currentSpeaker ? `Not your turn yet: ${t.currentSpeaker} has the turn.` : `Not your turn yet: waiting for ${t.away.join(", ") || "other agents"} to come back.`;
    if (t.human) {
      return `\u2709 HUMAN wrote to the room. ${why}

${news}

Act on the HUMAN message now (you may work outside your turn), then call wait_for_turn.`;
    }
    return `${why} Call wait_for_turn again now.

${news}`;
  },
  speak(store2, args) {
    const { room, nextSpeaker } = store2.speak(
      str(args, "room_id"),
      str(args, "agent_id"),
      str(args, "message"),
      optional(args, "done", "boolean") ?? false
    );
    if (room.status === "done")
      return "\u2705 Sent. Every agent agreed the goals are met, so the room is finished. Stop.";
    if (room.mode === "chat") return "Sent. Call wait_for_turn to wait for messages for you.";
    const next = nextSpeaker ? `Next speaker: ${nextSpeaker}.` : "The other agents are away, so nobody holds the turn until one comes back.";
    return `Sent. ${next} Call wait_for_turn to wait for your next turn.`;
  },
  ledger(store2, args) {
    const roomId = str(args, "room_id");
    const all = optional(args, "all", "boolean") ?? false;
    return formatLedger(roomId, store2.ledger(roomId, { all }), all);
  },
  ledger_update(store2, args) {
    const item = store2.ledgerUpdate(str(args, "room_id"), str(args, "agent_id"), {
      id: optional(args, "id", "number"),
      kind: optional(args, "kind", "string"),
      title: optional(args, "title", "string"),
      status: optional(args, "status", "string"),
      owner: optional(args, "owner", "string"),
      detail: optional(args, "detail", "string"),
      refs: optional(args, "refs", "string")
    });
    return `Saved L${item.id}: [${item.kind}] ${item.title} (${item.status}).`;
  },
  leave_room(store2, args) {
    const roomId = str(args, "room_id");
    store2.leave(roomId, str(args, "agent_id"));
    return `Left room "${roomId}".`;
  }
};
async function runTool(store2, name, args) {
  const tool = tools[name];
  if (!tool) throw new Error(`Unknown tool "${name}".`);
  return tool(store2, args ?? {});
}

// apps/muster-plugin/src/worker.ts
var store = new RoomStore();
process.on("message", async ({ id, name, args }) => {
  let response;
  try {
    response = { id, ok: true, text: await runTool(store, name, args) };
  } catch (err) {
    response = { id, ok: false, text: err.message };
  }
  process.send?.(response);
});
process.on("disconnect", () => process.exit(0));
