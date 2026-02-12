import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Zod schemas for type-safe configuration
const BotConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  enabled: z.boolean().default(true),
  allowedUsers: z.array(z.number()).optional(),
  skills: z.array(z.string()),
  mentionPatterns: z.array(z.string()).optional(),
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
});

const SoulConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default('./config/soul'),
  memoryMaxChars: z.number().int().positive().default(8000),
  search: MemorySearchConfigSchema.default({}),
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

const BufferConfigSchema = z
  .object({
    inboundDebounceMs: z.number().int().min(0).default(1500),
    queueDebounceMs: z.number().int().min(0).default(1000),
    queueCap: z.number().int().min(1).default(10),
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
});

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
  buffer: BufferConfigSchema,
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
export type MediaConfig = z.infer<typeof MediaConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type DatetimeToolConfig = z.infer<typeof DatetimeToolConfigSchema>;
export type CronConfig = z.infer<typeof CronConfigSchema>;
export type BufferConfig = z.infer<typeof BufferConfigSchema>;

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
