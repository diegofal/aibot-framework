import type { ContactEntry, UserDirectory } from '../bot/user-directory';
import type { ChannelKind } from '../channel/types';
/**
 * send_message tool — person-to-person relays (docs/plans/relay-plan.md).
 *
 * The recipient comes from the contact directory (or, with `replyTo`, from
 * the relay being answered); the sender is the executor-injected `_requester`,
 * never a model argument. Delivery goes through `RelayService`, and the result
 * text says exactly what happened: delivered, queued (stored, nobody
 * notified) or failed.
 */
import type { Logger } from '../logger';
import { type RelayParty, type RelayService, canRelay } from '../relay';
import type { RelayRecord } from '../relay/types';
import type { Tool, ToolResult } from './types';

export interface SendMessageDeps {
  userDirectory: UserDirectory;
  relays: RelayService;
}

function formatContact(e: ContactEntry): string {
  const channels = e.channels.map((c) => `${c.kind}:${c.address}`).join(', ');
  return `• ${e.displayName} (id: ${e.id}, channels: ${channels})`;
}

/** Whether `party` is the person `relay` was addressed to. */
function isRecipientOf(
  relay: RelayRecord,
  party: RelayParty,
  sameContact: (a: string, b: string) => boolean
): boolean {
  if (relay.to.contactId && party.contactId && sameContact(relay.to.contactId, party.contactId)) {
    return true;
  }
  return relay.to.channelKind === party.channelKind && relay.to.address === party.address;
}

export function createSendMessageTool(deps: SendMessageDeps): Tool {
  const { userDirectory, relays } = deps;
  return {
    definition: {
      type: 'function',
      function: {
        name: 'send_message',
        description:
          'Pass a message to another person (the operator or a contact). Use it whenever someone asks you to tell, ask or pass something to another person. ' +
          'The person you are talking with is attributed as the sender automatically. Set expectsReply when they want an answer back: ' +
          'a reply to the delivered message is routed back to them by the system. When the person you are talking with answers a message that was passed to them, call send_message with replyTo=<relay id> (recipient not needed). ' +
          'Never tell anyone a message was delivered unless the result starts with "Delivered". ' +
          'Contacts are searched by name, @username, contact ID or "operator". If the contact is not found and you have their details, pass "register" to add them.',
        parameters: {
          type: 'object',
          properties: {
            recipient: {
              type: 'string',
              description:
                'Name, @username, contact ID or "operator". Optional when replyTo is given.',
            },
            message: {
              type: 'string',
              description:
                'The message text, worded as the requester wants it passed (max 4000 chars)',
            },
            expectsReply: {
              type: 'boolean',
              description: 'The requester wants the answer back.',
            },
            replyTo: {
              type: 'string',
              description:
                'Relay id (r-xxxxxxxx) this message answers; the answer goes to whoever asked.',
            },
            channel: {
              type: 'string',
              enum: ['telegram', 'whatsapp', 'web', 'auto'],
              description:
                'Restrict delivery to one channel. "auto" (default) tries Telegram, WhatsApp, then web.',
            },
            register: {
              type: 'object',
              description:
                'Register a new contact if not found. Provide displayName, channelKind, and address.',
              properties: {
                displayName: { type: 'string', description: 'Contact display name' },
                channelKind: {
                  type: 'string',
                  enum: ['telegram', 'whatsapp', 'web'],
                  description: 'Channel type',
                },
                address: {
                  type: 'string',
                  description: 'Channel address: Telegram chatId, WhatsApp phone, etc.',
                },
                username: { type: 'string', description: '@username (optional)' },
              },
              required: ['displayName', 'channelKind', 'address'],
            },
          },
          required: ['message'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const recipient = String(args.recipient ?? '').trim();
      const message = String(args.message ?? '').trim();
      const channelPref = (args.channel as string) || 'auto';
      const replyTo = typeof args.replyTo === 'string' ? args.replyTo.trim() : '';
      const botId = String(args._botId ?? '');
      const requester = (args._requester as RelayParty | undefined) ?? null;
      const registerData = args.register as
        | { displayName: string; channelKind: string; address: string; username?: string }
        | undefined;

      if (!recipient && !replyTo) return { success: false, content: 'Missing recipient' };
      if (!message) return { success: false, content: 'Missing message' };
      if (message.length > 4000)
        return { success: false, content: 'Message too long (max 4000 chars)' };

      relays.ensureOperator(botId);
      const settings = relays.settings(botId);

      // --- Resolve the recipient ---
      let contact: ContactEntry;
      let answering: RelayRecord | undefined;
      if (replyTo) {
        const original = relays.store.get(botId, replyTo);
        if (!original) return { success: false, content: `Relay ${replyTo} not found.` };
        if (!original.from) {
          return {
            success: false,
            content: `Relay ${replyTo} was sent by the bot itself; there is nobody to answer to.`,
          };
        }
        if (original.status === 'answered' || original.answeredAt) {
          return { success: false, content: `Relay ${replyTo} was already answered.` };
        }
        const sameContact = (a: string, b: string) =>
          a === b || userDirectory.getById(botId, a)?.id === userDirectory.getById(botId, b)?.id;
        if (!requester || !isRecipientOf(original, requester, sameContact)) {
          return {
            success: false,
            content: `Relay ${replyTo} was addressed to ${original.to.displayName}; only they can answer it, from their own conversation.`,
          };
        }
        answering = original;
        contact = relays.contactFor(botId, original.from);
      } else {
        let matches = userDirectory.find(botId, recipient);
        if (matches.length === 0 && registerData) {
          const entry = userDirectory.register(botId, {
            displayName: registerData.displayName,
            channel: {
              kind: registerData.channelKind as ChannelKind,
              address: registerData.address,
              username: registerData.username,
              verified: false,
            },
          });
          matches = [entry];
          logger.info(
            { botId, contactId: entry.id, name: entry.displayName },
            'send_message: registered new contact'
          );
        }
        if (matches.length === 0) {
          return {
            success: false,
            content: `Contact "${recipient}" not found in directory. Ask the user for the recipient's contact details (name and their Telegram chatId, WhatsApp phone number, or other channel address), then call send_message again with the "register" parameter to add and message them.`,
          };
        }
        if (matches.length > 1) {
          const list = matches.map(formatContact).join('\n');
          return {
            success: false,
            content: `Multiple contacts match "${recipient}":\n${list}\n\nCall send_message again with the specific contact ID as the recipient.`,
          };
        }
        contact = matches[0];
      }

      if (channelPref !== 'auto') {
        const channels = contact.channels.filter((c) => c.kind === channelPref);
        if (channels.length === 0) {
          return {
            success: false,
            content: `Contact "${contact.displayName}" has no ${channelPref} channel.`,
          };
        }
        contact = { ...contact, channels };
      }

      // --- Sender and policy ---
      const from = settings.enabled ? requester : null;
      const expectsReply = !!from && !answering && args.expectsReply === true;
      if (!answering) {
        const decision = canRelay(from, relays.recipientParty(contact), settings);
        if (!decision.allowed) return { success: false, content: decision.reason };
      }

      // --- Deliver ---
      const result = await relays.send({
        botId,
        from,
        to: contact,
        text: message,
        expectsReply,
        answering,
      });
      const name = contact.displayName;
      const { record } = result;

      if (result.duplicate) {
        const reached = record.status === 'delivered' || record.status === 'answered';
        return {
          success: reached,
          content: reached
            ? `Already delivered to ${name} (relay ${record.id}, status ${record.status}). Do not resend it.`
            : `Already stored for ${name} (relay ${record.id}, status ${record.status}) — not delivered. Do not resend it.`,
        };
      }

      const { outcome } = result;
      if (outcome.status === 'delivered') {
        const via =
          outcome.viaBotId && outcome.viaBotId !== botId
            ? ` (through ${outcome.viaBotId}'s account)`
            : '';
        let content = `Delivered to ${name} via ${outcome.channel}${via} (relay ${record.id}).`;
        if (expectsReply && from) {
          content += ` When they reply to that message it will be forwarded to ${from.displayName} automatically; if they answer in free text, close it with send_message replyTo=${record.id}.`;
        }
        return { success: true, content };
      }
      if (outcome.status === 'queued') {
        return {
          success: false,
          content: `NOT delivered — ${name} has no reachable channel right now (${outcome.error ?? 'stored, not notified'}). Stored as relay ${record.id}. Do not tell anyone it was delivered.`,
        };
      }
      return {
        success: false,
        content: `Delivery FAILED to ${name}: ${outcome.error ?? 'no route'}. Nothing was sent. Do not claim it was sent; tell the requester plainly.`,
      };
    },
  };
}
