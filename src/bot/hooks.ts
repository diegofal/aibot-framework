/**
 * Lifecycle Hook System
 *
 * EventEmitter-based hooks that skills/extensions can register listeners on.
 * Wired into conversation-pipeline, tool-executor, and agent-loop.
 */
import { EventEmitter } from 'node:events';
import type { ChannelKind } from '../channel/types';

export interface HookEvents {
  message_received: MessageReceivedEvent;
  message_sent: MessageSentEvent;
  before_llm_call: BeforeLlmCallEvent;
  after_llm_call: AfterLlmCallEvent;
  before_tool_call: BeforeToolCallEvent;
  after_tool_call: AfterToolCallEvent;
  before_compaction: BeforeCompactionEvent;
  agent_loop_cycle: AgentLoopCycleEvent;
}

export interface MessageReceivedEvent {
  botId: string;
  channelKind: ChannelKind | 'unknown';
  chatId: number;
  userId?: string;
  text: string;
  timestamp: number;
}

export interface MessageSentEvent {
  botId: string;
  channelKind: ChannelKind | 'unknown';
  chatId: number;
  text: string;
  timestamp: number;
}

export interface BeforeLlmCallEvent {
  botId: string;
  caller: string;
  messageCount: number;
  timestamp: number;
}

export interface AfterLlmCallEvent {
  botId: string;
  caller: string;
  durationMs: number;
  tokenCount?: number;
  success: boolean;
  timestamp: number;
}

export interface BeforeToolCallEvent {
  botId: string;
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface AfterToolCallEvent {
  botId: string;
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  timestamp: number;
}

export interface BeforeCompactionEvent {
  botId: string;
  messageCount: number;
  estimatedTokens: number;
  timestamp: number;
}

export interface AgentLoopCycleEvent {
  botId: string;
  cycle: number;
  status: 'started' | 'completed' | 'error' | 'idle';
  durationMs?: number;
  timestamp: number;
}

/**
 * Central hook emitter for the bot lifecycle.
 * Skills and extensions register listeners via `hooks.on(event, handler)`.
 */
export class HookEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // Allow many skill listeners
  }

  /** Type-safe emit */
  emitHook<K extends keyof HookEvents>(event: K, data: HookEvents[K]): boolean {
    return this.emit(event, data);
  }

  /** Type-safe on */
  onHook<K extends keyof HookEvents>(event: K, handler: (data: HookEvents[K]) => void): this {
    return this.on(event, handler);
  }

  /** Type-safe once */
  onceHook<K extends keyof HookEvents>(event: K, handler: (data: HookEvents[K]) => void): this {
    return this.once(event, handler);
  }
}
