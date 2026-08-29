import WebSocket from "ws";

/**
 * Minimal /ws/agent client. Connects, registers, reconnects with backoff.
 * Copy this file into a new adapter and write the behaviour in a handler.
 */
export class AgentClient {
  constructor({ relayUrl, token, id, name, avatar, onInbound, onDecision, onReady }) {
    this.relayUrl = relayUrl.replace(/\/$/, "");
    this.token = token;
    this.id = id;
    this.name = name;
    this.avatar = avatar;
    this.onInbound = onInbound ?? (() => {});
    this.onDecision = onDecision ?? (() => {});
    this.onReady = onReady ?? (() => {});
    this.threads = [];
    this.backoff = 500;
    this.closed = false;
  }

  get wsUrl() {
    const u = new URL(this.relayUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws/agent";
    u.searchParams.set("token", this.token);
    return u.toString();
  }

  connect() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on("open", () => {
      this.backoff = 500;
      this.send({
        type: "register",
        agent_id: this.id,
        name: this.name,
        avatar_emoji: this.avatar,
      });
    });

    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "registered") {
        this.threads = msg.threads ?? [];
        this.log(`online, ${this.threads.length} thread(s)`);
        this.onReady(this);
      } else if (msg.type === "thread") {
        this.threads = [
          ...this.threads.filter((t) => t.id !== msg.thread.id),
          msg.thread,
        ];
      } else if (msg.type === "inbound") {
        this.onInbound(msg, this);
      } else if (msg.type === "decision") {
        this.onDecision(msg, this);
      } else if (msg.type === "error") {
        this.log(`relay error: ${msg.error}`);
      }
    });

    this.ws.on("close", () => this.retry());
    this.ws.on("error", (err) => this.log(`socket: ${err.message}`));
  }

  retry() {
    if (this.closed) return;
    this.log(`disconnected, retrying in ${this.backoff}ms`);
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10_000);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  say(threadId, text, extra = {}) {
    this.send({ type: "send", thread_id: threadId, text, ...extra });
  }

  status(threadId, text) {
    this.send({ type: "status", thread_id: threadId, text });
  }

  askApproval(threadId, prompt, options) {
    this.send({ type: "ask_approval", thread_id: threadId, prompt, options });
  }

  dmThread() {
    return this.threads.find((t) => t.kind === "dm") ?? null;
  }

  log(...a) {
    console.log(`[${this.name}]`, ...a);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
