export type { Channel, ChannelKind, InboundMessage } from './types';
export { telegramToInbound, telegramChannel } from './telegram';
export { restToInbound, restCollectChannel } from './rest';
export type { RestChatInput } from './rest';
export { wsToInbound, wsChannel } from './websocket';
export type { WsChatData } from './websocket';
export {
  whatsappToInbound,
  whatsappChannel,
  verifyWebhookSignature,
  extractMessages,
} from './whatsapp';
export type { WhatsAppConfig, WhatsAppWebhookPayload, WhatsAppMessage } from './whatsapp';
export { discordToInbound, discordChannel, splitDiscordMessage } from './discord';
export type { DiscordConfig, DiscordMessagePayload } from './discord';
export { DiscordGateway } from './discord-gateway';
export type { DiscordGatewayDeps } from './discord-gateway';
