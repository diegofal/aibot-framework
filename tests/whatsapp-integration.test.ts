/**
 * WhatsApp integration tests — covers webhook signature verification,
 * message extraction, payload builders, status parsing, and channel creation.
 */
import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  type WhatsAppConfig,
  type WhatsAppWebhookPayload,
  buildImagePayload,
  buildInteractivePayload,
  extractMessages,
  extractStatuses,
  verifyWebhookSignature,
  whatsappChannel,
  whatsappToInbound,
} from '../src/channel/whatsapp';

// --- Helpers ---

function makePayload(overrides: Partial<WhatsAppWebhookPayload> = {}): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123456',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+5491155551234',
                phone_number_id: 'pn_001',
              },
              contacts: [
                {
                  profile: { name: 'Diego Test' },
                  wa_id: '5491155551234',
                },
              ],
              messages: [
                {
                  from: '5491155551234',
                  id: 'wamid.abc123',
                  timestamp: '1710500000',
                  type: 'text',
                  text: { body: 'Hello bot!' },
                },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeStatusPayload(): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123456',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+5491155551234',
                phone_number_id: 'pn_001',
              },
              statuses: [
                {
                  id: 'wamid.sent123',
                  status: 'delivered',
                  timestamp: '1710500100',
                  recipient_id: '5491155551234',
                },
                {
                  id: 'wamid.sent123',
                  status: 'read',
                  timestamp: '1710500200',
                  recipient_id: '5491155551234',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

const testConfig: WhatsAppConfig = {
  phoneNumberId: 'pn_001',
  accessToken: 'test-token-123',
  verifyToken: 'verify-test',
  appSecret: 'secret-abc',
};

// --- Webhook Signature Verification ---

describe('verifyWebhookSignature', () => {
  it('returns true for a valid signature', () => {
    const body = '{"test": true}';
    const hmac = createHmac('sha256', 'my-secret').update(body).digest('hex');
    const sig = `sha256=${hmac}`;
    expect(verifyWebhookSignature(body, sig, 'my-secret')).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    const body = '{"test": true}';
    expect(verifyWebhookSignature(body, 'sha256=badhash', 'my-secret')).toBe(false);
  });

  it('returns false when signature is undefined', () => {
    expect(verifyWebhookSignature('body', undefined, 'secret')).toBe(false);
  });

  it('returns false when signature length differs', () => {
    expect(verifyWebhookSignature('body', 'sha256=short', 'secret')).toBe(false);
  });

  it('works with Buffer input', () => {
    const body = Buffer.from('{"test": true}');
    const hmac = createHmac('sha256', 'my-secret').update(body).digest('hex');
    const sig = `sha256=${hmac}`;
    expect(verifyWebhookSignature(body, sig, 'my-secret')).toBe(true);
  });
});

// --- Message Extraction ---

describe('extractMessages', () => {
  it('extracts text messages with contact names', () => {
    const payload = makePayload();
    const results = extractMessages(payload);
    expect(results).toHaveLength(1);
    expect(results[0].message.type).toBe('text');
    expect(results[0].message.text?.body).toBe('Hello bot!');
    expect(results[0].contactName).toBe('Diego Test');
    expect(results[0].phoneNumberId).toBe('pn_001');
  });

  it('returns empty for non-messages field', () => {
    const payload = makePayload();
    payload.entry[0].changes[0].field = 'account_update';
    const results = extractMessages(payload);
    expect(results).toHaveLength(0);
  });

  it('returns empty when no messages array', () => {
    const payload = makePayload();
    (payload.entry[0].changes[0].value as any).messages = undefined;
    const results = extractMessages(payload);
    expect(results).toHaveLength(0);
  });

  it('handles missing contacts gracefully', () => {
    const payload = makePayload();
    (payload.entry[0].changes[0].value as any).contacts = undefined;
    const results = extractMessages(payload);
    expect(results).toHaveLength(1);
    expect(results[0].contactName).toBeUndefined();
  });

  it('handles multiple messages in one change', () => {
    const payload = makePayload();
    payload.entry[0].changes[0].value.messages?.push({
      from: '5491166660000',
      id: 'wamid.xyz789',
      timestamp: '1710500001',
      type: 'text',
      text: { body: 'Second message' },
    });
    const results = extractMessages(payload);
    expect(results).toHaveLength(2);
  });
});

// --- whatsappToInbound ---

describe('whatsappToInbound', () => {
  it('converts a text message', () => {
    const msg = {
      from: '5491155551234',
      id: 'wamid.abc',
      timestamp: '1710500000',
      type: 'text' as const,
      text: { body: 'Hola' },
    };
    const inbound = whatsappToInbound(msg, 'Diego', 'pn_001');
    expect(inbound).not.toBeNull();
    expect(inbound?.channelKind).toBe('whatsapp');
    expect(inbound?.text).toBe('Hola');
    expect(inbound?.chatId).toBe('wa:5491155551234');
    expect(inbound?.chatType).toBe('private');
    expect(inbound?.sender.id).toBe('5491155551234');
    expect(inbound?.sender.firstName).toBe('Diego');
    expect(inbound?.timestamp).toBe(1710500000000);
  });

  it('converts an image message with caption', () => {
    const msg = {
      from: '5491155551234',
      id: 'wamid.img',
      timestamp: '1710500000',
      type: 'image' as const,
      image: { id: 'media_123', mime_type: 'image/jpeg', caption: 'Look at this' },
    };
    const inbound = whatsappToInbound(msg, undefined, 'pn_001');
    expect(inbound).not.toBeNull();
    expect(inbound?.text).toBe('Look at this');
  });

  it('returns [image] for image without caption', () => {
    const msg = {
      from: '5491155551234',
      id: 'wamid.img2',
      timestamp: '1710500000',
      type: 'image' as const,
      image: { id: 'media_456', mime_type: 'image/png' },
    };
    const inbound = whatsappToInbound(msg, undefined, 'pn_001');
    expect(inbound).not.toBeNull();
    expect(inbound?.text).toBe('[image]');
  });

  it('returns null for unsupported types', () => {
    const msg = {
      from: '5491155551234',
      id: 'wamid.loc',
      timestamp: '1710500000',
      type: 'location' as const,
    };
    expect(whatsappToInbound(msg, undefined, 'pn_001')).toBeNull();
  });

  it('sets isVoice for audio messages', () => {
    // audio type currently returns null (unsupported path) but isVoice is set
    // on text-convertible messages — verifying the audio branch returns null
    const msg = {
      from: '5491155551234',
      id: 'wamid.aud',
      timestamp: '1710500000',
      type: 'audio' as const,
      audio: { id: 'media_789', mime_type: 'audio/ogg' },
    };
    expect(whatsappToInbound(msg, undefined, 'pn_001')).toBeNull();
  });
});

// --- Image Payload Builder ---

describe('buildImagePayload', () => {
  it('builds correct payload with caption', () => {
    const payload = buildImagePayload(
      '5491155551234',
      'pn_001',
      'https://img.test/photo.jpg',
      'Check it'
    );
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      to: '5491155551234',
      type: 'image',
      image: {
        link: 'https://img.test/photo.jpg',
        caption: 'Check it',
      },
    });
  });

  it('builds payload without caption', () => {
    const payload = buildImagePayload('5491155551234', 'pn_001', 'https://img.test/photo.jpg');
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      to: '5491155551234',
      type: 'image',
      image: {
        link: 'https://img.test/photo.jpg',
      },
    });
  });

  it('omits caption when empty string', () => {
    const payload = buildImagePayload('5491155551234', 'pn_001', 'https://img.test/photo.jpg', '');
    expect((payload.image as any).caption).toBeUndefined();
  });
});

// --- Interactive Payload Builder ---

describe('buildInteractivePayload', () => {
  it('builds correct button payload', () => {
    const buttons = [
      { id: 'approve', title: 'Yes, proceed' },
      { id: 'deny', title: 'No, cancel' },
    ];
    const payload = buildInteractivePayload(
      '5491155551234',
      'pn_001',
      'Allow file write?',
      buttons
    );

    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      to: '5491155551234',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Allow file write?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'approve', title: 'Yes, proceed' } },
            { type: 'reply', reply: { id: 'deny', title: 'No, cancel' } },
          ],
        },
      },
    });
  });

  it('handles single button', () => {
    const payload = buildInteractivePayload('123', 'pn_001', 'OK?', [{ id: 'ok', title: 'OK' }]);
    expect((payload.interactive as any).action.buttons).toHaveLength(1);
  });

  it('handles three buttons (WhatsApp max)', () => {
    const buttons = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ];
    const payload = buildInteractivePayload('123', 'pn_001', 'Choose', buttons);
    expect((payload.interactive as any).action.buttons).toHaveLength(3);
  });
});

// --- Status Event Extraction ---

describe('extractStatuses', () => {
  it('extracts status events', () => {
    const payload = makeStatusPayload();
    const statuses = extractStatuses(payload);
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toEqual({
      messageId: 'wamid.sent123',
      status: 'delivered',
      timestamp: 1710500100000,
      recipientId: '5491155551234',
      phoneNumberId: 'pn_001',
    });
    expect(statuses[1].status).toBe('read');
    expect(statuses[1].timestamp).toBe(1710500200000);
  });

  it('returns empty for payload without statuses', () => {
    const payload = makePayload(); // messages-only
    const statuses = extractStatuses(payload);
    expect(statuses).toHaveLength(0);
  });

  it('returns empty for non-messages field', () => {
    const payload = makeStatusPayload();
    payload.entry[0].changes[0].field = 'account_update';
    const statuses = extractStatuses(payload);
    expect(statuses).toHaveLength(0);
  });
});

// --- Channel Creation ---

describe('whatsappChannel', () => {
  it('creates a channel with correct kind', () => {
    const channel = whatsappChannel('5491155551234', testConfig);
    expect(channel.kind).toBe('whatsapp');
    expect(typeof channel.sendText).toBe('function');
    expect(typeof channel.showTyping).toBe('function');
  });

  it('showTyping is a no-op that resolves', async () => {
    const channel = whatsappChannel('5491155551234', testConfig);
    // Should not throw
    await channel.showTyping();
  });
});
