import { loadEnv } from "./env.js";
import { AgentClient, sleep } from "./client.js";

loadEnv();

const RELAY_URL = process.env.RELAY_URL || "http://127.0.0.1:8787";
const TOKEN = process.env.RELAY_TOKEN || "dev-token";
const IDLE_DM_SECONDS = Number(process.env.IDLE_DM_SECONDS ?? 90);

// One AGENT_ID in the env means "run just this one". Otherwise run the pair.
const roster = process.env.AGENT_ID
  ? [
      {
        id: process.env.AGENT_ID,
        name: process.env.AGENT_NAME || process.env.AGENT_ID,
        avatar: process.env.AVATAR || "🤖",
      },
    ]
  : [
      { id: "alpha", name: "alpha", avatar: "🅰️" },
      { id: "beta", name: "beta", avatar: "🅱️" },
    ];

let lastActivity = Date.now();

/** Mentions in `text` that point at someone other than me. */
function otherMentions(text, me) {
  const tags = [...String(text).matchAll(/@([\w.\-]+)/g)].map((m) => m[1]);
  const others = tags.filter((t) => t.toLowerCase() !== me.name.toLowerCase());
  return [...new Set(others)];
}

async function handleInbound({ thread, message, mentioned, backlog }, me) {
  if (message.sender_id === me.id) return;
  lastActivity = Date.now();

  // DMs: always answer. Groups: only when mentioned.
  if (thread.kind !== "dm" && !mentioned) return;

  const text = String(message.text || "");

  // "approve"/"approval" anywhere in the text -> demo the approval card
  if (/\bapprov(e|al)\b/i.test(text)) {
    me.status(thread.id, "thinking about it…");
    await sleep(700);
    me.askApproval(thread.id, `Should I go ahead with: "${text}"?`, [
      "Approve",
      "Deny",
    ]);
    return;
  }

  me.status(thread.id, "typing…");
  await sleep(1000);

  const targets = otherMentions(text, me);
  const prefix = targets.length ? targets.map((t) => `@${t}`).join(" ") + " " : "";
  const body = text.trim() || (message.attachments?.length ? "(attachment)" : "…");
  const tail = backlog ? " _(from the backlog)_" : "";

  me.say(thread.id, `${prefix}echo: ${body}${tail}`);
}

function handleDecision({ approval_id, decision, thread_id }, me) {
  lastActivity = Date.now();
  me.say(thread_id, `Got it — **${decision}**. Noted.`);
  me.log(`decision on ${approval_id}: ${decision}`);
}

const agents = roster.map(
  (a) =>
    new AgentClient({
      relayUrl: RELAY_URL,
      token: TOKEN,
      id: a.id,
      name: a.name,
      avatar: a.avatar,
      onInbound: handleInbound,
      onDecision: handleDecision,
    })
);

for (const a of agents) a.connect();

// Unprompted DM so the inbox can light up with no user action.
if (IDLE_DM_SECONDS > 0) {
  const speaker = agents[0];
  setInterval(() => {
    if (Date.now() - lastActivity < IDLE_DM_SECONDS * 1000) return;
    const dm = speaker.dmThread();
    if (!dm) return;
    lastActivity = Date.now();
    speaker.say(dm.id, "still here — nothing to report.");
  }, Math.max(5, IDLE_DM_SECONDS) * 1000);
}

const shutdown = () => {
  for (const a of agents) a.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `echo adapter -> ${RELAY_URL} as ${roster.map((r) => "@" + r.name).join(", ")}`
);
