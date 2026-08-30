import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { loadEnv } from "./env.js";
import * as db from "./db.js";
import { verifyAppleToken } from "./apple.js";
import { USER_ID } from "./db.js";

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RELAY_TOKEN || "dev-token";
const LOOP_GUARD = Number(process.env.LOOP_GUARD || 6);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
// The audience an Apple identity token must name: this app's bundle id.
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "com.allanyu.agentinbox";
const FILES_DIR = path.join(DATA_DIR, "files");

db.openDb(DATA_DIR);

const uid = () => crypto.randomUUID();
const secret = (prefix) => `${prefix}_${crypto.randomBytes(18).toString("base64url")}`;

/**
 * The relay serves several people. Each has an account holding their own
 * agents and threads; RELAY_TOKEN belongs to the first one and doubles as the
 * bootstrap for a fresh install.
 */
function ownerAccount() {
  let owner = db.ownerAccount();
  if (!owner) {
    owner = db.createAccount({
      id: uid(),
      name: "Owner",
      token: TOKEN,
      is_owner: 1,
    });
    log(`created the owner account`);
  } else if (owner.token !== TOKEN) {
    // RELAY_TOKEN was rotated in .env — follow it.
    db.retokenAccount(owner.id, TOKEN);
    owner = db.getAccount(owner.id);
  }
  return owner;
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------------------------ *
 * connections
 * ------------------------------------------------------------------ */

const appSockets = new Set();          // ws, each tagged with .accountId
const agentSockets = new Map();        // agent_id -> ws

function sendJson(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

/** Broadcast to every device signed in to one account, and only that account. */
function toApp(accountId, obj) {
  for (const ws of appSockets) {
    if (ws.accountId === accountId) sendJson(ws, obj);
  }
}

function toAgent(agentId, obj) {
  sendJson(agentSockets.get(agentId), obj);
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

// Readable, typeable token: no 0/O/1/I.
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function mintToken() {
  const bytes = crypto.randomBytes(14);
  let out = "";
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return `aic_${out}`;
}

function slugify(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "agent";
}

/**
 * Creates an offline agent with its own connect token, ready to be handed out.
 * The name doubles as the @handle that mention routing matches on, so it has
 * to be unique -- two agents called "hermes" would both answer to @hermes.
 */
function mintAgent({
  name,
  avatar_emoji,
  host_agent_id = null,
  profile = null,
  account_id,
  // A credential a backend connects with is not a conversation. Without this
  // the gateway shows up in the inbox as a chat nobody can talk to.
  createChat = true,
}) {
  const base = slugify(name);
  const taken = (handle) =>
    db.getAgent(handle) ||
    db.listAgents(account_id).some((a) => a.name.toLowerCase() === handle);

  let handle = base;
  for (let n = 2; taken(handle); n++) handle = `${base}-${n}`;

  // A hosted agent is served over an existing connection, so it needs no
  // token of its own and nothing has to be configured where that agent runs.
  const host = host_agent_id ? db.getAgent(host_agent_id) : null;
  if (host_agent_id && !host) throw new Error("no such host agent");
  if (host && host.account_id !== account_id) throw new Error("no such host agent");
  if (host?.host_id) throw new Error("cannot host from a hosted agent");

  const agent = db.createAgentWithToken({
    id: handle,
    name: handle,
    avatar_emoji: avatar_emoji?.trim() || "🤖",
    connect_token: host ? null : mintToken(),
    host_id: host?.id ?? null,
    profile: host ? profile : null,
    account_id,
  });

  if (createChat) {
    const { thread, created } = ensureDm(handle);
    if (created) {
      toApp(account_id, { type: "thread", thread: threadPayload(thread.id) });
    }
  }

  // The host is already connected, so the new agent is live immediately.
  if (host && agentSockets.has(host.id)) {
    db.setAgentStatus(agent.id, "online");
    toAgent(host.id, {
      type: "host_agent_added",
      agent: db.getAgent(agent.id),
      threads: db.threadsForParticipant(agent.id),
    });
  }

  const final = db.getAgent(agent.id);
  toApp(account_id, { type: "agent_status", agent: final });
  return final;
}

function ensureDm(agentId) {
  const existing = db.findDm(agentId);
  if (existing) return { thread: existing, created: false };
  const agent = db.getAgent(agentId);
  const thread = db.createThread({
    id: uid(),
    kind: "dm",
    name: agent?.name ?? agentId,
    participant_ids: [USER_ID, agentId],
    account_id: agent?.account_id ?? null,
  });
  return { thread, created: true };
}

// "@alpha please ask @beta" -> [agentId...] for names/ids that exist
function parseMentions(text, accountId) {
  const agents = db.listAgents(accountId);
  const found = new Set();
  for (const m of String(text || "").matchAll(/@([\w.\-]+)/g)) {
    const tag = m[1].toLowerCase();
    for (const a of agents) {
      if (a.name.toLowerCase() === tag || a.id.toLowerCase() === tag) {
        found.add(a.id);
      }
    }
  }
  return [...found];
}

function accountOfThread(threadId) {
  return db.getThread(threadId)?.account_id ?? null;
}

function threadPayload(threadId) {
  const t = db.getThread(threadId);
  if (!t) return null;
  return { ...t, messages: db.messagesForThread(threadId, { limit: 100 }) };
}

/**
 * Store a message and fan it out.
 *   - always to the app
 *   - to every other agent in the thread, unless the loop guard has tripped
 */
function deliver(message, { skipAgents = false } = {}) {
  const thread = db.getThread(message.thread_id);
  if (!thread) return;

  toApp(thread.account_id, { type: "message", message });
  if (skipAgents) return;

  const fromUser = message.sender_id === USER_ID;
  if (!fromUser) {
    const streak = db.consecutiveAgentMessages(message.thread_id);
    if (streak > LOOP_GUARD) {
      log(
        `loop guard: thread ${message.thread_id} hit ${streak} consecutive agent messages, not relaying agent->agent`
      );
      return;
    }
  }

  for (const pid of thread.participant_ids) {
    if (pid === USER_ID || pid === message.sender_id) continue;
    const agent = db.getAgent(pid);
    // A hosted agent has no socket; its traffic rides its host's.
    const socketOwner = agent?.host_id ?? pid;
    sendJson(agentSockets.get(socketOwner), {
      type: "inbound",
      agent_id: pid,
      thread: { ...thread },
      message,
      mentioned: message.mentions.includes(pid),
    });
  }
}

function postMessage({
  thread_id,
  sender_id,
  text = "",
  attachments = [],
  mentions,
  reply_to = null,
  kind = "text",
}) {
  const resolved = mentions?.length
    ? mentions
    : parseMentions(text, accountOfThread(thread_id));
  return db.insertMessage({
    id: uid(),
    thread_id,
    sender_id,
    text,
    attachments,
    mentions: resolved,
    reply_to,
    kind,
    created_at: db.now(),
  });
}

/* ------------------------------------------------------------------ *
 * REST
 * ------------------------------------------------------------------ */

const app = express();
app.use(express.json({ limit: "2mb" }));

function tokenOf(req) {
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return req.query.token;
}

function requireToken(req, res, next) {
  const account = db.getAccountByToken(tokenOf(req));
  if (!account) return res.status(401).json({ error: "bad token" });
  req.account = account;
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

/** A page to open on the machine where the agent runs. */
app.get("/setup", (_req, res) => {
  res.sendFile(path.join(import.meta.dirname, "setup.html"));
});

/** The one-line setup script, with this relay's own address baked in. */
app.get("/connect.sh", (_req, res) => {
  const script = fs
    .readFileSync(path.join(import.meta.dirname, "connect.sh.txt"), "utf8")
    .replaceAll("{{RELAY}}", publicUrl());
  res.type("text/plain").send(script);
});

/**
 * Redeem a pairing code for the account's gateway credential. Single use, and
 * short-lived -- the code is short enough to type, so it must not be a
 * long-lived secret.
 */
app.post("/api/pair", (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const row = db.redeemPairCode(code);
  if (!row) return res.status(404).json({ error: "unknown or expired code" });
  log(`paired a backend to account ${row.account_id}`);
  res.json({ token: row.token, relay_url: publicUrl() });
});

/**
 * Sign in with Apple. The identity token is the whole credential -- it is
 * verified against Apple's published keys, and its subject is what identifies
 * the person. Nothing else about them is stored.
 *
 * Same endpoint signs up and signs in: a subject we have not seen gets a new
 * account, one we have seen gets its existing token back.
 */
app.post("/api/auth/apple", async (req, res) => {
  const idToken = String(req.body?.identity_token || "");
  const name = String(req.body?.name || "").trim().slice(0, 40);
  if (!idToken) return res.status(400).json({ error: "identity_token required" });

  let claims;
  try {
    claims = await verifyAppleToken(idToken, APPLE_BUNDLE_ID);
  } catch (err) {
    log(`apple sign-in rejected: ${err.message}`);
    return res.status(401).json({ error: "could not verify that sign-in" });
  }

  let account = db.getAccountByAppleSub(claims.sub);
  if (!account) {
    account = db.createAccount({
      id: uid(),
      name: name || "You",
      token: secret("acct"),
      apple_sub: claims.sub,
    });
    log(`new account via Apple: ${account.name}`);
  } else if (name && account.name === "You") {
    // Apple only sends a name the first time; take it if we never got one.
    account = db.renameAccount(account.id, name);
  }

  res.json({
    account: { id: account.id, name: account.name, is_owner: !!account.is_owner },
    token: account.token,
    relay_url: publicUrl(),
  });
});

/**
 * Redeem an invite. This is the only unauthenticated write: the code itself is
 * the credential, it works once, and what it grants is a brand-new empty
 * account rather than access to anyone else's.
 */
app.post("/api/join", (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const name = String(req.body?.name || "").trim();
  const invite = db.getInvite(code);
  if (!invite) return res.status(404).json({ error: "no such invite" });
  if (invite.claimed_by) return res.status(409).json({ error: "invite already used" });

  // The bootstrap invite belongs to whoever set the relay up, so claiming it
  // makes that person the owner rather than a guest.
  const isBootstrap = invite.name === "bootstrap";
  const account = db.createAccount({
    id: uid(),
    name: name || (isBootstrap ? "Owner" : invite.name) || "Guest",
    token: secret("acct"),
    is_owner: isBootstrap ? 1 : 0,
  });
  db.claimInvite(code, account.id);
  log(`invite ${code} claimed -> account ${account.name}`);
  res.json({
    account: { id: account.id, name: account.name },
    token: account.token,
    relay_url: publicUrl(),
  });
});

app.get("/api/agents", requireToken, (req, res) =>
  res.json({ agents: db.listAgents(req.account.id) })
);

app.post("/api/agents/register", requireToken, (req, res) => {
  const { agent_id, name, avatar_emoji } = req.body || {};
  if (!agent_id) return res.status(400).json({ error: "agent_id required" });
  const agent = registerAgent({
    agent_id,
    name,
    avatar_emoji,
    online: false,
    account_id: req.account.id,
  });
  res.json({ agent });
});

app.post("/api/agents/mint", requireToken, (req, res) => {
  const { name, avatar_emoji, host_agent_id, profile } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const agent = mintAgent({
      name,
      avatar_emoji,
      host_agent_id,
      profile,
      account_id: req.account.id,
    });
    res.json({ agent, relay_url: publicUrl() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/agents/:id", requireToken, (req, res) => {
  const agent = db.getAgent(req.params.id);
  if (!agent || agent.account_id !== req.account.id) {
    return res.status(404).json({ error: "no such agent" });
  }
  removeAgent(agent.id);
  res.json({ ok: true });
});

app.get("/api/threads", requireToken, (req, res) =>
  res.json({ threads: db.listThreads(req.account.id) })
);

app.post("/api/threads", requireToken, (req, res) => {
  const { kind, name, participant_ids } = req.body || {};
  const thread = createThreadFromApp({
    kind,
    name,
    participant_ids,
    account_id: req.account.id,
  });
  if (!thread) return res.status(400).json({ error: "participant_ids required" });
  res.json({ thread });
});

app.get("/api/threads/:id/messages", requireToken, (req, res) => {
  if (db.getThread(req.params.id)?.account_id !== req.account.id) {
    return res.status(404).json({ error: "no such thread" });
  }
  const since = req.query.since != null ? Number(req.query.since) : null;
  res.json({ messages: db.messagesForThread(req.params.id, { since }) });
});

app.post("/api/threads/:id/messages", requireToken, (req, res) => {
  const thread = db.getThread(req.params.id);
  if (!thread || thread.account_id !== req.account.id) {
    return res.status(404).json({ error: "no such thread" });
  }
  const { sender_id = USER_ID, text, attachments, mentions, reply_to } =
    req.body || {};
  const message = postMessage({
    thread_id: thread.id,
    sender_id,
    text,
    attachments,
    mentions,
    reply_to,
  });
  deliver(message);
  res.json({ message });
});

// Raw-body upload so the relay keeps its three dependencies.
//   POST /api/files?mime=image/jpeg   (body = bytes)
app.post(
  "/api/files",
  requireToken,
  express.raw({ type: "*/*", limit: "25mb" }),
  (req, res) => {
    const body = req.body;
    if (!body?.length) return res.status(400).json({ error: "empty body" });
    const mime = String(req.query.mime || "application/octet-stream");
    const id = uid();
    fs.writeFileSync(path.join(FILES_DIR, id), body);
    db.insertFile({ id, mime, size: body.length });
    res.json({ id, url: `/files/${id}`, mime, size: body.length });
  }
);

app.get("/files/:id", (req, res) => {
  const meta = db.getFile(req.params.id);
  const p = path.join(FILES_DIR, path.basename(req.params.id));
  if (!meta || !fs.existsSync(p)) return res.status(404).end();
  res.type(meta.mime);
  fs.createReadStream(p).pipe(res);
});

/* ------------------------------------------------------------------ *
 * shared actions
 * ------------------------------------------------------------------ */

/**
 * `isTransport` marks the connection itself. A connection is not a chat: the
 * chats are the profiles it reports, one each. Without this the gateway would
 * show up as a conversation alongside the bots it carries.
 */
function registerAgent({ agent_id, name, avatar_emoji, online, account_id, isTransport = false }) {
  db.upsertAgent({ id: agent_id, name, avatar_emoji, account_id });
  if (online) db.setAgentStatus(agent_id, "online");
  const agent = db.getAgent(agent_id);
  if (isTransport) {
    // It may have been a chat before it reported profiles. It is not one now.
    const stale = db.findDm(agent_id);
    if (stale) {
      db.deleteThread(stale.id);
      toApp(agent.account_id, {
        type: "agent_removed",
        agent_id: null,
        thread_ids: [stale.id],
      });
    }
  } else {
    const { thread, created } = ensureDm(agent_id);
    if (created) {
      toApp(agent.account_id, { type: "thread", thread: threadPayload(thread.id) });
    }
  }
  toApp(agent.account_id, { type: "agent_status", agent });
  return agent;
}

/**
 * One chat per profile the connection reports, and no others. Profiles are
 * created and deleted on the backend; the app only mirrors them.
 */
function syncProfiles(connectionId, profiles, accountId) {
  // Either bare names or {name, display}. The display name is what the
  // backend calls the bot, and it is what the chat should be called.
  const wanted = new Map(
    (profiles ?? []).map((p) => {
      const name = typeof p === "string" ? p : String(p?.name ?? "");
      const display = typeof p === "string" ? p : String(p?.display || p?.name || "");
      return [slugify(name), { name, display: display || name }];
    })
  );

  for (const [id, { name: profileName, display }] of wanted) {
    const existing = db.getAgent(id);
    if (existing) {
      db.setAgentHost(id, connectionId);
      db.setAgentStatus(id, "online");
      // The bot may have been renamed on the backend.
      if (existing.name !== display) {
        db.upsertAgent({ id, name: display });
        const dm = db.findDm(id);
        if (dm) db.renameThread(dm.id, display);
      }
    } else {
      db.createAgentWithToken({
        id,
        name: display,
        avatar_emoji: "🤖",
        connect_token: null,
        host_id: connectionId,
        profile: profileName,
        account_id: accountId,
      });
      log(`chat added for '${display}'`);
    }
    const { thread, created } = ensureDm(id);
    if (created) {
      toApp(accountId, { type: "thread", thread: threadPayload(thread.id) });
    }
    toApp(accountId, { type: "agent_status", agent: db.getAgent(id) });
  }

  // A profile deleted on the backend stops being a chat.
  for (const hosted of db.agentsHostedBy(connectionId)) {
    if (wanted.has(hosted.id)) continue;
    log(`chat removed, profile '${hosted.name}' is gone`);
    removeAgent(hosted.id);
  }
}

function removeAgent(agentId) {
  const accountId = db.getAgent(agentId)?.account_id ?? null;
  agentSockets.get(agentId)?.close();
  agentSockets.delete(agentId);
  const removedThreads = db.deleteAgent(agentId);
  toApp(accountId, {
    type: "agent_removed",
    agent_id: agentId,
    thread_ids: removedThreads,
  });
  log(`agent removed: ${agentId}`);
}

function createThreadFromApp({ kind, name, participant_ids, account_id }) {
  if (!Array.isArray(participant_ids) || participant_ids.length === 0) return null;
  const ids = [...new Set([USER_ID, ...participant_ids])];
  // Only agents in this account may be put in a thread.
  for (const pid of ids) {
    if (pid === USER_ID) continue;
    if (db.getAgent(pid)?.account_id !== account_id) return null;
  }
  const resolvedKind = kind || (ids.length === 2 ? "dm" : "group");
  if (resolvedKind === "dm") {
    const agentId = ids.find((i) => i !== USER_ID);
    const existing = db.findDm(agentId);
    if (existing) return existing;
  }
  const thread = db.createThread({
    id: uid(),
    kind: resolvedKind,
    name: name || null,
    participant_ids: ids,
    account_id,
  });
  toApp(account_id, { type: "thread", thread: threadPayload(thread.id) });
  for (const pid of ids) {
    if (pid === USER_ID) continue;
    toAgent(pid, { type: "thread", thread });
  }
  return thread;
}

/* ------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------ */

const server = http.createServer(app);
const appWss = new WebSocketServer({ noServer: true });
const agentWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  const reject = () => {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  };

  if (url.pathname === "/ws/app") {
    const account = db.getAccountByToken(token);
    if (!account) return reject();
    appWss.handleUpgrade(req, socket, head, (ws) => {
      ws.accountId = account.id;
      appWss.emit("connection", ws);
    });
  } else if (url.pathname === "/ws/agent") {
    // Either the shared relay token, or an agent's own connect token — in
    // which case the agent's identity comes from the token, not from register.
    const owner = db.getAccountByToken(token);
    const bound = owner ? null : db.getAgentByConnectToken(token);
    if (!owner && !bound) return reject();
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      ws.boundAgentId = bound?.id ?? null;
      // A connect token carries its agent's account; the shared token carries
      // the account it belongs to.
      ws.accountId = bound?.account_id ?? owner?.id ?? null;
      agentWss.emit("connection", ws);
    });
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

/* ---------- /ws/app ---------- */

appWss.on("connection", (ws) => {
  appSockets.add(ws);
  const account = db.getAccount(ws.accountId);
  log(`app connected: ${account?.name ?? "?"} (${appSockets.size} total)`);

  const threads = db.listThreads(ws.accountId);
  const threadIds = new Set(threads.map((t) => t.id));
  sendJson(ws, {
    type: "snapshot",
    user_id: USER_ID,
    relay_url: publicUrl(),
    loop_guard: LOOP_GUARD,
    account: account
      ? { id: account.id, name: account.name, is_owner: !!account.is_owner }
      : null,
    agents: db.listAgents(ws.accountId),
    threads: threads.map((t) => threadPayload(t.id)),
    approvals: db.listApprovals().filter((a) => threadIds.has(a.thread_id)),
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      handleAppMessage(ws, msg);
    } catch (err) {
      log("app message error:", err.message);
      sendJson(ws, { type: "error", error: err.message });
    }
  });

  ws.on("close", () => {
    appSockets.delete(ws);
    log(`app disconnected (${appSockets.size})`);
  });
});

function handleAppMessage(ws, msg) {
  const accountId = ws.accountId;
  const ownsThread = (id) => db.getThread(id)?.account_id === accountId;

  switch (msg.type) {
    case "send": {
      if (!ownsThread(msg.thread_id)) throw new Error("no such thread");
      const message = postMessage({
        thread_id: msg.thread_id,
        sender_id: USER_ID,
        text: msg.text ?? "",
        attachments: msg.attachments ?? [],
        mentions: msg.mentions,
        reply_to: msg.reply_to ?? null,
      });
      deliver(message);
      break;
    }
    // Chats mirror the backend's profiles, so the app cannot make one.
    // Two ways to start over, and they differ on the backend:
    //   "continue" — the backend resets, recording the new conversation as
    //                following the old one, so its history stays traceable.
    //   "separate" — a new session key, so the conversation is unrelated to
    //                anything before it.
    case "new_session": {
      const thread = db.getThread(msg.thread_id);
      if (!thread || thread.account_id !== accountId) {
        throw new Error("no such thread");
      }
      const separate = msg.mode === "separate";
      const agentId = thread.participant_ids.find((p) => p !== USER_ID);
      const agent = agentId ? db.getAgent(agentId) : null;

      const tag = separate ? crypto.randomBytes(6).toString("hex") : undefined;
      db.startNewSession(thread.id, tag);
      toApp(accountId, { type: "thread", thread: threadPayload(thread.id) });

      if (agent?.host_id) {
        toAgent(agent.host_id, {
          type: "new_session",
          mode: separate ? "separate" : "continue",
          agent_id: agent.id,
          thread_id: thread.id,
          session_tag: db.getThread(thread.id).session_tag,
          profile: agent.profile,
        });
      }
      log(`${separate ? "separate" : "new"} session in ${agent?.name ?? thread.id}`);
      break;
    }
    case "decide": {
      const existing = db.getApproval(msg.approval_id);
      if (!existing || !ownsThread(existing.thread_id)) {
        throw new Error("no such approval");
      }
      const approval = db.decideApproval(msg.approval_id, msg.decision);
      if (!approval) throw new Error("no such approval");
      toApp(accountId, { type: "approval", approval });
      toAgent(approval.agent_id, {
        type: "decision",
        approval_id: approval.id,
        decision: approval.decision,
        thread_id: approval.thread_id,
      });
      break;
    }
    case "set_profile": {
      const name = String(msg.name || "").trim().slice(0, 40);
      if (!name) throw new Error("name required");
      const updated = db.renameAccount(accountId, name);
      toApp(accountId, {
        type: "account",
        account: {
          id: updated.id,
          name: updated.name,
          is_owner: !!updated.is_owner,
        },
      });
      break;
    }

    // The credential a backend uses to connect. One per account: whatever
    // connects with it becomes that account's gateway, and the bots it reports
    // become the chats. It is not a chat itself.
    // A short code standing in for the gateway credential, so setup is one
    // line someone can read out loud.
    case "pair_code": {
      let gateway = db
        .listAgents(accountId)
        .find((a) => !a.profile && a.connect_token);
      if (!gateway) {
        gateway = mintAgent({
          name: "gateway",
          account_id: accountId,
          createChat: false,
        });
      }

      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let code = "";
      for (const b of crypto.randomBytes(6)) code += alphabet[b % alphabet.length];
      const created = db.createPairCode({
        code,
        account_id: accountId,
        token: gateway.connect_token,
        ttlMs: 15 * 60 * 1000,
      });
      sendJson(ws, {
        type: "pair_code",
        code: created.code,
        expires_at: created.expires_at,
        relay_url: publicUrl(),
      });
      break;
    }

    case "gateway_token": {
      let gateway = db
        .listAgents(accountId)
        .find((a) => !a.profile && a.connect_token);
      if (!gateway) {
        gateway = mintAgent({
          name: "gateway",
          account_id: accountId,
          createChat: false,
        });
      }
      sendJson(ws, {
        type: "gateway_token",
        token: gateway.connect_token,
        relay_url: publicUrl(),
      });
      break;
    }

    // Invite someone else onto this relay. They get their own account: their
    // own agents, their own threads, no sight of yours.
    case "create_invite": {
      const code = crypto.randomBytes(4).toString("hex").toUpperCase();
      const invite = db.createInvite({
        code,
        created_by: accountId,
        name: msg.name ?? null,
      });
      sendJson(ws, { type: "invite", invite, relay_url: publicUrl() });
      break;
    }
    case "ping":
      sendJson(ws, { type: "pong" });
      break;
    default:
      break;
  }
}

/* ---------- /ws/agent ---------- */

agentWss.on("connection", (ws) => {
  ws.agentId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      handleAgentMessage(ws, msg);
    } catch (err) {
      log("agent message error:", err.message);
      sendJson(ws, { type: "error", error: err.message });
    }
  });

  ws.on("close", () => {
    if (!ws.agentId) return;
    if (agentSockets.get(ws.agentId) === ws) {
      agentSockets.delete(ws.agentId);
      for (const id of [ws.agentId, ...db.agentsHostedBy(ws.agentId).map((a) => a.id)]) {
        db.setAgentStatus(id, "offline");
        const a = db.getAgent(id);
        toApp(a?.account_id, { type: "agent_status", agent: a });
      }
      log(`agent offline: ${ws.agentId}`);
    }
  });
});

function handleAgentMessage(ws, msg) {
  if (msg.type === "register") {
    // A connect token names the agent, so register does not have to.
    const id = ws.boundAgentId ?? msg.agent_id;
    if (!id) throw new Error("agent_id required");
    if (ws.boundAgentId && msg.agent_id && msg.agent_id !== ws.boundAgentId) {
      throw new Error("this connect token belongs to a different agent");
    }
    const previous = db.getAgent(id);
    const since = previous?.last_seen ?? 0;

    const old = agentSockets.get(id);
    if (old && old !== ws) old.close();
    ws.agentId = id;
    agentSockets.set(id, ws);

    if (Array.isArray(msg.profiles)) db.setAgentProfiles(id, msg.profiles);
    const agent = registerAgent({
      agent_id: id,
      name: msg.name,
      avatar_emoji: msg.avatar_emoji,
      online: true,
      account_id: ws.accountId,
      isTransport: Array.isArray(msg.profiles) && msg.profiles.length > 0,
    });
    if (Array.isArray(msg.profiles) && msg.profiles.length) {
      syncProfiles(id, msg.profiles, ws.accountId);
    }
    log(`agent online: ${id} (${agent.name})`);

    // Agents created in the app under this one are served over this socket.
    const hosted = db.agentsHostedBy(id);
    for (const h of hosted) {
      db.setAgentStatus(h.id, "online");
      toApp(h.account_id, { type: "agent_status", agent: db.getAgent(h.id) });
    }

    const threads = db.threadsForParticipant(id);
    sendJson(ws, {
      type: "registered",
      agent,
      threads,
      hosted: hosted.map((h) => ({
        agent: db.getAgent(h.id),
        threads: db.threadsForParticipant(h.id),
      })),
      user_id: USER_ID,
    });

    // Backlog: what each identity missed while it was away. Each one keeps
    // its own last_seen -- using the connection's would replay conversations a
    // hosted agent had already answered, and it would answer them twice.
    const identities = [
      { id, threads, since },
      ...hosted.map((h) => ({
        id: h.id,
        threads: db.threadsForParticipant(h.id),
        since: h.last_seen ?? 0,
      })),
    ];
    for (const who of identities) {
      for (const thread of who.threads) {
        for (const m of db.messagesForThread(thread.id, { since: who.since })) {
          if (m.sender_id === who.id || m.kind === "status") continue;
          sendJson(ws, {
            type: "inbound",
            agent_id: who.id,
            thread,
            message: m,
            mentioned: m.mentions.includes(who.id),
            backlog: true,
          });
        }
      }
      db.touchAgentSeen(who.id, db.now());
    }
    return;
  }

  const connectionId = ws.agentId;
  if (!connectionId) throw new Error("register first");
  // The connection is live whatever identity it speaks as, so its own
  // last_seen has to move too or its backlog window never closes.
  db.touchAgentSeen(connectionId, db.now());

  // A host connection may act as itself or as any agent it hosts.
  const claimed = msg.agent_id;
  let agentId = connectionId;
  if (claimed && claimed !== connectionId) {
    const target = db.getAgent(claimed);
    if (!target || target.host_id !== connectionId) {
      throw new Error(`not authorised to act as ${claimed}`);
    }
    agentId = claimed;
  }
  db.touchAgentSeen(agentId, db.now());

  switch (msg.type) {
    case "send": {
      if (!db.getThread(msg.thread_id)) throw new Error("no such thread");
      const message = postMessage({
        thread_id: msg.thread_id,
        sender_id: agentId,
        text: msg.text ?? "",
        attachments: msg.attachments ?? [],
        mentions: msg.mentions,
        reply_to: msg.reply_to ?? null,
      });
      deliver(message);
      break;
    }

    // The backend's bot list changed while connected.
    case "profiles": {
      if (!Array.isArray(msg.profiles)) break;
      db.setAgentProfiles(connectionId, msg.profiles);
      syncProfiles(connectionId, msg.profiles, ws.accountId);
      break;
    }

    // Ephemeral: shown in the app until a real message lands, never stored.
    case "status": {
      toApp(accountOfThread(msg.thread_id), {
        type: "status",
        thread_id: msg.thread_id,
        agent_id: agentId,
        text: msg.text ?? "",
      });
      break;
    }

    case "stream": {
      let message = db.getMessage(msg.message_id);
      if (!message) {
        message = db.insertMessage({
          id: msg.message_id || uid(),
          thread_id: msg.thread_id,
          sender_id: agentId,
          text: "",
          attachments: [],
          mentions: [],
          reply_to: msg.reply_to ?? null,
          kind: "text",
          created_at: db.now(),
        });
        toApp(accountOfThread(message.thread_id), { type: "message", message });
      }
      const updated = db.updateMessageText(
        message.id,
        message.text + (msg.delta ?? "")
      );
      toApp(accountOfThread(updated.thread_id), {
        type: "stream",
        thread_id: updated.thread_id,
        message_id: updated.id,
        delta: msg.delta ?? "",
      });
      break;
    }

    case "stream_end": {
      const message = db.getMessage(msg.message_id);
      if (!message) break;
      // stream_end may reveal mentions that were not visible on the first delta
      const mentions = parseMentions(message.text);
      const final = mentions.length
        ? db.updateMessageMentions(message.id, mentions)
        : message;
      toApp(accountOfThread(final.thread_id), { type: "stream_end", message: final });
      deliver(final);
      break;
    }

    case "ask_approval": {
      const approvalId = uid();
      const message = postMessage({
        thread_id: msg.thread_id,
        sender_id: agentId,
        text: msg.prompt ?? "",
        kind: "approval",
        mentions: [],
      });
      const approval = db.insertApproval({
        id: approvalId,
        thread_id: msg.thread_id,
        agent_id: agentId,
        message_id: message.id,
        prompt: msg.prompt ?? "",
        options: msg.options ?? ["Approve", "Deny"],
        created_at: db.now(),
      });
      const approvalAccount = accountOfThread(msg.thread_id);
      toApp(approvalAccount, { type: "message", message });
      toApp(approvalAccount, { type: "approval", approval });
      sendJson(ws, { type: "approval_created", approval });
      break;
    }

    default:
      break;
  }
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

// The address to hand to an agent on another machine — never 127.0.0.1.
function publicUrl() {
  return process.env.PUBLIC_URL || `http://${lanAddress()}:${PORT}`;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

const owner = ownerAccount();

/**
 * A bootstrap invite so the first device never has to hold RELAY_TOKEN. That
 * token is the master credential for the owner account and belongs on the
 * server, not on a phone.
 */
function bootstrapInvite() {
  const open = db
    .listInvites(owner.id)
    .find((i) => !i.claimed_by && i.name === "bootstrap");
  if (open) return open;
  if (db.listAccounts().length > 1) return null;
  return db.createInvite({
    code: crypto.randomBytes(4).toString("hex").toUpperCase(),
    created_by: owner.id,
    name: "bootstrap",
  });
}
{
  const adopted = db.adoptOrphans(owner.id);
  if (adopted.agents || adopted.threads) {
    log(
      `adopted ${adopted.agents} agent(s) and ${adopted.threads} thread(s) from before accounts existed`
    );
  }
}

// Any agent left marked online by a previous run is not online now.
for (const a of db.listAgents(owner.id)) {
  if (a.status === "online") db.setAgentStatus(a.id, "offline", a.last_seen);
}

server.listen(PORT, "0.0.0.0", () => {
  const lan = lanAddress();
  const url = `http://${lan}:${PORT}`;
  console.log("");
  console.log("  Agent Inbox relay");
  console.log(`  local     http://127.0.0.1:${PORT}`);
  console.log(`  lan       ${url}`);
  console.log(`  token     ${TOKEN}`);
  console.log(`  data      ${DATA_DIR}`);
  console.log(`  loopguard ${LOOP_GUARD}`);
  console.log(`  accounts  ${db.listAccounts().length}`);
  console.log("");
  const invite = bootstrapInvite();
  if (invite) {
    console.log("  no one has joined yet. Open this on a phone to claim it:");
    console.log(
      `  agentinbox://join?url=${encodeURIComponent(publicUrl())}&code=${invite.code}`
    );
  } else {
    console.log(
      `  agentinbox://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(TOKEN)}`
    );
  }
  console.log("");
});
