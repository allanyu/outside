# claude-code adapter

Runs Claude Code as one bot in Agent Inbox. One chat, one Claude Code session:
the thread stays continuous instead of starting over at every message.

```bash
cd adapters/claude-code
npm install
cp .env.example .env      # put your connect token in it
npm start
```

Leave it running. It reconnects on its own.

## Getting a token

Chats mirror Hermes profiles, so there is no button in the app for a bot that
is not a Hermes profile. Mint one against the relay instead:

```bash
curl -s -X POST https://outside.up.railway.app/api/agents/mint \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"claude","avatar_emoji":"🤖"}'
```

`ACCOUNT_TOKEN` is in the app under **Settings → Connection → Advanced**. The
`connect_token` that comes back is the adapter's `RELAY_TOKEN`, and it already
names the agent — `AGENT_ID` is only needed with the shared relay token.

## Env

| Variable          | Default                       |
| ----------------- | ----------------------------- |
| `RELAY_URL`       | `http://127.0.0.1:8787`       |
| `RELAY_TOKEN`     | `dev-token`                   |
| `WORKDIR`         | `.` — where Claude Code runs  |
| `PERMISSION_MODE` | unset — Claude Code's default |
| `TIMEOUT`         | `300` seconds per turn        |
| `CLAUDE_BIN`      | `claude`                      |

`WORKDIR` is the whole context: Claude Code's `CLAUDE.md`, its tools and its
file access are all relative to it. Point it at the repo you want to talk
about.

`PERMISSION_MODE` is deliberately unset. Non-interactive Claude Code cannot
ask, so anything needing permission is simply not done. Set `acceptEdits` or
`bypassPermissions` only if you want it changing files on your machine while
you are on a phone somewhere else.

## How it behaves

It answers every message in a DM, and only `@mentions` in a group — the same
rule as the echo and ollama adapters.

Turns are serialized per thread. Two messages arriving together would
otherwise resume the same session concurrently, with the second running
against a session the first has not finished writing.

Session ids live in `sessions.json` next to the adapter, so restarting it
keeps the context the person on the other end still thinks is there. A resume
that fails — session pruned, or moved to another machine — drops the id and
the next message starts fresh rather than stranding the chat.

## If it never answers

Run `claude -p "hi"` in `WORKDIR` yourself. The adapter reports whatever the
CLI reports, so an expired login shows up in the chat as
`Failed to authenticate: OAuth session expired`, not as silence.
