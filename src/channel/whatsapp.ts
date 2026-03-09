/**
 * WhatsApp Business API channel adapter.
 *
 * Uses the WhatsApp Cloud API (Meta Graph API) for sending/receiving messages.
 * Inbound messages arrive via webhook; outbound messages are sent via REST.
 *
 * Required config (per bot or global):
 *   whatsapp.phoneNumberId  — WhatsApp Business phone number ID
 *   whatsapp.accessToken    — Graph API bearer token
 *   whatsapp.verifyToken    — Webhook verification token (set during app setup)
 *   whatsapp.appSecret      — App secret for webhook signature verification
 */
import { createHmac } from 'node:crypto';
import type { Channel, InboundMessage } from './types';

// --- WhatsApp Cloud API types (subset) ---

export interface WhatsAppWebhookPayload {
  object: 'whatsapp_business_account';
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: 'whatsapp';
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: Array<WhatsAppMessage>;
        statuses?: Array<{
          id: string;
          status: 'sent' | 'delivered' | 'read' | 'failed';
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type:
    | 'text'
    | 'image'
    | 'audio'
    | 'video'
    | 'document'
    | 'location'
    | 'reaction'
    | 'interactive'
    | 'button';
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  audio?: { id: string; mime_type: string };
}

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret?: string;
}

// --- Adapter functions ---

/**
 * Convert a WhatsApp inbound message to a channel-agnostic InboundMessage.
 */
export function whatsappToInbound(
  msg: WhatsAppMessage,
  contactName: string | undefined,
  phoneNumberId: string
): InboundMessage | null {
  // Only handle text and image messages for now
  let text = '';
  const images: string[] | undefined = undefined;

  if (msg.type === 'text' && msg.text?.body) {
    text = msg.text.body;
  } else if (msg.type === 'image' && msg.image) {
    text = msg.image.caption ?? '[image]';
    // Image binary download handled separately via Graph API
  } else {
    // Unsupported message type — skip
    return null;
  }

  return {
    messageId: msg.id,
    channelKind: 'whatsapp',
    text,
    chatId: `wa:${msg.from}`,
    chatType: 'private',
    sender: {
      id: msg.from,
      firstName: contactName,
    },
    images,
    isVoice: msg.type === 'audio',
    timestamp: Number.parseInt(msg.timestamp, 10) * 1000,
  };
}

/**
 * Create a Channel that sends replies via the WhatsApp Cloud API.
 */
export function whatsappChannel(recipientPhone: string, waConfig: WhatsAppConfig): Channel {
  const apiUrl = `https://graph.facebook.com/v21.0/${waConfig.phoneNumberId}/messages`;

  return {
    kind: 'whatsapp',

    async sendText(text: string) {
      await sendWhatsAppMessage(apiUrl, waConfig.accessToken, {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: text },
      });
    },

    async showTyping() {
      // WhatsApp doesn't have a typing indicator API — no-op
    },
  };
}

/**
 * Verify webhook signature from Meta (X-Hub-Signature-256 header).
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  appSecret: string
): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Extract inbound messages from a WhatsApp webhook payload.
 * Returns an array of { message, contactName, phoneNumberId } tuples.
 */
export function extractMessages(
  payload: WhatsAppWebhookPayload
): Array<{ message: WhatsAppMessage; contactName?: string; phoneNumberId: string }> {
  const results: Array<{ message: WhatsAppMessage; contactName?: string; phoneNumberId: string }> =
    [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!value.messages) continue;

      const contactMap = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        contactMap.set(contact.wa_id, contact.profile.name);
      }

      for (const msg of value.messages) {
        results.push({
          message: msg,
          contactName: contactMap.get(msg.from),
          phoneNumberId: value.metadata.phone_number_id,
        });
      }
    }
  }

  return results;
}

// --- Internal helpers ---

async function sendWhatsAppMessage(
  apiUrl: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<void> {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => 'unknown');
    throw new Error(`WhatsApp API error ${response.status}: ${errBody}`);
  }
}
