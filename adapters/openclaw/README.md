# OpenClaw adapter — stub

**This does not run yet.** The relay half is finished; the OpenClaw half is not.

`src/relay.ts` is a complete, working client for the relay's `/ws/agent`
protocol — the same wire format the echo adapter uses. `src/channel.ts` is a
stub that lists, step by step, what still has to be bound to OpenClaw's channel
SDK.

## Why it is a stub

The spec says not to guess these APIs. OpenClaw's channel plugin surface is
large and explicitly in motion: `docs/plugins/sdk-channel-plugins.md` marks the
inbound ingress resolver and parts of the message adapter as experimental, and
requires contract tests that prove every declared capability. Writing that
against a snapshot of the docs would produce something that looks finished and
silently drifts. The demo does not need it — everything in the acceptance
checklist runs on the echo adapter alone.

## Package layout

Matches a bundled channel extension (`extensions/irc` is the smallest one to
copy from):

```
openclaw.plugin.json   plugin id, channels, config schema
package.json           the "openclaw" field: extensions, channel metadata
index.ts               defineChannelPluginEntry
src/relay.ts           the Agent Inbox protocol client  (done)
src/channel.ts         the OpenClaw channel binding     (stub, has a TODO list)
```

## To finish it

Read these first, in the OpenClaw repo, and take the signatures from there
rather than from this README:

- `docs/plugins/sdk-channel-plugins.md`
- `docs/plugins/sdk-channel-outbound.md`
- `docs/plugins/sdk-channel-inbound.md`
- `docs/plugins/sdk-channel-ingress.md`
- `docs/plugins/sdk-entrypoints.md`
- `extensions/irc/`

Then work through the numbered TODO list at the top of `src/channel.ts`.

The mapping is simple once the SDK shape is settled: a relay thread is a chat
(`kind: "dm"` → DM, `"group"` → room), there are no sub-threads, and the relay
already tells you on every inbound message whether the agent was `mentioned`.
Because the relay is single-user behind one shared token, DM policy and pairing
can be explicit no-ops.
