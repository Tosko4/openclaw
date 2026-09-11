---
summary: "Retired ambient settings and durable context for addressed group turns"
read_when:
  - Upgrading an always-on Discord, Slack, or Telegram room
  - You want the bot to remember discussion without interrupting it
  - Checking what legacy unmentionedInbound settings do
title: "Ambient room events"
sidebarTitle: "Ambient room events"
---

Discord, Slack, and Telegram retain permitted room discussion without starting a model turn. A native bot mention, reply to the bot, or explicit bot-owned interaction starts a request with the unread context. Ordinary chatter does not invoke or steer the agent.

The old `messages.groupChat.unmentionedInbound` setting and its agent override remain valid configuration, but these plugins ignore them. `requireMention: false`, mention patterns, and always-on activation no longer enable ambient turns on these channels. Other channels keep their own existing addressing and history behavior.

## Recommended setup

Keep the room and sender permissions appropriate for your group. No observation setting is needed. Use native addressing when you want a reply; keep `messages.groupChat.visibleReplies: "automatic"` if the agent's final answer should be posted normally.

## Prerequisites

OpenClaw must receive the messages and have permission to retain their context. A bot cannot observe a room the platform does not deliver to it.

For Slack, the app needs the message-event subscriptions and history scopes for the room type. See [Slack setup](/channels/slack/setup). Group DM membership remains a Slack platform requirement.

## What changes

- Permitted unmentioned messages are saved as unread context without a model request.
- Native addressing captures unread context through that request. Later messages remain unread.
- Buffered requests remain separate from other users' requests, including their continuation fragments and album attachments.
- The existing queue and steering settings handle addressed requests while a turn is active.
- Conversational commands and bot-owned interactions receive the same unread context. Status and configuration commands do not consume it.
- Context is marked consumed when the turn's input enters the transcript.
- Unread context survives a Gateway restart.
- Direct messages keep their existing behavior.

<a id="discord-example" />
<a id="telegram-example" />

See [Discord history](/channels/discord/threads-and-sessions#session-and-thread-behavior), [Slack threads](/channels/slack/threads-and-sessions), and [Telegram access control](/channels/telegram/access-control).

## Slack example

Slack room allowlists use channel IDs or workspace-qualified channel targets. Mention the bot with `<@botId>`, or reply in a thread rooted at the bot's own message. Posting in a thread where the bot previously participated does not by itself address the bot.

A native reset such as `/openclaw /new` clears prior unread context for its target conversation. It preserves later arrivals and other rooms or threads.

## Agent specific policy

The agent-specific `agents.entries.*.groupChat.unmentionedInbound` override is also ignored by Discord, Slack, and Telegram. Agent routing and room permissions still determine which agent can receive a conversation's context.

## Visible reply modes

`messages.groupChat.visibleReplies` still controls delivery for addressed requests. The default `"automatic"` posts the final answer. `"message_tool"` requires the agent to call the message tool for model-authored visible output; explicit command and plugin-owned replies keep their normal delivery contracts.

Changing visible reply mode does not enable ambient turns.

## History

The shared per-agent `conversation_history` table owns unread messages and their assignment to turns. It is created on first use without a schema-version bump. Existing session transcripts remain in place.

Observation text, quotes, and attachment metadata use the same persistence redaction policy as transcripts. Request reservations and reset receipts use this existing table.

Group `historyLimit` settings do not clip or disable this context on Discord, Slack, or Telegram. Slack's initial room-thread history window is also replaced by durable observation. No historical backfill is performed when this feature is first enabled by an upgrade.

Saved attachments follow the existing media lifetime. Context contains file references; unavailable or expired files produce a notice. The agent can inspect an available file when needed.

Reset uses message arrival order, so a download that finishes after `/new` cannot restore earlier discussion. Cleared passive messages retain small receipts so replayed platform events stay cleared. An authorized reset can also retire an inactive request whose delivery became uncertain after a crash. Its evidence remains for inspection, and the request is not replayed. A request that is still active must finish or be canceled before resetting its history.

Consumed originals remain while their session has a live transcript or retained archive. Keeping their full bodies for this period is a storage tradeoff; it is not needed merely to recognize duplicate message IDs. See [Observed group history](/reference/database-schemas/layout#observed-group-history).

## Troubleshooting

1. Check room membership, event delivery, room allowlists, and sender permissions when discussion is missing.
2. Use a native bot mention or reply when a room message gets no response.
3. Read the retirement warning if an old always-on configuration now waits for native addressing. Removing the ignored settings is optional.
4. If the unread context exceeds a runtime limit, follow the visible recovery notice and use the channel's reset command to start fresh.
5. If an addressed turn finishes without a visible reply, check `visibleReplies` and whether the selected tool policy permits message delivery.

## Related

- [Groups](/channels/groups)
- [Discord](/channels/discord)
- [Slack](/channels/slack)
- [Telegram](/channels/telegram)
- [Channel troubleshooting](/channels/troubleshooting)
- [Channel configuration reference](/gateway/config-channels)
