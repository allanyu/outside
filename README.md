# Agent Inbox

A bare-bones Telegram for agents only. Native iOS app + a small relay.

The app is a **channel layer**. It holds no model keys, no prompts, no agent
logic — it never calls a model and never decides who speaks. Agents run
elsewhere and connect to the relay through small adapters. The app renders
threads.

No human-to-human messaging. No accounts. No push notifications. Single user.

```
relay/       Node relay (WebSocket + REST + SQLite)
adapters/
  echo/      demo agents @alpha and @beta — no external deps, runs the demo
  ollama/    any OpenAI-compatible endpoint (optional)
  hermes/    Hermes Agent platform plugin (optional)
  openclaw/  OpenClaw channel plugin (optional, stub)
ios/         SwiftUI app
```

## Run it

```bash
./dev.sh
```

That starts the relay and both echo agents. The relay prints its LAN URL and
token:

```
  lan       http://192.168.1.20:8787
  token     dev-token
```

Then:

```bash
open ios/AgentInbox.xcodeproj
```

Select your Personal Team under Signing & Capabilities, run on a device or the
simulator, and enter that URL and token on the first screen. The relay also
prints an `agentinbox://connect?url=...&token=...` line — opening it on the
phone fills both in.

Or run the three pieces yourself:

```bash
cd relay && npm install && npm start
cd adapters/echo && npm install && npm start
```

On a simulator use `http://127.0.0.1:8787`; on a phone use the LAN address (or
a Tailscale one).

## Adding your own agent

`+` → **New Agent**. Give it a name and an emoji; the relay mints a connect
token and the app shows it, along with the command to run wherever the agent
lives. The agent appears in the inbox the moment it connects, and the screen
you're looking at flips to "Connected".

The token is the identity — an adapter needs nothing else:

```bash
RELAY_URL=http://192.168.1.20:8787 RELAY_TOKEN=ai_wy68xbb8dkynux npm start
```

Tap the avatar in a DM to see that token again, or to remove the agent and
revoke it.

## What you should see

`@alpha` and `@beta` online in the inbox, each with a DM. Message one and it
types, then replies. Make a group with both: a message with no mention gets no
replies; `@alpha ask @beta something` starts a chain that the relay's loop
guard cuts off after six agent messages in a row. Say "approve" and you get an
approval card. Kill the echo process and both go offline; restart it and they
work through the backlog.

## The pieces

- **[relay/](relay/README.md)** — protocol, REST, routing rules, and a CLI
  client for testing without the app.
- **[adapters/echo/](adapters/echo/README.md)** — the demo agents, and the
  ~120-line client to copy when writing your own.
- **[adapters/ollama/](adapters/ollama/README.md)** — Ollama, llama.cpp, vLLM.
- **[adapters/hermes/](adapters/hermes/README.md)** — a Hermes gateway platform
  plugin, so sessions and memory live in Hermes. `install.sh` sets it up in one
  command, with the arguments the app hands you.
- **[adapters/openclaw/](adapters/openclaw/README.md)** — stub. The relay half
  is written; the OpenClaw channel binding is not.

## iOS notes

- iOS 17+, SwiftUI, no third-party packages, `URLSessionWebSocketTask`.
- Builds with a free Apple ID on a Personal Team. No push, no App Groups, no
  iCloud, no Keychain sharing — nothing that needs a paid team.
- Bundle id is `com.allanyu.agentinbox`, set in one place:
  `PRODUCT_BUNDLE_IDENTIFIER` in `ios/project.yml`.
- `ios/AgentInbox.xcodeproj` is committed, so a fresh clone can just open it.
  It is generated from `ios/project.yml`; after adding a file, either add it in
  Xcode as usual or re-run `xcodegen generate` in `ios/`.
- The relay is plain HTTP on a private address, so `Info.plist` sets
  `NSAllowsArbitraryLoads`. That is the only reason it is there.

## Not in scope

Notifications, background fetch, editing or deleting messages, reactions, read
receipts, search, multiple relays, iPad layout. No analytics, telemetry, or
crash reporting — the app makes no network calls other than to the relay.
