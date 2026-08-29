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

## Deploying it

The relay is one long-lived process: it holds an agent's WebSocket open for
days, keeps its sockets in memory, and writes SQLite and uploaded files to
disk. That rules out serverless — on Vercel, connections close when the
function hits its maximum duration and instances do not share memory. It wants
a container with a volume.

```bash
cd relay
fly launch --no-deploy          # takes fly.toml as it stands
fly volumes create relay_data --size 1
fly secrets set RELAY_TOKEN="$(openssl rand -base64 24)"
fly secrets set PUBLIC_URL="https://<your-app>.fly.dev"
fly deploy
```

Any container host works the same way — Railway, Render, a VPS with the
Dockerfile. Two things matter:

- **A volume at `DATA_DIR`.** Losing it loses every account, thread and image.
- **Never scale to zero.** `auto_stop_machines = false` is deliberate: an idle
  relay still has agents connected to it, and stopping the machine drops them.

`PUBLIC_URL` is the address handed to agents and encoded in invite links. Set
it to the public hostname, not the internal port.

On first boot the relay prints a bootstrap invite instead of the owner token,
so no phone ever has to hold `RELAY_TOKEN` — that is the master credential for
the owner account and belongs only on the server.

## Protocol

Two WebSocket endpoints, both authenticated with `?token=<RELAY_TOKEN>`.

### `/ws/app`

Server → app: `snapshot` (agents, threads, last 100 messages each, approvals),
`message`, `agent_status`, `approval`, plus `thread` when one is created,
`status` for an agent's ephemeral "working on it" line, and `stream` /
`stream_end` while an agent streams.

App → server: `send {thread_id, text, attachments?, mentions?}`,
`create_thread {kind, name?, participant_ids}`, `decide {approval_id, decision}`,
`mint_agent {name, avatar_emoji}` (answered with `agent_minted`), and
`delete_agent {agent_id}` (broadcast as `agent_removed`).

### `/ws/agent`

Agent → server: `register {agent_id, name, avatar_emoji}` (idempotent, marks
online), `send {thread_id, text, reply_to?, mentions?}`,
`stream {thread_id, message_id, delta}` then `stream_end {message_id}`,
`ask_approval {thread_id, prompt, options}`, `status {thread_id, text}`.

Server → agent: `registered {agent, threads}`, `inbound {thread, message, mentioned}`,
`decision {approval_id, decision, thread_id}`.

### Hosted agents

An agent can be created **under** an already-connected one
(`mint_agent {name, host_agent_id}`). It gets no token: its traffic rides the
host's socket, tagged with `agent_id` on `inbound`, and the host answers as it
by putting `agent_id` on `send`. The host is told about it immediately with
`host_agent_added`, and picks up the full list from `registered.hosted` on
reconnect. Hosted agents go online and offline with their host.

This is what makes adding an agent a purely in-app action: nothing has to be
installed or restarted wherever the host runs.

### Two kinds of token

`RELAY_TOKEN` is the shared one: it authenticates the app, the REST API, and
any agent that names itself on `register` (the echo adapter does this).

A **connect token** is minted per agent, from the app or `POST /api/agents/mint`.
It looks like `aic_wy68xbb8dkynux`, authenticates only `/ws/agent`, and *is* the
agent's identity — a client holding one sends a bare `{"type":"register"}` and
the relay fills in the id, name and emoji it already has. Removing the agent
revokes it.

### REST

`Authorization: Bearer <token>` or `?token=`.

```
GET    /api/agents
POST   /api/agents/mint          {name, avatar_emoji}  -> agent + connect_token
DELETE /api/agents/:id           revokes its token, deletes threads it leaves empty
POST   /api/agents/register      {agent_id, name, avatar_emoji}
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

Minted names are made unique (`hermes`, then `hermes-2`). The name doubles as
the `@handle` that rule 1 matches on, so two agents cannot share one.

## CLI

A `/ws/app` client for testing without the app:

```bash
cd relay && npm run cli
```

`/threads`, `/use <n>`, `/group <name> <agentId...>`, `/decide <option>`,
`/agents`, `/quit`. Anything else is sent to the selected thread.
