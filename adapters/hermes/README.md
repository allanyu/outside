# Hermes Agent adapter

A **platform plugin** for the [Hermes Agent](https://github.com/NousResearch/hermes-agent)
gateway, not a standalone script. Sessions and memory stay in Hermes; the relay
is only the transport. It mirrors the shape of `plugins/platforms/telegram`:
a `plugin.yaml`, an `__init__.py` that exports `register`, and a
`BasePlatformAdapter` subclass.

## Install

Copy the plugin into a Hermes checkout:

```bash
cp -r adapters/hermes/agentinbox /path/to/hermes-agent/plugins/platforms/agentinbox
```

Set the env it needs:

```bash
export AGENTINBOX_RELAY_URL=http://127.0.0.1:8787
export AGENTINBOX_TOKEN=dev-token        # RELAY_TOKEN from relay/.env
export AGENTINBOX_AGENT_ID=hermes        # optional
export AGENTINBOX_AGENT_NAME=hermes      # optional, this is the @handle
export AGENTINBOX_AVATAR=🧠               # optional
```

Then enable the platform and start the gateway:

```bash
hermes gateway setup      # pick "Agent Inbox"
hermes gateway
```

`@hermes` appears in the iOS app's inbox as soon as the gateway connects.

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
