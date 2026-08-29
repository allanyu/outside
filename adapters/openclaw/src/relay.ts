// The Agent Inbox side of the plugin. This part is complete: it speaks the
// relay's /ws/agent protocol and is the same wire format the echo adapter uses.
import { WebSocket } from "ws";

export type RelayThread = {
  id: string;
  kind: "dm" | "group";
  name: string | null;
  participant_ids: string[];
};

export type RelayMessage = {
  id: string;
  thread_id: string;
  sender_id: string;
  text: string;
  attachments: { id: string; url: string; mime: string }[];
  mentions: string[];
  reply_to: string | null;
  kind: "text" | "approval" | "status";
  created_at: number;
};

export type Inbound = {
  thread: RelayThread;
  message: RelayMessage;
  mentioned: boolean;
  backlog?: boolean;
};

export type RelayOptions = {
  relayUrl: string;
  token: string;
  agentId: string;
  agentName: string;
  avatar: string;
  onInbound: (inbound: Inbound) => void | Promise<void>;
  onDecision?: (d: { approval_id: string; decision: string; thread_id: string }) => void;
  onThreads?: (threads: RelayThread[]) => void;
};

export class RelayConnection {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = 500;

  constructor(private readonly options: RelayOptions) {}

  get socketUrl(): string {
    const url = new URL(this.options.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/agent";
    url.searchParams.set("token", this.options.token);
    return url.toString();
  }

  connect(): void {
    const ws = new WebSocket(this.socketUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = 500;
      this.send({
        type: "register",
        agent_id: this.options.agentId,
        name: this.options.agentName,
        avatar_emoji: this.options.avatar,
      });
    });

    ws.on("message", (raw) => {
      let event: any;
      try {
        event = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (event.type === "registered") this.options.onThreads?.(event.threads ?? []);
      else if (event.type === "inbound") void this.options.onInbound(event as Inbound);
      else if (event.type === "decision") this.options.onDecision?.(event);
    });

    ws.on("close", () => this.retry());
  }

  private retry(): void {
    if (this.closed) return;
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10_000);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  say(threadId: string, text: string, replyTo?: string): void {
    this.send({ type: "send", thread_id: threadId, text, reply_to: replyTo ?? null });
  }

  status(threadId: string, text: string): void {
    this.send({ type: "status", thread_id: threadId, text });
  }

  askApproval(threadId: string, prompt: string, options: string[]): void {
    this.send({ type: "ask_approval", thread_id: threadId, prompt, options });
  }
}
