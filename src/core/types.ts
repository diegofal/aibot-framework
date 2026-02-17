import type { Logger } from '../logger';
import type { OllamaClient } from '../ollama';
import type { LLMClient } from './llm-client';

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  main: string;
  config?: {
    schema?: Record<string, unknown>;
  };
}

export interface CommandHandler {
  description: string;
  handler: (args: string[], context: SkillContext) => Promise<string>;
}

export interface JobDefinition {
  id: string;
  schedule: string; // Cron expression
  handler: (context: SkillContext) => Promise<string | void>;
}

export interface TelegramMessage {
  text: string;
  from: {
    id: number;
    username?: string;
    first_name?: string;
  };
  chat: {
    id: number;
    type: string;
  };
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, options?: unknown): Promise<void>;
  sendDocument(chatId: number, document: string | Buffer, options?: unknown): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, options?: unknown): Promise<void>;
  editMessageText(chatId: number, messageId: number, text: string, options?: unknown): Promise<void>;
}

export interface DataStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  has(key: string): boolean;
}

export interface SessionInfo {
  key: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  chatId: number;
  userId?: number;
  threadId?: number;
}

export interface SkillContext {
  config: unknown; // Skill-specific configuration
  logger: Logger;
  ollama: OllamaClient;
  llm: LLMClient; // Preferred LLM access — backend configured per skill
  telegram: TelegramClient;
  data: DataStore;
  skillId: string;
  session?: SessionInfo;
}

export interface CallbackQueryData {
  id: string;
  chatId: number;
  messageId: number;
  userId: number;
  data: string;
}

export interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;

  // Lifecycle hooks
  onLoad?(context: SkillContext): Promise<void>;
  onUnload?(): Promise<void>;

  // Telegram command handlers
  commands?: Record<string, CommandHandler>;

  // Scheduled jobs
  jobs?: JobDefinition[];

  // Message handlers (for non-command messages)
  // Return true to indicate the message was consumed (skip conversation handler)
  onMessage?(message: TelegramMessage, context: SkillContext): Promise<boolean | void>;

  // Callback query handler for inline keyboard buttons
  onCallbackQuery?(query: CallbackQueryData, context: SkillContext): Promise<void>;
}
