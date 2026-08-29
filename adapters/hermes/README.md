# Hermes Agent adapter

A **platform plugin** for the [Hermes Agent](https://github.com/NousResearch/hermes-agent)
gateway, not a standalone script. Sessions and memory stay in Hermes; the relay
is only the transport. It mirrors the shape of `plugins/platforms/telegram`:
a `plugin.yaml`, an `__init__.py` that exports `register`, and a
`BasePlatformAdapter` subclass.

## Install

In the app: `+` → **New Agent**, name it, and it hands you this line with the
arguments already filled in. Run it on the machine where Hermes lives:

```bash
./install.sh <hermes-checkout> <relay-url> <connect-token>
```

It copies the plugin into `plugins/platforms/agentinbox`, checks the relay is
reachable from that machine, and writes `AGENTINBOX_RELAY_URL` and
`AGENTINBOX_TOKEN` into the checkout's `.env`. Re-running it updates both
rather than appending duplicates.

Then:

```bash
hermes gateway
```

The agent appears in the inbox as soon as the gateway connects, and the app's
connect screen flips to "Connected".

### By hand

```bash
cp -r adapters/hermes/agentinbox /path/to/hermes-agent/plugins/platforms/agentinbox
export AGENTINBOX_RELAY_URL=http://192.168.1.20:8787
export AGENTINBOX_TOKEN=ai_wy68xbb8dkynux   # or the shared RELAY_TOKEN
hermes gateway setup                        # pick "Agent Inbox"
hermes gateway
```

With a connect token the name and emoji come from the app. With the shared
`RELAY_TOKEN` instead, set `AGENTINBOX_AGENT_ID`, `AGENTINBOX_AGENT_NAME` (the
`@handle`) and `AGENTINBOX_AVATAR` yourself.

## How it maps

| Agent Inbox            | Hermes                                        |
| ---------------------- | --------------------------------------------- |
| thread id              | `SessionSource.chat_id`                       |
| `thread.kind`          | `chat_type` — `"dm"` or `"group"`             |
| message sender id      | `user_id` / `user_name`                       |
| `mentioned` (groups)   | gate: group messages are dropped unless true  |
| DMs                    | always dispatched                             |

Reconnects need no special handling: the relay replays everything since the
agent's `last_seen` on `register`, so a gateway restart picks up the backlog.

## Interfaces this depends on

Checked against `NousResearch/hermes-agent` before writing. If the gateway
changes, these are the things to re-check:

- `gateway.platforms.base.BasePlatformAdapter` — abstract `connect(*, is_reconnect=False) -> bool`,
  `disconnect() -> None`, `send(chat_id, content, reply_to=None, metadata=None) -> SendResult`
- `BasePlatformAdapter.handle_message(event)` — how an adapter dispatches inbound
- `gateway.platforms.base.MessageEvent`, `MessageType`, `SendResult`
- `gateway.session.SessionSource`
- `gateway.config.Platform`, `PlatformConfig` — `Platform("agentinbox")` works
  through the enum's `_missing_()` hook, no core edit needed
- `register(ctx)` calling `ctx.register_platform(...)`

## Not implemented

Attachments, streaming edits, approval cards, and typing indicators. The relay
supports all four (`stream`/`stream_end`, `ask_approval`, `status`); wiring them
to Hermes' streaming and approval surfaces is the obvious next step.
