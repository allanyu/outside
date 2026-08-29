import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const USER_ID = "user";

let db;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "files"), { recursive: true });
  db = new Database(path.join(dataDir, "agentinbox.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      avatar_emoji  TEXT NOT NULL DEFAULT '🤖',
      status        TEXT NOT NULL DEFAULT 'offline',
      last_seen     INTEGER NOT NULL DEFAULT 0,
      connect_token TEXT
    );

    CREATE TABLE IF NOT EXISTS threads (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      name        TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_participants (
      thread_id       TEXT NOT NULL,
      participant_id  TEXT NOT NULL,
      PRIMARY KEY (thread_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      thread_id    TEXT NOT NULL,
      sender_id    TEXT NOT NULL,
      text         TEXT NOT NULL DEFAULT '',
      attachments  TEXT NOT NULL DEFAULT '[]',
      mentions     TEXT NOT NULL DEFAULT '[]',
      reply_to     TEXT,
      kind         TEXT NOT NULL DEFAULT 'text',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages (thread_id, created_at);

    CREATE TABLE IF NOT EXISTS approvals (
      id          TEXT PRIMARY KEY,
      thread_id   TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      options     TEXT NOT NULL DEFAULT '[]',
      decision    TEXT,
      decided_at  INTEGER,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      mime        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
  `);
  // Databases created before agents had their own connect tokens.
  const columns = db.prepare("PRAGMA table_info(agents)").all().map((c) => c.name);
  if (!columns.includes("connect_token")) {
    db.exec("ALTER TABLE agents ADD COLUMN connect_token TEXT");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_connect_token ON agents (connect_token) WHERE connect_token IS NOT NULL"
  );
  return db;
}

export const now = () => Date.now();

/* ---------- agents ---------- */

export function upsertAgent({ id, name, avatar_emoji }) {
  const existing = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  if (existing) {
    db.prepare(
      "UPDATE agents SET name = ?, avatar_emoji = ? WHERE id = ?"
    ).run(name ?? existing.name, avatar_emoji ?? existing.avatar_emoji, id);
  } else {
    db.prepare(
      `INSERT INTO agents (id, name, avatar_emoji, status, last_seen)
       VALUES (?, ?, ?, 'offline', 0)`
    ).run(id, name ?? id, avatar_emoji ?? "🤖");
  }
  return getAgent(id);
}

export function getAgent(id) {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
}

export function listAgents() {
  return db.prepare("SELECT * FROM agents ORDER BY name").all();
}

export function createAgentWithToken({ id, name, avatar_emoji, connect_token }) {
  db.prepare(
    `INSERT INTO agents (id, name, avatar_emoji, status, last_seen, connect_token)
     VALUES (?, ?, ?, 'offline', 0, ?)`
  ).run(id, name, avatar_emoji, connect_token);
  return getAgent(id);
}

export function getAgentByConnectToken(token) {
  if (!token) return null;
  return db.prepare("SELECT * FROM agents WHERE connect_token = ?").get(token);
}

/** Removes the agent and any thread it leaves with no agents in it. */
export function deleteAgent(id) {
  const threadIds = db
    .prepare("SELECT thread_id FROM thread_participants WHERE participant_id = ?")
    .all(id)
    .map((r) => r.thread_id);

  db.prepare("DELETE FROM thread_participants WHERE participant_id = ?").run(id);
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);

  const removed = [];
  for (const threadId of threadIds) {
    const remaining = participantIds(threadId).filter((p) => p !== USER_ID);
    if (remaining.length > 0) continue;
    db.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
    db.prepare("DELETE FROM approvals WHERE thread_id = ?").run(threadId);
    db.prepare("DELETE FROM thread_participants WHERE thread_id = ?").run(threadId);
    db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
    removed.push(threadId);
  }
  return removed;
}

export function setAgentStatus(id, status, lastSeen) {
  db.prepare("UPDATE agents SET status = ?, last_seen = ? WHERE id = ?").run(
    status,
    lastSeen ?? now(),
    id
  );
}

export function touchAgentSeen(id, at) {
  db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(at, id);
}

/* ---------- threads ---------- */

export function createThread({ id, kind, name, participant_ids }) {
  const t = { id, kind, name: name ?? null, created_at: now() };
  db.prepare(
    "INSERT INTO threads (id, kind, name, created_at) VALUES (?, ?, ?, ?)"
  ).run(t.id, t.kind, t.name, t.created_at);
  const add = db.prepare(
    "INSERT OR IGNORE INTO thread_participants (thread_id, participant_id) VALUES (?, ?)"
  );
  for (const pid of participant_ids) add.run(id, pid);
  return getThread(id);
}

export function getThread(id) {
  const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, participant_ids: participantIds(id) };
}

export function participantIds(threadId) {
  return db
    .prepare(
      "SELECT participant_id FROM thread_participants WHERE thread_id = ? ORDER BY participant_id"
    )
    .all(threadId)
    .map((r) => r.participant_id);
}

export function listThreads() {
  return db
    .prepare("SELECT * FROM threads")
    .all()
    .map((t) => ({ ...t, participant_ids: participantIds(t.id) }));
}

export function threadsForParticipant(participantId) {
  return db
    .prepare(
      `SELECT t.* FROM threads t
       JOIN thread_participants p ON p.thread_id = t.id
       WHERE p.participant_id = ?`
    )
    .all(participantId)
    .map((t) => ({ ...t, participant_ids: participantIds(t.id) }));
}

// A DM is a thread with exactly ["user", agentId].
export function findDm(agentId) {
  const row = db
    .prepare(
      `SELECT t.id FROM threads t
       WHERE t.kind = 'dm'
         AND EXISTS (SELECT 1 FROM thread_participants WHERE thread_id = t.id AND participant_id = ?)
         AND EXISTS (SELECT 1 FROM thread_participants WHERE thread_id = t.id AND participant_id = ?)
         AND (SELECT COUNT(*) FROM thread_participants WHERE thread_id = t.id) = 2`
    )
    .get(USER_ID, agentId);
  return row ? getThread(row.id) : null;
}

/* ---------- messages ---------- */

export function insertMessage(m) {
  db.prepare(
    `INSERT INTO messages
       (id, thread_id, sender_id, text, attachments, mentions, reply_to, kind, created_at)
     VALUES (@id, @thread_id, @sender_id, @text, @attachments, @mentions, @reply_to, @kind, @created_at)`
  ).run({
    ...m,
    attachments: JSON.stringify(m.attachments ?? []),
    mentions: JSON.stringify(m.mentions ?? []),
    reply_to: m.reply_to ?? null,
  });
  return getMessage(m.id);
}

export function updateMessageText(id, text) {
  db.prepare("UPDATE messages SET text = ? WHERE id = ?").run(text, id);
  return getMessage(id);
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    attachments: JSON.parse(row.attachments),
    mentions: JSON.parse(row.mentions),
  };
}

export function updateMessageMentions(id, mentions) {
  const m = getMessage(id);
  if (!m) return null;
  const merged = [...new Set([...m.mentions, ...mentions])];
  db.prepare("UPDATE messages SET mentions = ? WHERE id = ?").run(
    JSON.stringify(merged),
    id
  );
  return getMessage(id);
}

export function getMessage(id) {
  return hydrate(db.prepare("SELECT * FROM messages WHERE id = ?").get(id));
}

export function messagesForThread(threadId, { since = null, limit = 100 } = {}) {
  if (since !== null) {
    return db
      .prepare(
        "SELECT * FROM messages WHERE thread_id = ? AND created_at > ? ORDER BY created_at ASC"
      )
      .all(threadId, since)
      .map(hydrate);
  }
  // last N, returned oldest-first
  return db
    .prepare(
      "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(threadId, limit)
    .map(hydrate)
    .reverse();
}

// Consecutive agent messages at the tail of the thread (reset by a user message).
export function consecutiveAgentMessages(threadId) {
  const rows = db
    .prepare(
      "SELECT sender_id FROM messages WHERE thread_id = ? AND kind != 'status' ORDER BY created_at DESC LIMIT 64"
    )
    .all(threadId);
  let n = 0;
  for (const r of rows) {
    if (r.sender_id === USER_ID) break;
    n++;
  }
  return n;
}

/* ---------- approvals ---------- */

export function insertApproval(a) {
  db.prepare(
    `INSERT INTO approvals
       (id, thread_id, agent_id, message_id, prompt, options, decision, decided_at, created_at)
     VALUES (@id, @thread_id, @agent_id, @message_id, @prompt, @options, NULL, NULL, @created_at)`
  ).run({ ...a, options: JSON.stringify(a.options ?? []) });
  return getApproval(a.id);
}

export function getApproval(id) {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, options: JSON.parse(row.options) };
}

export function decideApproval(id, decision) {
  db.prepare(
    "UPDATE approvals SET decision = ?, decided_at = ? WHERE id = ? AND decision IS NULL"
  ).run(decision, now(), id);
  return getApproval(id);
}

export function approvalsForThread(threadId) {
  return db
    .prepare("SELECT * FROM approvals WHERE thread_id = ? ORDER BY created_at")
    .all(threadId)
    .map((r) => ({ ...r, options: JSON.parse(r.options) }));
}

export function listApprovals() {
  return db
    .prepare("SELECT * FROM approvals ORDER BY created_at")
    .all()
    .map((r) => ({ ...r, options: JSON.parse(r.options) }));
}

/* ---------- files ---------- */

export function insertFile({ id, mime, size }) {
  db.prepare(
    "INSERT INTO files (id, mime, size, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, mime, size, now());
}

export function getFile(id) {
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id);
}
