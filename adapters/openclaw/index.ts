// Agent Inbox plugin entrypoint.
//
// STUB. The relay half (src/relay.ts) is complete and tested against the
// relay; the OpenClaw half below is not wired up. See README.md for exactly
// which SDK contracts still have to be filled in, and verify the helper names
// against the OpenClaw docs before relying on them — the channel SDK marks
// several of these surfaces experimental.
//
// Bundled extensions in the OpenClaw repo use defineBundledChannelEntry;
// an out-of-tree plugin package uses defineChannelPluginEntry.
import { defineChannelPluginEntry } from "openclaw/plugin-sdk";

import { agentInboxChannel } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "agentinbox",
  name: "Agent Inbox",
  description: "Agent Inbox channel plugin",
  importMetaUrl: import.meta.url,
  channel: agentInboxChannel,
});
