import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { loadEnv } from "./env.js";
import * as db from "./db.js";
import { USER_ID } from "./db.js";

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RELAY_TOKEN || "dev-token";
const LOOP_GUARD = Number(process.env.LOOP_GUARD || 6);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const FILES_DIR = path.join(DATA_DIR, "files");

db.openDb(DATA_DIR);

const uid = () => crypto.randomUUID();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------------------------ *
 * connections
 * ------------------------------------------------------------------ */

const appSockets = new Set();          // ws
const agentSockets = new Map();        // agent_id -> ws

function sendJson(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function toApp(obj) {
  for (const ws of appSockets) sendJson(ws, obj);
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
function mintAgent({ name, avatar_emoji, host_agent_id = null, profile = null }) {
  const base = slugify(name);
  const taken = (handle) =>
    db.getAgent(handle) ||
    db.listAgents().some((a) => a.name.toLowerCase() === handle);

  let handle = base;
  for (let n = 2; taken(handle); n++) handle = `${base}-${n}`;

  // A hosted agent is served over an existing connection, so it needs no
  // token of its own and nothing has to be configured where that agent runs.
  const host = host_agent_id ? db.getAgent(host_agent_id) : null;
  if (host_agent_id && !host) throw new Error("no such host agent");
  if (host?.host_id) throw new Error("cannot host from a hosted agent");

  const agent = db.createAgentWithToken({
    id: handle,
    name: handle,
    avatar_emoji: avatar_emoji?.trim() || "🤖",
    connect_token: host ? null : mintToken(),
    host_id: host?.id ?? null,
    profile: host ? profile : null,
  });

  const { thread, created } = ensureDm(handle);
  if (created) toApp({ type: "thread", thread: threadPayload(thread.id) });

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
  toApp({ type: "agent_status", agent: final });
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
  });
  return { thread, created: true };
}

// "@alpha please ask @beta" -> [agentId...] for names/ids that exist
function parseMentions(text) {
  const agents = db.listAgents();
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

  toApp({ type: "message", message });
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
  const resolved = mentions?.length ? mentions : parseMentions(text);
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
  if (tokenOf(req) !== TOKEN) return res.status(401).json({ error: "bad token" });
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/agents", requireToken, (_req, res) =>
  res.json({ agents: db.listAgents() })
);

app.post("/api/agents/register", requireToken, (req, res) => {
  const { agent_id, name, avatar_emoji } = req.body || {};
  if (!agent_id) return res.status(400).json({ error: "agent_id required" });
  const agent = registerAgent({ agent_id, name, avatar_emoji, online: false });
  res.json({ agent });
});

app.post("/api/agents/mint", requireToken, (req, res) => {
  const { name, avatar_emoji, host_agent_id, profile } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const agent = mintAgent({ name, avatar_emoji, host_agent_id, profile });
    res.json({ agent, relay_url: publicUrl() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/agents/:id", requireToken, (req, res) => {
  const agent = db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "no such agent" });
  removeAgent(agent.id);
  res.json({ ok: true });
});

app.get("/api/threads", requireToken, (_req, res) =>
  res.json({ threads: db.listThreads() })
);

app.post("/api/threads", requireToken, (req, res) => {
  const { kind, name, participant_ids } = req.body || {};
  const thread = createThreadFromApp({ kind, name, participant_ids });
  if (!thread) return res.status(400).json({ error: "participant_ids required" });
  res.json({ thread });
});

app.get("/api/threads/:id/messages", requireToken, (req, res) => {
  const since = req.query.since != null ? Number(req.query.since) : null;
  res.json({ messages: db.messagesForThread(req.params.id, { since }) });
});

app.post("/api/threads/:id/messages", requireToken, (req, res) => {
  const thread = db.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: "no such thread" });
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

function registerAgent({ agent_id, name, avatar_emoji, online }) {
  db.upsertAgent({ id: agent_id, name, avatar_emoji });
  if (online) db.setAgentStatus(agent_id, "online");
  const agent = db.getAgent(agent_id);
  const { thread, created } = ensureDm(agent_id);
  if (created) toApp({ type: "thread", thread: threadPayload(thread.id) });
  toApp({ type: "agent_status", agent });
  return agent;
}

function removeAgent(agentId) {
  agentSockets.get(agentId)?.close();
  agentSockets.delete(agentId);
  const removedThreads = db.deleteAgent(agentId);
  toApp({ type: "agent_removed", agent_id: agentId, thread_ids: removedThreads });
  log(`agent removed: ${agentId}`);
}

function createThreadFromApp({ kind, name, participant_ids }) {
  if (!Array.isArray(participant_ids) || participant_ids.length === 0) return null;
  const ids = [...new Set([USER_ID, ...participant_ids])];
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
  });
  toApp({ type: "thread", thread: threadPayload(thread.id) });
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
    if (token !== TOKEN) return reject();
    appWss.handleUpgrade(req, socket, head, (ws) => appWss.emit("connection", ws));
  } else if (url.pathname === "/ws/agent") {
    // Either the shared relay token, or an agent's own connect token — in
    // which case the agent's identity comes from the token, not from register.
    const bound = token === TOKEN ? null : db.getAgentByConnectToken(token);
    if (token !== TOKEN && !bound) return reject();
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      ws.boundAgentId = bound?.id ?? null;
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
  log(`app connected (${appSockets.size})`);

  sendJson(ws, {
    type: "snapshot",
    user_id: USER_ID,
    relay_url: publicUrl(),
    loop_guard: LOOP_GUARD,
    agents: db.listAgents(),
    threads: db.listThreads().map((t) => threadPayload(t.id)),
    approvals: db.listApprovals(),
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
  switch (msg.type) {
    case "send": {
      if (!db.getThread(msg.thread_id)) throw new Error("no such thread");
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
    case "create_thread": {
      createThreadFromApp(msg);
      break;
    }
    case "decide": {
      const approval = db.decideApproval(msg.approval_id, msg.decision);
      if (!approval) throw new Error("no such approval");
      toApp({ type: "approval", approval });
      toAgent(approval.agent_id, {
        type: "decision",
        approval_id: approval.id,
        decision: approval.decision,
        thread_id: approval.thread_id,
      });
      break;
    }
    case "mint_agent": {
      if (!msg.name) throw new Error("name required");
      const agent = mintAgent({
        name: msg.name,
        avatar_emoji: msg.avatar_emoji,
        host_agent_id: msg.host_agent_id ?? null,
        profile: msg.profile ?? null,
      });
      sendJson(ws, { type: "agent_minted", agent, relay_url: publicUrl() });
      break;
    }
    case "delete_agent": {
      if (!db.getAgent(msg.agent_id)) throw new Error("no such agent");
      removeAgent(msg.agent_id);
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
        toApp({ type: "agent_status", agent: db.getAgent(id) });
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
    });
    log(`agent online: ${id} (${agent.name})`);

    // Agents created in the app under this one are served over this socket.
    const hosted = db.agentsHostedBy(id);
    for (const h of hosted) {
      db.setAgentStatus(h.id, "online");
      toApp({ type: "agent_status", agent: db.getAgent(h.id) });
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

    // Backlog: everything since last_seen, for this agent and everything it hosts.
    for (const who of [{ id, threads }, ...hosted.map((h) => ({ id: h.id, threads: db.threadsForParticipant(h.id) }))]) {
      for (const thread of who.threads) {
        for (const m of db.messagesForThread(thread.id, { since })) {
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

    // Ephemeral: shown in the app until a real message lands, never stored.
    case "status": {
      toApp({
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
        toApp({ type: "message", message });
      }
      const updated = db.updateMessageText(
        message.id,
        message.text + (msg.delta ?? "")
      );
      toApp({
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
      toApp({ type: "stream_end", message: final });
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
      toApp({ type: "message", message });
      toApp({ type: "approval", approval });
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

// Any agent left marked online by a previous run is not online now.
for (const a of db.listAgents()) {
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
  console.log("");
  console.log(
    `  agentinbox://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(TOKEN)}`
  );
  console.log("");
});
