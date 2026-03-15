import type { BotConfig } from '../config';
import type { ToolDefinition } from '../tools/types';
import type { AgentCard, AgentSkill } from './types';

export interface AgentCardOptions {
  baseUrl: string;
  botConfig: BotConfig;
  toolDefinitions: ToolDefinition[];
  version?: string;
}

export function buildAgentCard(opts: AgentCardOptions): AgentCard {
  const { baseUrl, botConfig, toolDefinitions, version = '1.0.0' } = opts;

  const skills: AgentSkill[] = toolDefinitions.map((td) => ({
    id: td.function.name,
    name: td.function.name,
    description: td.function.description,
    tags: [],
  }));

  return {
    name: botConfig.name,
    description: botConfig.description ?? `Agent ${botConfig.name}`,
    url: `${baseUrl}/a2a/${botConfig.id}`,
    version,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills,
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
}
