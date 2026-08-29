# relay

Node 20+. Three dependencies: `ws`, `express`, `better-sqlite3`. Binds
`0.0.0.0` so a phone on the same Wi-Fi (or Tailscale) can reach it.

```bash
cd relay && npm install && npm start
```

It prints the LAN URL, the token, and an `agentinbox://connect?...` line the
iOS app can open to skip typing both.

Config is `relay/.env` (see `.env.example`): `PORT`, `RELAY_TOKEN`,
`LOOP_GUARD`, `DATA_DIR`. The SQLite file and uploaded images live in
`DATA_DIR` (`./data` by default) — delete that folder to start clean.

## Protocol

Two WebSocket endpoints, both authenticated with `?token=<RELAY_TOKEN>`.

### `/ws/app`

Server → app: `snapshot` (agents, threads, last 100 messages each, approvals),
`message`, `agent_status`, `approval`, plus `thread` when one is created,
`status` for an agent's ephemeral "working on it" line, and `stream` /
`stream_end` while an agent streams.

App → server: `send {thread_id, text, attachments?, mentions?}`,
`create_thread {kind, name?, participant_ids}`, `decide {approval_id, decision}`.

### `/ws/agent`

Agent → server: `register {agent_id, name, avatar_emoji}` (idempotent, marks
online), `send {thread_id, text, reply_to?, mentions?}`,
`stream {thread_id, message_id, delta}` then `stream_end {message_id}`,
`ask_approval {thread_id, prompt, options}`, `status {thread_id, text}`.

Server → agent: `registered {agent, threads}`, `inbound {thread, message, mentioned}`,
`decision {approval_id, decision, thread_id}`.

### REST

`Authorization: Bearer <token>` or `?token=`.

```
GET  /api/agents
POST /api/agents/register        {agent_id, name, avatar_emoji}
GET  /api/threads
POST /api/threads                {kind, name?, participant_ids}
GET  /api/threads/:id/messages?since=<ms>
POST /api/threads/:id/messages   {text, attachments?, mentions?, reply_to?}
POST /api/files?mime=image/jpeg  (raw bytes) -> {id, url, mime, size}
GET  /files/:id
GET  /health
```

## Routing rules — the only logic here

1. Every message in a thread goes to every agent in that thread, with
   `mentioned=true` when their `@name` appears.
2. **Loop guard.** After `LOOP_GUARD` (default 6) consecutive agent messages
   with no user message in between, agent messages stop being delivered to
   other agents. They still reach the app. Any user message resets it.
3. Agents decide for themselves whether to reply. The relay never suppresses
   or prompts.
4. Offline agents: messages are stored, and on `register` the agent receives
   everything in its threads since its `last_seen`.

Registering an agent also creates its DM thread with the user if there isn't
one, which is why `@alpha` and `@beta` show up in the inbox on first run.

## CLI

A `/ws/app` client for testing without the app:

```bash
cd relay && npm run cli
```

`/threads`, `/use <n>`, `/group <name> <agentId...>`, `/decide <option>`,
`/agents`, `/quit`. Anything else is sent to the selected thread.
