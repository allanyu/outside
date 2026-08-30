import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/// Every message a person sends carries this sender id, in every account.
export const USER_ID = "user";

let db;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "files"), { recursive: true });
  db = new Database(path.join(dataDir, "agentinbox.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      is_owner    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      -- Apple's stable subject id. The only thing tying an account to a
      -- person, and it is opaque -- no email, no name unless they type one.
      apple_sub   TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS invites (
      code         TEXT PRIMARY KEY,
      created_by   TEXT NOT NULL,
      name         TEXT,
      claimed_by   TEXT,
      claimed_at   INTEGER,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      avatar_emoji  TEXT NOT NULL DEFAULT '🤖',
      status        TEXT NOT NULL DEFAULT 'offline',
      last_seen     INTEGER NOT NULL DEFAULT 0,
      connect_token TEXT,
      -- When set, this agent has no connection of its own: it is served over
      -- the socket of the agent named here.
      host_id       TEXT,
      -- Optional hint for the host: which of its own personas/profiles should
      -- answer as this agent.
      profile       TEXT
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
  if (!columns.includes("host_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN host_id TEXT");
  }
  if (!columns.includes("profile")) {
    db.exec("ALTER TABLE agents ADD COLUMN profile TEXT");
  }
  if (!columns.includes("available_profiles")) {
    db.exec("ALTER TABLE agents ADD COLUMN available_profiles TEXT");
  }
  const accountCols = db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
  if (!accountCols.includes("apple_sub")) {
    db.exec("ALTER TABLE accounts ADD COLUMN apple_sub TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_apple_sub ON accounts (apple_sub) WHERE apple_sub IS NOT NULL");
  }

  // Everything belongs to an account. One relay, many people, no shared view.
  if (!columns.includes("account_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN account_id TEXT");
  }
  const threadCols = db.prepare("PRAGMA table_info(threads)").all().map((c) => c.name);
  if (!threadCols.includes("account_id")) {
    db.exec("ALTER TABLE threads ADD COLUMN account_id TEXT");
  }
  // Starting a new session does not delete anything: the transcript simply
  // begins here. Everything before stays in the table, unreachable.
  if (!threadCols.includes("session_started_at")) {
    db.exec("ALTER TABLE threads ADD COLUMN session_started_at INTEGER NOT NULL DEFAULT 0");
  }
  // Passed to the backend as the thread it should key a session under.
  // Changing it starts a conversation with no link to the previous one.
  if (!threadCols.includes("session_tag")) {
    db.exec("ALTER TABLE threads ADD COLUMN session_tag TEXT");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_connect_token ON agents (connect_token) WHERE connect_token IS NOT NULL"
  );
  return db;
}

export const now = () => Date.now();

/* ---------- accounts ---------- */

export function createAccount({ id, name, token, is_owner = 0, apple_sub = null }) {
  db.prepare(
    "INSERT INTO accounts (id, name, token, is_owner, created_at, apple_sub) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, name, token, is_owner ? 1 : 0, now(), apple_sub);
  return getAccount(id);
}

export function getAccountByAppleSub(sub) {
  if (!sub) return null;
  return db.prepare("SELECT * FROM accounts WHERE apple_sub = ?").get(sub);
}

export function getAccount(id) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
}

export function getAccountByToken(token) {
  if (!token) return null;
  return db.prepare("SELECT * FROM accounts WHERE token = ?").get(token);
}

/** Give pre-accounts rows to the owner, so upgrading loses nothing. */
export function adoptOrphans(accountId) {
  const agents = db
    .prepare("UPDATE agents SET account_id = ? WHERE account_id IS NULL")
    .run(accountId).changes;
  const threads = db
    .prepare("UPDATE threads SET account_id = ? WHERE account_id IS NULL")
    .run(accountId).changes;
  return { agents, threads };
}

export function renameAccount(id, name) {
  db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(name, id);
  return getAccount(id);
}

export function promoteToOwner(id) {
  db.prepare("UPDATE accounts SET is_owner = 1 WHERE id = ?").run(id);
  return getAccount(id);
}

export function retokenAccount(id, token) {
  db.prepare("UPDATE accounts SET token = ? WHERE id = ?").run(token, id);
}

export function listAccounts() {
  return db.prepare("SELECT * FROM accounts ORDER BY created_at").all();
}

export function ownerAccount() {
  return db.prepare("SELECT * FROM accounts WHERE is_owner = 1").get();
}

/* ---------- invites ---------- */

export function createInvite({ code, created_by, name = null }) {
  db.prepare(
    "INSERT INTO invites (code, created_by, name, created_at) VALUES (?, ?, ?, ?)"
  ).run(code, created_by, name, now());
  return getInvite(code);
}

export function getInvite(code) {
  return db.prepare("SELECT * FROM invites WHERE code = ?").get(code);
}

export function claimInvite(code, accountId) {
  db.prepare(
    "UPDATE invites SET claimed_by = ?, claimed_at = ? WHERE code = ? AND claimed_by IS NULL"
  ).run(accountId, now(), code);
  return getInvite(code);
}

export function listInvites(createdBy) {
  return db
    .prepare("SELECT * FROM invites WHERE created_by = ? ORDER BY created_at DESC")
    .all(createdBy);
}

/* ---------- agents ---------- */

export function upsertAgent({ id, name, avatar_emoji, account_id = null }) {
  const existing = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  if (existing) {
    db.prepare(
      "UPDATE agents SET name = ?, avatar_emoji = ? WHERE id = ?"
    ).run(name ?? existing.name, avatar_emoji ?? existing.avatar_emoji, id);
  } else {
    db.prepare(
      `INSERT INTO agents (id, name, avatar_emoji, status, last_seen, account_id)
       VALUES (?, ?, ?, 'offline', 0, ?)`
    ).run(id, name ?? id, avatar_emoji ?? "🤖", account_id);
  }
  return getAgent(id);
}

function hydrateAgent(row) {
  if (!row) return null;
  return {
    ...row,
    available_profiles: row.available_profiles
      ? JSON.parse(row.available_profiles)
      : [],
  };
}

export function getAgent(id) {
  return hydrateAgent(db.prepare("SELECT * FROM agents WHERE id = ?").get(id));
}

export function listAgents(accountId) {
  return db
    .prepare("SELECT * FROM agents WHERE account_id = ? ORDER BY name")
    .all(accountId)
    .map(hydrateAgent);
}

export function createAgentWithToken({
  id,
  name,
  avatar_emoji,
  connect_token,
  host_id = null,
  profile = null,
  account_id,
}) {
  db.prepare(
    `INSERT INTO agents (id, name, avatar_emoji, status, last_seen, connect_token, host_id, profile, account_id)
     VALUES (?, ?, ?, 'offline', 0, ?, ?, ?, ?)`
  ).run(id, name, avatar_emoji, connect_token, host_id, profile, account_id);
  return getAgent(id);
}

/** Personas/profiles a connected agent says it can answer as. */
export function setAgentProfiles(id, profiles) {
  db.prepare("UPDATE agents SET available_profiles = ? WHERE id = ?").run(
    JSON.stringify(profiles ?? []),
    id
  );
}

/** Agents served over `hostId`'s connection rather than one of their own. */
export function agentsHostedBy(hostId) {
  return db
    .prepare("SELECT * FROM agents WHERE host_id = ?")
    .all(hostId)
    .map(hydrateAgent);
}

export function setAgentHost(id, hostId) {
  db.prepare("UPDATE agents SET host_id = ? WHERE id = ?").run(hostId, id);
  return getAgent(id);
}

export function getAgentByConnectToken(token) {
  if (!token) return null;
  return hydrateAgent(
    db.prepare("SELECT * FROM agents WHERE connect_token = ?").get(token)
  );
}

export function renameThread(threadId, name) {
  db.prepare("UPDATE threads SET name = ? WHERE id = ?").run(name, threadId);
}

export function deleteThread(threadId) {
  db.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM approvals WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM thread_participants WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
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

export function createThread({ id, kind, name, participant_ids, account_id }) {
  const t = { id, kind, name: name ?? null, created_at: now() };
  db.prepare(
    "INSERT INTO threads (id, kind, name, created_at, account_id) VALUES (?, ?, ?, ?, ?)"
  ).run(t.id, t.kind, t.name, t.created_at, account_id);
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

export function listThreads(accountId) {
  return db
    .prepare("SELECT * FROM threads WHERE account_id = ?")
    .all(accountId)
    .map((t) => ({ ...t, participant_ids: participantIds(t.id) }));
}

export function accountOfAgent(agentId) {
  return getAgent(agentId)?.account_id ?? null;
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
  // Only the current session is visible.
  const from = db
    .prepare("SELECT session_started_at FROM threads WHERE id = ?")
    .get(threadId)?.session_started_at ?? 0;
  if (since !== null) {
    return db
      .prepare(
        "SELECT * FROM messages WHERE thread_id = ? AND created_at > ? AND created_at >= ? ORDER BY created_at ASC"
      )
      .all(threadId, since, from)
      .map(hydrate);
  }
  return db
    .prepare(
      "SELECT * FROM messages WHERE thread_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(threadId, from, limit)
    .map(hydrate)
    .reverse();
}

/**
 * Clear the visible transcript. `sessionTag` is only passed for a separate
 * conversation: a new tag means a new session key on the backend, so the new
 * conversation is not recorded as following the old one.
 */
export function startNewSession(threadId, sessionTag = undefined) {
  if (sessionTag === undefined) {
    db.prepare("UPDATE threads SET session_started_at = ? WHERE id = ?").run(
      now(),
      threadId
    );
  } else {
    db.prepare(
      "UPDATE threads SET session_started_at = ?, session_tag = ? WHERE id = ?"
    ).run(now(), sessionTag, threadId);
  }
  return getThread(threadId);
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
