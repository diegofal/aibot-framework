import type { ContactChannel, ContactEntry, UserDirectory } from '../bot/user-directory';
import type { Channel, ChannelKind } from '../channel/types';
/**
 * send_message tool — channel-agnostic message sending with contact lookup.
 *
 * Searches the UserDirectory by name/username/ID, resolves the best channel,
 * and delivers the message. If the contact is unknown, instructs the LLM to
 * ask the user for details and call again with the `register` parameter.
 */
import type { Logger } from '../logger';
import type { Tool, ToolResult } from './types';

export interface SendMessageDeps {
  userDirectory: UserDirectory;
  createOutboundChannel: (botId: string, contact: ContactChannel) => Channel | null;
}

/** Channel preference order for "auto" mode */
const CHANNEL_PRIORITY: ChannelKind[] = ['telegram', 'whatsapp', 'web'];

function pickChannel(
  entry: ContactEntry,
  preferredKind: string | undefined
): ContactChannel | null {
  if (preferredKind && preferredKind !== 'auto') {
    return entry.channels.find((c) => c.kind === preferredKind) ?? null;
  }
  // Auto: pick by priority
  for (const kind of CHANNEL_PRIORITY) {
    const ch = entry.channels.find((c) => c.kind === kind);
    if (ch) return ch;
  }
  return entry.channels[0] ?? null;
}

function formatContact(e: ContactEntry): string {
  const channels = e.channels.map((c) => `${c.kind}:${c.address}`).join(', ');
  return `• ${e.displayName} (id: ${e.id}, channels: ${channels})`;
}

export function createSendMessageTool(deps: SendMessageDeps): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'send_message',
        description:
          'Send a message to a contact. Searches the contact directory by name, @username, or contact ID. ' +
          'If the contact is not found and you have their details, pass the "register" parameter to add them. ' +
          "If you do not have their details, ask the user for the recipient's name and contact info (e.g. Telegram chatId or phone number).",
        parameters: {
          type: 'object',
          properties: {
            recipient: {
              type: 'string',
              description:
                'Name, @username, or contact ID of the recipient. Searched in the contact directory.',
            },
            message: {
              type: 'string',
              description: 'The message text to send (max 4000 chars)',
            },
            channel: {
              type: 'string',
              enum: ['telegram', 'whatsapp', 'web', 'auto'],
              description:
                'Channel to deliver through. "auto" (default) picks the best available channel.',
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
          required: ['recipient', 'message'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const recipient = String(args.recipient ?? '').trim();
      const message = String(args.message ?? '').trim();
      const channelPref = (args.channel as string) || 'auto';
      const botId = String(args._botId ?? '');
      const registerData = args.register as
        | { displayName: string; channelKind: string; address: string; username?: string }
        | undefined;

      if (!recipient) return { success: false, content: 'Missing recipient' };
      if (!message) return { success: false, content: 'Missing message' };
      if (message.length > 4000)
        return { success: false, content: 'Message too long (max 4000 chars)' };

      // Search contact directory
      let matches = deps.userDirectory.find(botId, recipient);

      // No matches — try to register if data provided
      if (matches.length === 0 && registerData) {
        const entry = deps.userDirectory.register(botId, {
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

      // No matches and no register data — instruct LLM to ask
      if (matches.length === 0) {
        return {
          success: false,
          content: `Contact "${recipient}" not found in directory. Ask the user for the recipient's contact details (name and their Telegram chatId, WhatsApp phone number, or other channel address), then call send_message again with the "register" parameter to add and message them.`,
        };
      }

      // Multiple matches — return list for disambiguation
      if (matches.length > 1) {
        const list = matches.map(formatContact).join('\n');
        return {
          success: false,
          content: `Multiple contacts match "${recipient}":\n${list}\n\nCall send_message again with the specific contact ID as the recipient.`,
        };
      }

      // Single match — deliver
      const contact = matches[0];
      const targetChannel = pickChannel(contact, channelPref);
      if (!targetChannel) {
        return {
          success: false,
          content: `Contact "${contact.displayName}" has no ${channelPref === 'auto' ? 'available' : channelPref} channel.`,
        };
      }

      const outbound = deps.createOutboundChannel(botId, targetChannel);
      if (!outbound) {
        return {
          success: false,
          content:
            `Cannot create outbound channel for ${targetChannel.kind}. ` +
            `The bot may not have an active ${targetChannel.kind} connection or the required config is missing.`,
        };
      }

      try {
        await outbound.sendText(message);
        logger.info(
          {
            botId,
            contactId: contact.id,
            contactName: contact.displayName,
            channel: targetChannel.kind,
            messageLength: message.length,
          },
          'send_message: delivered'
        );
        return {
          success: true,
          content: `Message sent to ${contact.displayName} via ${targetChannel.kind}`,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, contactId: contact.id, channel: targetChannel.kind },
          'send_message: delivery failed'
        );
        return { success: false, content: `Delivery failed: ${errMsg}` };
      }
    },
  };
}
