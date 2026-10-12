# Relay plan — person-to-person messages through a bot, both ways

## Why

A user (call her Ana) chatting with a bot on Telegram said "ask the operator who I am". The bot
called `send_message`, which:

1. failed once because the operator was in the directory twice ("Op" on Telegram, "Op (operator)"
   on web);
2. picked the web entry on retry, whose delivery only appends to a web session (and, because the
   address was an email, to the shared `private:0` bucket). Nobody reads it, nothing notifies;
3. returned `Message sent to Op (operator) via web`, and the bot told Ana it was delivered.

It then promised Ana "you'll be the first to know when he answers", and nothing in the system
can do that. The reverse ("bot, tell Ana X" from the operator) fails earlier: Telegram users are
never tracked in the directory (`UserDirectory.track` is only called from `handleChannelMessage`,
`conversation-pipeline.ts:934`; Telegram goes through `handleConversation`).

Requirement from the operator: things a bot says *will happen* must be backed by mechanism, and
the mechanism must be the same whether the operator or a user is the sender. Operator vs user
differs only in **policy**.

## Design

A **relay** is a durable record of a message one person asked the bot to pass to another, plus
the system-owned obligation to route the answer back.

1. **One people directory.** Every human who talks to a bot is tracked, Telegram included
   (identity = Telegram user id, verified by Telegram). The operator is one contact with
   `metadata.role = "operator"`, seeded from `config.operator` (Telegram chat id + email). Older
   entries pointing at the same addresses are merged into it. Contacts can carry aliases. An
   exact name/alias match wins over partial matches.
2. **Deterministic delivery resolver** (`src/relay/delivery.ts`). Fixed route order for a contact:
   Telegram (own bot instance first, then other fleet instances; a 403 / "chat not found" moves
   on to the next one) → WhatsApp → web. Web counts as `delivered` only when a live connection
   exists; otherwise the text is stored in the session and the result is `queued — not notified`.
   Results are `delivered | queued | failed`, never "sent" when nothing reached a person.
3. **Relay record** (`src/relay/store.ts`, `<data>/relays/<botId>.jsonl`, last line per id wins).
   The sender (`from`) comes from the executor-injected `_requester` (the inbound speaker), never
   from model arguments. The recipient sees a system-stamped header ("📨 De Ana (vía Bot)") and,
   when a reply is expected, a line telling them to reply to that message. Identical
   text to the same recipient within 10 minutes is a duplicate: no second delivery.
4. **Return path owned by the system.**
   - A Telegram *reply* to a relay message is forwarded to the original sender verbatim without
     an LLM call. The answerer gets a deterministic "✅ passed to Ana".
   - Free-text answers: the conversation prompt lists the relays waiting on this person. The bot
     closes one with `send_message(replyTo: <relayId>)`, and the recipient is filled in from the
     record.
   - Delivered relays and answers are also appended to the recipient's / requester's session
     transcript, so the bot in that chat knows what was said on its behalf.
   - The requester's prompt lists their own relays and statuses, so "did he answer?" is answered
     from the record.
5. **Policy** (`src/relay/policy.ts`). Anyone → operator: allowed. Operator → any known contact:
   allowed. Person → person: off unless `bots[].relay.peerToPeer: true`. No requester (agent loop):
   the bot itself is the sender, so no relay header and no return path, but the honest delivery
   statuses still apply.
6. **Fixes found on the way.**
   - In conversation mode, `ask_human` stops sending "needs your input" to a non-operator's chat,
     and stops swallowing that user's next message as the answer.
   - Conversation tool calls are written to the tool audit with their `chatId`.

Config: `bots[].relay { enabled = true, peerToPeer = false, locale = 'es' | 'en' (default 'es') }`.

Borrowed from OpenClaw (`D:\tmp\openclaw-src\openclaw`):
- recipients resolved by the host, not built by the model;
- explicit delivery states plus "do not resend / do not claim delivered" tool text;
- idempotent operations;
- system-stamped provenance.

Not borrowed: OpenClaw's reply waiter lives in memory for 300 s; ours is durable.

## Stages (TDD; each lands with its tests)

| # | Scope | Files |
|---|---|---|
| A | Directory: Telegram tracking, operator seed and merge, aliases, exact-match priority. Relay foundation: types, store, format, policy, delivery. Honest web outbound | `src/bot/user-directory.ts`, `src/bot/conversation-pipeline.ts` (track in `handleConversation`), new `src/relay/*`, `src/channel/outbound.ts` |
| B | `ask_human` conversation-mode fix, conversation tool audit | `src/tools/ask-human.ts`, `src/bot/ask-human-store.ts`, executor and audit wiring |
| C | `send_message` on top of relays (`_requester` injection, `expectsReply`, `replyTo`, policy, dedupe), Telegram reply-to routing in the gate, prompt sections, config schema, end-to-end tests both directions | `src/tools/send-message.ts`, `src/bot/tool-executor.ts`, `src/bot/tool-registry.ts`, `src/bot/conversation-gate.ts`, `src/bot/system-prompt-builder.ts`, `src/config.ts` |
| D | Docs: CHANGELOG, CLAUDE.md table, architecture docs, README | — |

A and B run in parallel (disjoint files); C depends on both.

## Out of scope (follow-ups)

- A generic detector for unbacked promises in reply text ("I'll remind you tomorrow" with no
  tool call behind it).
- Discord outbound.
- A dashboard view of relays.
- Relays between bots of different tenants.
