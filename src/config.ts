import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Zod schemas for type-safe configuration
const BotConversationOverrideSchema = z.object({
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxHistory: z.number().int().positive().optional(),
}).optional();

const StrategistConfigSchema = z.object({
  enabled: z.boolean().default(true),
  everyCycles: z.number().int().min(1).default(4),
  minInterval: z.string().default('4h'),
}).default({});

export const GlobalAgentLoopConfigSchema = z.object({
  enabled: z.boolean().default(false),
  every: z.string().default('6h'),
  minInterval: z.string().default('1m'),
  maxInterval: z.string().default('24h'),
  maxToolRounds: z.number().int().min(1).max(20).default(10),
  maxDurationMs: z.number().int().positive().default(300_000),
  claudeTimeout: z.number().int().positive().default(120_000),
  disabledTools: z.array(z.string()).optional(),
  strategist: StrategistConfigSchema,
}).default({});

export const BotAgentLoopOverrideSchema = z.object({
  reportChatId: z.number().optional(),
  every: z.string().optional(),
  claudeTimeout: z.number().int().positive().optional(),
  disabledTools: z.array(z.string()).optional(),
  mode: z.enum(['periodic', 'continuous']).default('periodic'),
  continuousPauseMs: z.number().int().min(0).default(5_000),
  continuousMemoryEvery: z.number().int().min(1).default(5),
  strategist: z.object({
    enabled: z.boolean().optional(),
    everyCycles: z.number().int().min(1).optional(),
    minInterval: z.string().optional(),
  }).optional(),
}).optional();

const DynamicToolsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  storePath: z.string().default('./data/tools'),
  maxToolsPerBot: z.number().default(20),
}).default({});

const BotProductionsConfigSchema = z.object({
  dir: z.string().optional(),
  trackOnly: z.boolean().default(false),
  enabled: z.boolean().default(true),
}).optional();

const BotConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string().optional().default(''),
  enabled: z.boolean().default(true),
  allowedUsers: z.array(z.number()).optional(),
  skills: z.array(z.string()),
  mentionPatterns: z.array(z.string()).optional(),
  model: z.string().optional(),
  llmBackend: z.enum(['ollama', 'claude-cli']).optional(),
  soulDir: z.string().optional(),
  workDir: z.string().optional(),
  description: z.string().optional(),
  disabledTools: z.array(z.string()).optional(),
  conversation: BotConversationOverrideSchema,
  agentLoop: BotAgentLoopOverrideSchema,
  productions: BotProductionsConfigSchema,
});

const OllamaConfigSchema = z.object({
  baseUrl: z.string().url(),
  models: z.object({
    primary: z.string(),
    fallbacks: z.array(z.string()).optional(),
  }),
});

const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  file: z.string().optional(),
});

const PathsConfigSchema = z.object({
  data: z.string(),
  logs: z.string(),
  skills: z.string(),
});

const SkillsConfigSchema = z.object({
  enabled: z.array(z.string()),
  config: z.record(z.unknown()),
});

const ConversationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  systemPrompt: z.string().default('You are a helpful assistant.'),
  temperature: z.number().min(0).max(2).default(0.7),
  maxHistory: z.number().int().positive().default(20),
});

const WebToolsSearchConfigSchema = z.object({
  apiKey: z.string(),
  maxResults: z.number().int().positive().default(5),
  timeout: z.number().int().positive().default(30_000),
  cacheTtlMs: z.number().int().positive().optional(),
});

const WebToolsFetchConfigSchema = z.object({
  maxContentLength: z.number().int().positive().default(50_000),
  timeout: z.number().int().positive().default(30_000),
  cacheTtlMs: z.number().int().positive().optional(),
});

const ExecToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  timeout: z.number().int().positive().default(30_000),
  maxOutputLength: z.number().int().positive().default(10_000),
  workdir: z.string().optional(),
  allowedPatterns: z.array(z.string()).optional(),
  deniedPatterns: z.array(z.string()).optional(),
});

const FileToolsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  basePath: z.string().default('./'),
  maxFileSizeBytes: z.number().int().positive().default(1_048_576), // 1MB
  deniedPatterns: z.array(z.string()).optional(), // regex patterns for blocked files
});

const ProcessToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxSessions: z.number().int().positive().default(10),
  finishedTtlMs: z.number().int().positive().default(600_000), // 10 min
  maxOutputChars: z.number().int().positive().default(200_000),
});

const BrowserToolsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  headless: z.boolean().default(true),
  executablePath: z.string().optional(),
  launchTimeout: z.number().int().positive().default(30_000),
  navigationTimeout: z.number().int().positive().default(30_000),
  actionTimeout: z.number().int().positive().default(10_000),
  idleTimeoutMs: z.number().int().positive().default(300_000), // 5 min auto-close
  screenshotDir: z.string().default('./data/screenshots'),
  maxSnapshotChars: z.number().int().positive().default(40_000),
  allowedUrlPatterns: z.array(z.string()).optional(),
  blockedUrlPatterns: z.array(z.string()).optional(),
  enableEvaluate: z.boolean().default(false),
  viewport: z.object({
    width: z.number().int().positive().default(1280),
    height: z.number().int().positive().default(720),
  }).default({}),
});

const DatetimeToolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timezone: z.string().default('America/Argentina/Buenos_Aires'),
  locale: z.string().default('es-AR'),
});

const WebToolsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  search: WebToolsSearchConfigSchema.optional(),
  fetch: WebToolsFetchConfigSchema.optional(),
  maxToolRounds: z.number().int().min(1).max(10).default(5),
});

const AutoRagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxResults: z.number().int().positive().default(3),
  minScore: z.number().min(0).max(1).default(0.25),
  maxContentChars: z.number().int().positive().default(2000),
}).default({});

const MemorySearchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  embeddingModel: z.string().default('nomic-embed-text'),
  embeddingDimensions: z.number().int().positive().default(768),
  chunkTargetTokens: z.number().int().positive().default(400),
  chunkOverlapTokens: z.number().int().positive().default(80),
  vectorWeight: z.number().min(0).max(1).default(0.7),
  keywordWeight: z.number().min(0).max(1).default(0.3),
  defaultMaxResults: z.number().int().positive().default(5),
  defaultMinScore: z.number().min(0).max(1).default(0.1),
  syncIntervalMs: z.number().int().positive().default(2000),
  dbPath: z.string().default('./data/memory.db'),
  concurrency: z.number().int().positive().default(3),
  watchEnabled: z.boolean().default(true),
  autoRag: AutoRagConfigSchema,
});

const MemoryFlushConfigSchema = z.object({
  enabled: z.boolean().default(true),
  messageThreshold: z.number().int().positive().default(30),
}).default({});

const SessionMemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  indexOnStartup: z.boolean().default(false),
}).default({});

const HealthCheckConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cooldownMs: z.number().int().positive().default(86_400_000), // 24h
  consolidateMemory: z.boolean().default(true),
}).default({});

const SoulConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default('./config/soul'),
  search: MemorySearchConfigSchema.default({}),
  memoryFlush: MemoryFlushConfigSchema,
  sessionMemory: SessionMemoryConfigSchema,
  versioning: z.object({
    enabled: z.boolean().default(true),
    maxVersionsPerFile: z.number().int().positive().default(10),
  }).default({}),
  healthCheck: HealthCheckConfigSchema,
});

const WhisperConfigSchema = z.object({
  endpoint: z.string(),
  model: z.string().default('whisper-1'),
  language: z.string().optional(),
  timeout: z.number().int().positive().default(60_000),
});

const MediaConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxFileSizeMb: z.number().positive().default(10),
  whisper: WhisperConfigSchema.optional(),
  supportedDocTypes: z.array(z.string()).optional(),
});

const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  storePath: z.string().default('./data/cron'),
});

const WebConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().positive().default(3000),
  host: z.string().default('127.0.0.1'),
});

const PhoneCallConfigSchema = z.object({
  enabled: z.boolean().default(false),
  accountSid: z.string(),
  authToken: z.string(),
  fromNumber: z.string(),
  defaultNumber: z.string().default(''),
  language: z.string().default('es-MX'),
  voice: z.string().default('Polly.Mia'),
  contactsFile: z.string().default('./data/contacts.json'),
});

const HumanizerConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

const ImproveToolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  claudePath: z.string().default('claude'),
  timeout: z.number().int().positive().max(300_000).default(120_000),
  maxOutputLength: z.number().int().positive().default(15_000),
  soulDir: z.string().default('./config/soul'),
  allowedFocus: z.array(z.string()).default(['memory', 'soul', 'motivations', 'identity', 'all']),
}).default({});

const CollaborationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxRounds: z.number().int().min(1).max(20).default(5),
  cooldownMs: z.number().int().min(0).default(30000),
  internalQueryTimeout: z.number().int().positive().default(60000),
  enableTargetTools: z.boolean().default(true),
  maxConverseTurns: z.number().int().min(1).max(10).default(3),
  sessionTtlMs: z.number().int().positive().default(600000),
  visibleMaxTurns: z.number().int().min(1).max(10).default(3),
}).default({});

const BufferConfigSchema = z
  .object({
    inboundDebounceMs: z.number().int().min(0).default(1500),
    queueDebounceMs: z.number().int().min(0).default(1000),
    queueCap: z.number().int().min(1).default(10),
  })
  .default({});

const LlmRelevanceCheckSchema = z
  .object({
    enabled: z.boolean().default(true),
    temperature: z.number().min(0).max(2).default(0.1),
    timeout: z.number().int().positive().default(5000),
    contextMessages: z.number().int().min(0).default(4),
    broadcastCheck: z.boolean().default(false),
    multiBotAware: z.boolean().default(false),
  })
  .default({});

const SessionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default('./data/sessions'),
  resetPolicy: z
    .object({
      daily: z
        .object({
          enabled: z.boolean().default(false),
          hour: z.number().int().min(0).max(23).default(4),
        })
        .default({}),
      idle: z
        .object({
          enabled: z.boolean().default(false),
          minutes: z.number().int().positive().default(60),
        })
        .default({}),
    })
    .default({}),
  groupActivation: z.enum(['mention', 'always']).default('mention'),
  replyWindow: z.number().int().min(0).default(0), // minutes; 0 = unlimited (never expires), >0 = expires after N minutes
  forumTopicIsolation: z.boolean().default(true),
  llmRelevanceCheck: LlmRelevanceCheckSchema,
});

const ProductionsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseDir: z.string().default('./productions'),
}).default({});

const ConfigSchema = z.object({
  bots: z.array(BotConfigSchema),
  ollama: OllamaConfigSchema,
  skills: SkillsConfigSchema,
  conversation: ConversationConfigSchema.default({}),
  exec: ExecToolConfigSchema.default({}),
  fileTools: FileToolsConfigSchema.default({}),
  processTools: ProcessToolConfigSchema.default({}),
  webTools: WebToolsConfigSchema.default({}),
  soul: SoulConfigSchema.default({}),
  media: MediaConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  datetime: DatetimeToolConfigSchema.default({}),
  cron: CronConfigSchema.default({}),
  phoneCall: PhoneCallConfigSchema.optional(),
  humanizer: HumanizerConfigSchema.default({}),
  improve: ImproveToolConfigSchema,
  collaboration: CollaborationConfigSchema,
  buffer: BufferConfigSchema,
  web: WebConfigSchema.default({}),
  agentLoop: GlobalAgentLoopConfigSchema,
  browserTools: BrowserToolsConfigSchema.default({}),
  dynamicTools: DynamicToolsConfigSchema,
  productions: ProductionsConfigSchema,
  logging: LoggingConfigSchema,
  paths: PathsConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type BotConfig = z.infer<typeof BotConfigSchema>;
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type PathsConfig = z.infer<typeof PathsConfigSchema>;
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
export type ConversationConfig = z.infer<typeof ConversationConfigSchema>;
export type WebToolsConfig = z.infer<typeof WebToolsConfigSchema>;
export type ExecToolConfig = z.infer<typeof ExecToolConfigSchema>;
export type FileToolsConfig = z.infer<typeof FileToolsConfigSchema>;
export type ProcessToolConfig = z.infer<typeof ProcessToolConfigSchema>;
export type SoulConfig = z.infer<typeof SoulConfigSchema>;
export type MemorySearchConfig = z.infer<typeof MemorySearchConfigSchema>;
export type AutoRagConfig = z.infer<typeof AutoRagConfigSchema>;
export type MediaConfig = z.infer<typeof MediaConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type DatetimeToolConfig = z.infer<typeof DatetimeToolConfigSchema>;
export type CronConfig = z.infer<typeof CronConfigSchema>;
export type PhoneCallConfig = z.infer<typeof PhoneCallConfigSchema>;
export type HumanizerConfig = z.infer<typeof HumanizerConfigSchema>;
export type ImproveToolConfig = z.infer<typeof ImproveToolConfigSchema>;
export type CollaborationConfig = z.infer<typeof CollaborationConfigSchema>;
export type BufferConfig = z.infer<typeof BufferConfigSchema>;
export type WebConfig = z.infer<typeof WebConfigSchema>;
export type AgentLoopConfig = z.infer<typeof GlobalAgentLoopConfigSchema>;
export type BotAgentLoopOverride = z.infer<typeof BotAgentLoopOverrideSchema>;
export type DynamicToolsConfig = z.infer<typeof DynamicToolsConfigSchema>;
export type MemoryFlushConfig = z.infer<typeof MemoryFlushConfigSchema>;
export type SessionMemoryConfig = z.infer<typeof SessionMemoryConfigSchema>;
export type LlmRelevanceCheckConfig = z.infer<typeof LlmRelevanceCheckSchema>;
export type BotConversationOverride = z.infer<typeof BotConversationOverrideSchema>;
export type ProductionsConfig = z.infer<typeof ProductionsConfigSchema>;
export type BotProductionsConfig = z.infer<typeof BotProductionsConfigSchema>;
export type BrowserToolsConfig = z.infer<typeof BrowserToolsConfigSchema>;
export type HealthCheckConfig = z.infer<typeof HealthCheckConfigSchema>;

/**
 * Substitute environment variables in strings
 * Supports ${VAR_NAME} syntax
 */
function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(`Environment variable ${varName} is not defined`);
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars);
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }

  return obj;
}

/**
 * Load and validate configuration from file
 */
export async function loadConfig(configPath: string): Promise<Config> {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const rawConfig = JSON.parse(content);

    // Substitute environment variables
    const configWithEnv = substituteEnvVars(rawConfig);

    // Validate against schema
    const config = ConfigSchema.parse(configWithEnv);

    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Configuration validation failed:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      throw new Error('Invalid configuration');
    }
    throw error;
  }
}

/**
 * Get skill-specific configuration
 */
export function getSkillConfig<T = unknown>(config: Config, skillId: string): T {
  return (config.skills.config[skillId] ?? {}) as T;
}

/**
 * Flat resolved configuration for a single agent, after merging global defaults
 * with per-agent overrides.
 */
export interface ResolvedAgentConfig {
  model: string;
  llmBackend?: 'ollama' | 'claude-cli';
  soulDir: string;
  workDir: string;
  systemPrompt: string;
  temperature: number;
  maxHistory: number;
}

/**
 * Merge global defaults with per-agent overrides to produce a flat config.
 * All new fields are optional in BotConfig, so existing configs work unchanged.
 */
export function resolveAgentConfig(globalConfig: Config, botConfig: BotConfig): ResolvedAgentConfig {
  return {
    model: botConfig.model ?? globalConfig.ollama.models.primary,
    llmBackend: botConfig.llmBackend,
    soulDir: botConfig.soulDir ?? `${globalConfig.soul.dir}/${botConfig.id}`,
    workDir: botConfig.workDir ?? `${globalConfig.productions?.baseDir ?? './productions'}/${botConfig.id}`,
    systemPrompt: botConfig.conversation?.systemPrompt ?? globalConfig.conversation.systemPrompt,
    temperature: botConfig.conversation?.temperature ?? globalConfig.conversation.temperature,
    maxHistory: botConfig.conversation?.maxHistory ?? globalConfig.conversation.maxHistory,
  };
}
