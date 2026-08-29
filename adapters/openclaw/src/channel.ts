// STUB — the OpenClaw-facing half of the plugin.
//
// Everything the relay needs is already implemented in ./relay.ts. What is
// missing is the binding to OpenClaw's channel SDK, which is a moving target:
// the channel docs mark the ingress and message-adapter surfaces experimental
// and require contract tests that prove declared capabilities. Rather than
// guess those signatures, this file lists exactly what to implement and where
// the current contract is documented.
//
//   docs/plugins/sdk-channel-plugins.md   overall channel plugin guide
//   docs/plugins/sdk-channel-outbound.md  defineChannelMessageAdapter, receipts
//   docs/plugins/sdk-channel-inbound.md   inbound dispatch
//   docs/plugins/sdk-channel-ingress.md   authorization / ingress resolver
//   docs/plugins/sdk-entrypoints.md       defineChannelPluginEntry
//   extensions/irc/                       smallest bundled channel to copy
//
// TODO, in order:
//   1. Config + accounts: read relayUrl/agentId/agentName/avatar from the
//      plugin config schema in ../openclaw.plugin.json, falling back to
//      AGENTINBOX_RELAY_URL / AGENTINBOX_TOKEN.
//   2. Session grammar: map a relay thread id to a base chat id.
//      thread.kind === "dm" is a DM; "group" is a room. There are no
//      sub-threads, so no `:thread:` bookkeeping is needed.
//   3. Inbound: start RelayConnection, and on each inbound event drop the
//      agent's own messages, accept every DM, and accept a group message only
//      when `mentioned` is true. Hand the rest to OpenClaw's inbound dispatch.
//   4. Outbound: build the `message` adapter with defineChannelMessageAdapter
//      from "openclaw/plugin-sdk/channel-outbound", declaring only text sends
//      (the relay has no edit, react, or poll), and send via connection.say().
//      Return a MessageReceipt; the relay assigns message ids, so either echo
//      the relay's id back or declare the send as receipt-less.
//   5. Security: the relay is single-user behind one shared token, so DM
//      policy and pairing can be no-ops. Say so explicitly rather than
//      inheriting a default that assumes a public platform.
//
// Optional once the above works: map OpenClaw approval prompts onto
// connection.askApproval() so they render as cards in the iOS app, and map
// typing indicators onto connection.status().

import { RelayConnection } from "./relay.js";

export const agentInboxChannel = {
  id: "agentinbox",
  label: "Agent Inbox",

  // Replace with the real SDK shape once steps 1-5 above are done.
  async start(): Promise<never> {
    throw new Error(
      "Agent Inbox OpenClaw channel is a stub. See adapters/openclaw/README.md."
    );
  },
} as const;

export { RelayConnection };
