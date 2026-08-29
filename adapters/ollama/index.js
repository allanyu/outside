import { loadEnv } from "./env.js";
import { AgentClient } from "./client.js";

loadEnv();

const RELAY_URL = (process.env.RELAY_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.RELAY_TOKEN || "dev-token";
// A connect token from the app already names the agent; AGENT_ID is only
// needed when connecting with the shared relay token.
const USES_CONNECT_TOKEN = TOKEN.startsWith("aic_");
const AGENT_ID = process.env.AGENT_ID || (USES_CONNECT_TOKEN ? null : "llama");
const AGENT_NAME = process.env.AGENT_NAME || AGENT_ID || "agent";
const AVATAR = process.env.AVATAR || "🦙";

const MODEL_URL = process.env.MODEL_URL || "http://127.0.0.1:11434/v1/chat/completions";
const MODEL = process.env.MODEL || "llama3.2";
const MODEL_API_KEY = process.env.MODEL_API_KEY || "";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT || "You are a terse assistant in a group chat.";
const HISTORY = Number(process.env.HISTORY || 30);

async function relayGet(path) {
  const res = await fetch(`${RELAY_URL}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`relay ${path}: ${res.status}`);
  return res.json();
}

/** Thread history as OpenAI chat messages, oldest first. */
async function history(threadId, me) {
  const { messages } = await relayGet(`/api/threads/${threadId}/messages`);
  return messages
    .filter((m) => m.kind !== "status")
    .slice(-HISTORY)
    .map((m) => ({
      role: m.sender_id === me.id ? "assistant" : "user",
      content:
        m.sender_id === "user" || m.sender_id === me.id
          ? m.text
          : `${m.sender_id}: ${m.text}`,
    }));
}

async function complete(messages) {
  const res = await fetch(MODEL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(MODEL_API_KEY ? { Authorization: `Bearer ${MODEL_API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

async function handleInbound({ thread, message, mentioned }, me) {
  if (message.sender_id === me.id) return;
  // DMs: always answer. Groups: only when mentioned.
  if (thread.kind !== "dm" && !mentioned) return;

  me.status(thread.id, "thinking…");
  try {
    const chat = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(await history(thread.id, me)),
    ];
    const reply = await complete(chat);
    if (reply) me.say(thread.id, reply);
  } catch (err) {
    me.log(err.message);
    me.say(thread.id, `_model error: ${err.message}_`);
  }
}

const agent = new AgentClient({
  relayUrl: RELAY_URL,
  token: TOKEN,
  id: AGENT_ID,
  name: AGENT_NAME,
  avatar: AVATAR,
  onInbound: handleInbound,
  onDecision: ({ decision, thread_id }, me) =>
    me.say(thread_id, `Noted: ${decision}.`),
});
agent.connect();

console.log(
  USES_CONNECT_TOKEN
    ? `ollama adapter -> ${RELAY_URL} (identity from the connect token, model ${MODEL})`
    : `ollama adapter -> ${RELAY_URL} as @${AGENT_NAME} (model ${MODEL})`
);
