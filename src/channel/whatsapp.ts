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
  /** Webhook verification token — only needed for inbound webhook setup */
  verifyToken?: string;
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

// --- Image sending ---

/**
 * Build the JSON payload for a WhatsApp image message (pure, no I/O).
 */
export function buildImagePayload(
  recipientPhone: string,
  phoneNumberId: string,
  imageUrl: string,
  caption?: string
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    to: recipientPhone,
    type: 'image',
    image: {
      link: imageUrl,
      ...(caption && { caption }),
    },
  };
}

/**
 * Send an image via WhatsApp Cloud API.
 */
export async function sendWhatsAppImage(
  phoneNumber: string,
  config: WhatsAppConfig,
  imageUrl: string,
  caption?: string
): Promise<void> {
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;
  const body = buildImagePayload(phoneNumber, config.phoneNumberId, imageUrl, caption);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`WhatsApp image send failed: ${resp.status} ${text}`);
  }
}

// --- Interactive messages (buttons) ---

/**
 * Build the JSON payload for a WhatsApp interactive button message (pure, no I/O).
 */
export function buildInteractivePayload(
  recipientPhone: string,
  phoneNumberId: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    to: recipientPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };
}

/**
 * Send an interactive button message via WhatsApp Cloud API.
 * Useful for inline-approval confirm/deny flows.
 */
export async function sendWhatsAppInteractive(
  phoneNumber: string,
  config: WhatsAppConfig,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>
): Promise<void> {
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;
  const payload = buildInteractivePayload(phoneNumber, config.phoneNumberId, bodyText, buttons);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`WhatsApp interactive send failed: ${resp.status} ${text}`);
  }
}

// --- Status event extraction ---

export interface WhatsAppStatusEvent {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: number;
  recipientId: string;
  phoneNumberId: string;
}

/**
 * Extract status events from a WhatsApp webhook payload (pure, no I/O).
 * WhatsApp sends delivery/read receipts under entry[].changes[].value.statuses[].
 */
export function extractStatuses(payload: WhatsAppWebhookPayload): WhatsAppStatusEvent[] {
  const results: WhatsAppStatusEvent[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!value.statuses) continue;

      for (const s of value.statuses) {
        results.push({
          messageId: s.id,
          status: s.status,
          timestamp: Number.parseInt(s.timestamp, 10) * 1000,
          recipientId: s.recipient_id,
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
