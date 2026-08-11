export { BotManager } from './bot-manager';
export { AgentLoop } from './agent-loop';
export {
  AUTO_START_ENV_VAR,
  BotDisabledError,
  autoStartEnabledBots,
  resolveAutoStart,
} from './auto-start';
export type { AutoStartDecision, AutoStartResult } from './auto-start';
export { HookEmitter } from './hooks';
export type {
  HookEvents,
  MessageReceivedEvent,
  MessageSentEvent,
  BeforeLlmCallEvent,
  AfterLlmCallEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeCompactionEvent,
  AgentLoopCycleEvent,
} from './hooks';
export type { SystemPromptOptions } from './system-prompt-builder';
