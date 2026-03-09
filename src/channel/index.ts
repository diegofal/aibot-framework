export type { Channel, ChannelKind, InboundMessage } from './types';
export { telegramToInbound, telegramChannel } from './telegram';
export { wsToInbound, wsChannel } from './websocket';
export type { WsChatData } from './websocket';
export {
  whatsappToInbound,
  whatsappChannel,
  verifyWebhookSignature,
  extractMessages,
} from './whatsapp';
export type { WhatsAppConfig, WhatsAppWebhookPayload, WhatsAppMessage } from './whatsapp';
