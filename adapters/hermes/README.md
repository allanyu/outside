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

## What has been verified

Against a copy of a real Hermes v0.20.6 install (git layout), with the real
`gateway` package imported and a stand-in for the AIAgent in place of the model:

- the plugin installs where `Platform._scan_bundled_plugin_platforms()` finds
  it, so `Platform("agentinbox")` resolves
- `register(ctx)` produces a valid `PlatformEntry` — every kwarg it passes is
  an accepted field, and the factory returns a working adapter
- `AgentInboxAdapter` satisfies the abstract contract: `connect`, `disconnect`,
  `send`, `get_chat_info`
- `connect()` registers with the relay and the agent goes online in the app
- an inbound DM flows through the real `BasePlatformAdapter.handle_message`
  (session keying included) to the handler, and the reply goes back out through
  the real `_send_with_retry` into this adapter's `send()`
- in a group it stays quiet unless `@mentioned`; in a DM it always answers

**Not** verified: the real AIAgent behind the handler, `hermes gateway setup`
listing the platform, and anything to do with the desktop app's own gateway
lifecycle.

## Not implemented

Attachments, streaming edits, approval cards, and typing indicators. The relay
supports all four (`stream`/`stream_end`, `ask_approval`, `status`); wiring them
to Hermes' streaming and approval surfaces is the obvious next step.
