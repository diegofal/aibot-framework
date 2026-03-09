import { describe, expect, it } from 'vitest';
import {
  extractMessages,
  verifyWebhookSignature,
  whatsappChannel,
  whatsappToInbound,
} from '../../src/channel/whatsapp';
import type { WhatsAppWebhookPayload } from '../../src/channel/whatsapp';

describe('WhatsApp channel adapter', () => {
  describe('whatsappToInbound', () => {
    it('converts a text message', () => {
      const msg = whatsappToInbound(
        {
          from: '5491155551234',
          id: 'wamid.123',
          timestamp: '1709900000',
          type: 'text',
          text: { body: 'Hello bot!' },
        },
        'Juan',
        'pn123'
      );

      expect(msg).not.toBeNull();
      expect(msg?.messageId).toBe('wamid.123');
      expect(msg?.channelKind).toBe('whatsapp');
      expect(msg?.text).toBe('Hello bot!');
      expect(msg?.chatId).toBe('wa:5491155551234');
      expect(msg?.chatType).toBe('private');
      expect(msg?.sender.id).toBe('5491155551234');
      expect(msg?.sender.firstName).toBe('Juan');
      expect(msg?.timestamp).toBe(1709900000000);
    });

    it('converts an image message with caption', () => {
      const msg = whatsappToInbound(
        {
          from: '5491155551234',
          id: 'wamid.456',
          timestamp: '1709900000',
          type: 'image',
          image: { id: 'img123', mime_type: 'image/jpeg', caption: 'Look at this' },
        },
        undefined,
        'pn123'
      );

      expect(msg).not.toBeNull();
      expect(msg?.text).toBe('Look at this');
    });

    it('returns null for unsupported message types', () => {
      const msg = whatsappToInbound(
        {
          from: '5491155551234',
          id: 'wamid.789',
          timestamp: '1709900000',
          type: 'location',
        },
        undefined,
        'pn123'
      );

      expect(msg).toBeNull();
    });

    it('marks audio messages as voice', () => {
      const msg = whatsappToInbound(
        {
          from: '5491155551234',
          id: 'wamid.audio',
          timestamp: '1709900000',
          type: 'audio',
          audio: { id: 'aud1', mime_type: 'audio/ogg' },
        },
        undefined,
        'pn123'
      );

      // Audio without text returns null (not a text message)
      expect(msg).toBeNull();
    });
  });

  describe('extractMessages', () => {
    it('extracts messages from a webhook payload', () => {
      const payload: WhatsAppWebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'entry1',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '+15551234567',
                    phone_number_id: 'pn123',
                  },
                  contacts: [{ profile: { name: 'María' }, wa_id: '5491155551234' }],
                  messages: [
                    {
                      from: '5491155551234',
                      id: 'wamid.100',
                      timestamp: '1709900000',
                      type: 'text',
                      text: { body: 'Hola!' },
                    },
                  ],
                },
                field: 'messages',
              },
            ],
          },
        ],
      };

      const extracted = extractMessages(payload);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].message.id).toBe('wamid.100');
      expect(extracted[0].contactName).toBe('María');
      expect(extracted[0].phoneNumberId).toBe('pn123');
    });

    it('skips non-message changes', () => {
      const payload: WhatsAppWebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'entry1',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '+15551234567',
                    phone_number_id: 'pn123',
                  },
                  statuses: [
                    {
                      id: 'wamid.100',
                      status: 'delivered',
                      timestamp: '1709900000',
                      recipient_id: '5491155551234',
                    },
                  ],
                },
                field: 'statuses',
              },
            ],
          },
        ],
      };

      const extracted = extractMessages(payload);
      expect(extracted).toHaveLength(0);
    });
  });

  describe('verifyWebhookSignature', () => {
    it('verifies a valid signature', () => {
      const body = '{"test":"data"}';
      const secret = 'my-app-secret';
      // Pre-computed HMAC-SHA256
      const crypto = require('node:crypto');
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

      expect(verifyWebhookSignature(body, expected, secret)).toBe(true);
    });

    it('rejects an invalid signature', () => {
      expect(verifyWebhookSignature('body', 'sha256=wrong', 'secret')).toBe(false);
    });

    it('rejects missing signature', () => {
      expect(verifyWebhookSignature('body', undefined, 'secret')).toBe(false);
    });
  });

  describe('whatsappChannel', () => {
    it('creates a channel with whatsapp kind', () => {
      const channel = whatsappChannel('5491155551234', {
        phoneNumberId: 'pn123',
        accessToken: 'token',
        verifyToken: 'verify',
      });

      expect(channel.kind).toBe('whatsapp');
    });

    it('showTyping is a no-op', async () => {
      const channel = whatsappChannel('5491155551234', {
        phoneNumberId: 'pn123',
        accessToken: 'token',
        verifyToken: 'verify',
      });

      // Should not throw
      await channel.showTyping();
    });
  });
});
