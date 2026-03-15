import { type DiscordConfig, type DiscordMessagePayload, discordToInbound } from './discord';
/**
 * Discord Gateway WebSocket connection.
 * Connects to Discord Gateway, receives MESSAGE_CREATE events,
 * and pipes them through the conversation pipeline.
 */
import type { InboundMessage } from './types';

export interface DiscordGatewayDeps {
  handleMessage: (botId: string, inbound: InboundMessage) => Promise<void>;
  logger: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export class DiscordGateway {
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private _connected = false;

  constructor(
    private botId: string,
    private config: DiscordConfig,
    private deps: DiscordGatewayDeps
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    const gatewayUrl = this.resumeUrl ?? 'wss://gateway.discord.gg/?v=10&encoding=json';
    this.ws = new WebSocket(gatewayUrl);

    this.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data));
        this.handleGatewayEvent(payload);
      } catch (err) {
        this.deps.logger.warn({ err: String(err) }, 'Discord gateway: failed to parse message');
      }
    };

    this.ws.onclose = (event) => {
      this._connected = false;
      this.deps.logger.info(
        { code: event.code, reason: event.reason },
        'Discord gateway: disconnected'
      );
      this.clearHeartbeat();
      // Auto-reconnect after 5s
      setTimeout(() => this.connect(), 5000);
    };

    this.ws.onerror = () => {
      this.deps.logger.warn({}, 'Discord gateway: WebSocket error');
    };
  }

  disconnect(): void {
    this._connected = false;
    this.clearHeartbeat();
    this.ws?.close(1000, 'Bot shutting down');
    this.ws = null;
  }

  /** Exposed for testing — process a raw gateway payload. */
  handleGatewayEvent(payload: { op: number; d: any; s?: number; t?: string }): void {
    const { op, d, s, t } = payload;

    if (s) this.sequence = s;

    switch (op) {
      case 10: // Hello
        this.startHeartbeat(d.heartbeat_interval);
        this.identify();
        break;
      case 11: // Heartbeat ACK
        break;
      case 0: // Dispatch
        if (t === 'READY') {
          this.sessionId = d.session_id;
          this.resumeUrl = d.resume_gateway_url;
          this._connected = true;
          this.deps.logger.info(
            { botId: this.botId, user: d.user?.username },
            'Discord gateway: ready'
          );
        } else if (t === 'MESSAGE_CREATE') {
          this.handleMessageCreate(d);
        }
        break;
    }
  }

  private identify(): void {
    this.ws?.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.config.token,
          intents: 512 | 32768, // GUILD_MESSAGES | MESSAGE_CONTENT
          properties: { os: 'linux', browser: 'aibot', device: 'aibot' },
        },
      })
    );
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
    }, intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleMessageCreate(data: DiscordMessagePayload): void {
    // Skip bot messages
    if (data.author.bot) return;

    // Check channel filter
    if (this.config.channelIds?.length && !this.config.channelIds.includes(data.channel_id)) {
      return;
    }

    const inbound = discordToInbound(data);
    this.deps.handleMessage(this.botId, inbound).catch((err) => {
      this.deps.logger.error(
        { err: String(err), messageId: data.id },
        'Discord: message handling failed'
      );
    });
  }
}
