import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { loadEnv } from "./env.js";
import { AgentClient } from "./client.js";

loadEnv();

const RELAY_URL = (process.env.RELAY_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.RELAY_TOKEN || "dev-token";
// A connect token from the app already names the agent; AGENT_ID is only
// needed when connecting with the shared relay token.
const USES_CONNECT_TOKEN = TOKEN.startsWith("aic_");
const AGENT_ID = process.env.AGENT_ID || (USES_CONNECT_TOKEN ? null : "claude");
const AGENT_NAME = process.env.AGENT_NAME || AGENT_ID || "claude";
const AVATAR = process.env.AVATAR || "🤖";

const CLAUDE = process.env.CLAUDE_BIN || "claude";
const WORKDIR = path.resolve(process.env.WORKDIR || ".");
const PERMISSION_MODE = process.env.PERMISSION_MODE || "";
const TIMEOUT_MS = Number(process.env.TIMEOUT || 300) * 1000;

// A thread is a conversation, and so is a Claude Code session — mapping one
// to one is what makes the chat feel continuous instead of restarting at
// every message. Kept on disk so a restart of this adapter doesn't silently
// drop the context the person on the other end still thinks is there.
const STATE = path.join(path.dirname(new URL(import.meta.url).pathname), "sessions.json");

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function saveSessions(map) {
  try {
    fs.writeFileSync(STATE, JSON.stringify(map, null, 2));
  } catch (err) {
    console.log("[claude] could not save sessions:", err.message);
  }
}

const sessions = loadSessions();

/** One turn of Claude Code, resuming this thread's session when it has one. */
function runClaude(threadId, prompt) {
  const args = ["-p", "--output-format", "json"];
  if (sessions[threadId]) args.push("--resume", sessions[threadId]);
  if (PERMISSION_MODE) args.push("--permission-mode", PERMISSION_MODE);
  args.push(prompt);

  return new Promise((resolve) => {
    execFile(
      CLAUDE,
      args,
      { cwd: WORKDIR, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // A resume that fails (session pruned, different machine) should not
        // strand the chat: forget the id so the next message starts fresh.
        if (!stdout.trim()) {
          if (sessions[threadId]) {
            delete sessions[threadId];
            saveSessions(sessions);
          }
          const why = err?.killed
            ? `No answer within ${TIMEOUT_MS / 1000}s.`
            : (stderr || err?.message || "claude produced no output").trim();
          return resolve({ text: why, ok: false });
        }
        let out;
        try {
          out = JSON.parse(stdout);
        } catch {
          return resolve({ text: stdout.trim().slice(0, 4000), ok: true });
        }
        if (out.session_id && out.session_id !== sessions[threadId]) {
          sessions[threadId] = out.session_id;
          saveSessions(sessions);
        }
        const text = String(out.result ?? "").trim();
        resolve({ text: text || "(no output)", ok: !out.is_error });
      }
    );
  });
}

// One turn at a time per thread. Two overlapping messages would resume the
// same session concurrently, and the second would run against a session the
// first has not finished writing.
const queues = new Map();

function enqueue(threadId, job) {
  const prev = queues.get(threadId) ?? Promise.resolve();
  const next = prev.then(job, job);
  queues.set(threadId, next.catch(() => {}));
  return next;
}

const client = new AgentClient({
  relayUrl: RELAY_URL,
  token: TOKEN,
  id: AGENT_ID,
  name: AGENT_NAME,
  avatar: AVATAR,
  onReady: (c) => c.log(`running claude in ${WORKDIR}`),
  onInbound: ({ thread, message, mentioned }, c) => {
    if (message.sender_id === c.id || message.kind === "status") return;
    // Same rule as the other adapters: always answer a DM, only answer a
    // group when named.
    if (thread.kind !== "dm" && !mentioned) return;

    const text = String(message.text ?? "").trim();
    if (!text) return;

    enqueue(thread.id, async () => {
      c.status(thread.id, "thinking…");
      const { text: reply, ok } = await runClaude(thread.id, text);
      if (!ok) c.log(`turn failed: ${reply.slice(0, 200)}`);
      c.say(thread.id, reply.slice(0, 8000));
    });
  },
});

client.connect();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    client.close();
    process.exit(0);
  });
}
