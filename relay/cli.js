// Tiny /ws/app client, for testing the relay without the iOS app.
//   node cli.js [relayUrl] [token]
import readline from "node:readline";
import WebSocket from "ws";
import { loadEnv } from "./env.js";

loadEnv();

const RELAY_URL = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 8787}`;
const TOKEN = process.argv[3] || process.env.RELAY_TOKEN || "dev-token";

const u = new URL(RELAY_URL);
u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
u.pathname = "/ws/app";
u.searchParams.set("token", TOKEN);

const ws = new WebSocket(u.toString());
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let agents = [];
let threads = [];
let approvals = [];
let current = null;

const nameOf = (id) =>
  id === "user" ? "me" : agents.find((a) => a.id === id)?.name ?? id;

function label(t) {
  if (t.kind === "dm") {
    const other = t.participant_ids.find((p) => p !== "user");
    return `DM ${nameOf(other)}`;
  }
  return `# ${t.name || "group"} (${t.participant_ids.filter((p) => p !== "user").map(nameOf).join(", ")})`;
}

function listThreads() {
  threads.forEach((t, i) => {
    const mark = current === t.id ? "*" : " ";
    console.log(` ${mark} ${i}  ${label(t)}`);
  });
}

function printMessage(m) {
  if (m.thread_id !== current) {
    const t = threads.find((x) => x.id === m.thread_id);
    console.log(`  (${t ? label(t) : m.thread_id})`);
  }
  const tag = m.kind === "approval" ? "[approval] " : "";
  console.log(`  ${nameOf(m.sender_id)}: ${tag}${m.text}`);
}

ws.on("open", () => console.log(`connected to ${RELAY_URL}`));

ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  switch (msg.type) {
    case "snapshot":
      agents = msg.agents;
      threads = msg.threads;
      approvals = msg.approvals ?? [];
      current = current ?? threads[0]?.id ?? null;
      console.log(`\nagents: ${agents.map((a) => `${a.avatar_emoji}@${a.name}(${a.status})`).join(" ")}`);
      listThreads();
      console.log(
        "\ncommands: /threads  /use <n>  /group <name> <agentId...>  /decide <option>  /agents  /quit\n"
      );
      break;
    case "message":
      threads = threads.map((t) =>
        t.id === msg.message.thread_id
          ? { ...t, messages: [...(t.messages ?? []), msg.message] }
          : t
      );
      printMessage(msg.message);
      break;
    case "status":
      console.log(`  ${nameOf(msg.agent_id)} … ${msg.text}`);
      break;
    case "stream":
      process.stdout.write(msg.delta);
      break;
    case "stream_end":
      console.log("");
      break;
    case "agent_status":
      agents = [...agents.filter((a) => a.id !== msg.agent.id), msg.agent];
      console.log(`  * @${msg.agent.name} is ${msg.agent.status}`);
      break;
    case "thread":
      threads = [...threads.filter((t) => t.id !== msg.thread.id), msg.thread];
      console.log(`  * new thread: ${label(msg.thread)}`);
      break;
    case "approval":
      approvals = [...approvals.filter((a) => a.id !== msg.approval.id), msg.approval];
      if (msg.approval.decision) {
        console.log(`  * approval decided: ${msg.approval.decision}`);
      } else {
        console.log(
          `  ? ${nameOf(msg.approval.agent_id)} asks: ${msg.approval.prompt}` +
            `\n    options: ${msg.approval.options.join(" | ")}   (/decide <option>)`
        );
      }
      break;
    case "error":
      console.log(`  ! ${msg.error}`);
      break;
  }
});

ws.on("close", () => {
  console.log("disconnected");
  process.exit(0);
});

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  const [cmd, ...rest] = text.split(/\s+/);

  if (cmd === "/quit") return ws.close();
  if (cmd === "/agents")
    return console.log(agents.map((a) => `${a.id} @${a.name} ${a.status}`).join("\n"));
  if (cmd === "/threads") return listThreads();
  if (cmd === "/use") {
    current = threads[Number(rest[0])]?.id ?? current;
    return console.log(`using ${label(threads.find((t) => t.id === current))}`);
  }
  if (cmd === "/group") {
    const [name, ...ids] = rest;
    return ws.send(
      JSON.stringify({
        type: "create_thread",
        kind: "group",
        name,
        participant_ids: ids,
      })
    );
  }
  if (cmd === "/decide") {
    const pending = approvals.filter((a) => !a.decision).at(-1);
    if (!pending) return console.log("  no pending approval");
    return ws.send(
      JSON.stringify({
        type: "decide",
        approval_id: pending.id,
        decision: rest.join(" ") || pending.options[0],
      })
    );
  }
  if (!current) return console.log("  no thread selected (/threads, /use <n>)");
  ws.send(JSON.stringify({ type: "send", thread_id: current, text }));
});
