import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// Zod schemas for type-safe configuration
const BotConversationOverrideSchema = z
  .object({
    systemPrompt: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxHistory: z.number().int().positive().optional(),
  })
  .optional();

const StrategistConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    everyCycles: z.number().int().min(1).default(4),
    minInterval: z.string().default('4h'),
  })
  .default({});

export { CompactionConfigSchema };

export const AgentLoopRetryConfigSchema = z
  .object({
    maxRetries: z.number().int().min(0).max(10).default(2),
    initialDelayMs: z.number().int().min(1000).max(300_000).default(10_000),
    maxDelayMs: z.number().int().min(1000).max(600_000).default(60_000),
    backoffMultiplier: z.number().min(1).max(10).default(2),
  })
  .default({});

export const PhaseTimeoutsSchema = z
  .object({
    feedbackMs: z.number().int().positive().default(30_000),
    strategistMs: z.number().int().positive().default(60_000),
    plannerMs: z.number().int().positive().default(60_000),
    executorMs: z.number().int().positive().default(90_000),
  })
  .default({});

const KnownPollToolSchema = z.object({
  toolName: z.string(),
  actions: z.array(z.string()).optional(),
});

export const LoopDetectionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    historySize: z.number().int().min(5).max(200).default(30),
    warningThreshold: z.number().int().min(2).max(100).default(8),
    criticalThreshold: z.number().int().min(3).max(200).default(16),
    globalCircuitBreakerThreshold: z.number().int().min(5).max(500).default(25),
    detectors: z
      .object({
        genericRepeat: z.boolean().default(true),
        knownPollNoProgress: z.boolean().default(true),
        pingPong: z.boolean().default(true),
      })
      .default({}),
    knownPollTools: z
      .array(KnownPollToolSchema)
      .default([{ toolName: 'process', actions: ['poll', 'log', 'list'] }]),
  })
  .default({});

export const GlobalAgentLoopConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    every: z.string().default('6h'),
    minInterval: z.string().default('1m'),
    maxInterval: z.string().default('24h'),
    maxToolRounds: z.number().int().min(1).max(50).default(30),
    maxDurationMs: z.number().int().positive().default(300_000),
    maxConcurrent: z.number().int().min(1).max(10).default(2),
    claudeTimeout: z.number().int().positive().default(300_000),
    disabledTools: z.array(z.string()).optional(),
    /** Enable tool pre-selection: planner picks tool categories, executor only receives matching tools */
    toolPreSelection: z.boolean().default(true),
    idleSuppression: z.boolean().default(true),
    /** Number of non-idle cycles without ask_human before injecting a check-in nudge */
    askHumanCheckInCycles: z.number().int().min(1).max(50).default(5),
    /** Per-phase timeout limits for agent loop operations */
    phaseTimeouts: PhaseTimeoutsSchema,
    strategist: StrategistConfigSchema,
    retry: AgentLoopRetryConfigSchema,
    /** Tool loop detection for agent-loop executor phase */
    loopDetection: LoopDetectionConfigSchema,
    /** User awareness: scan sessions to show active users in planner prompt */
    userAwareness: z
      .object({
        enabled: z.boolean().default(false),
        activeWindowHours: z.number().min(1).max(168).default(24),
        maxUsers: z.number().int().min(1).max(20).default(5),
      })
      .default({}),
  })
  .default({});

export const BotAgentLoopOverrideSchema = z
  .object({
    reportChatId: z.number().optional(),
    every: z.string().optional(),
    claudeTimeout: z.number().int().positive().optional(),
    maxToolRounds: z.number().int().min(1).max(50).optional(),
    disabledTools: z.array(z.string()).optional(),
    mode: z.enum(['periodic', 'continuous']).default('periodic'),
    continuousPauseMs: z.number().int().min(0).default(5_000),
    continuousMemoryEvery: z.number().int().min(1).default(5),
    strategist: z
      .object({
        enabled: z.boolean().optional(),
        everyCycles: z.number().int().min(1).optional(),
        minInterval: z.string().optional(),
      })
      .optional(),
    retry: z
      .object({
        maxRetries: z.number().int().min(0).max(10).optional(),
        initialDelayMs: z.number().int().min(1000).max(300_000).optional(),
        maxDelayMs: z.number().int().min(1000).max(600_000).optional(),
        backoffMultiplier: z.number().min(1).max(10).optional(),
      })
      .optional(),
    phaseTimeouts: z
      .object({
        feedbackMs: z.number().int().positive().optional(),
        strategistMs: z.number().int().positive().optional(),
        plannerMs: z.number().int().positive().optional(),
        executorMs: z.number().int().positive().optional(),
      })
      .optional(),
    /** Per-bot agent loop enable/disable — undefined = inherit global setting */
    enabled: z.boolean().optional(),
    /** Standing directives: ongoing behavioral instructions injected into strategist/planner/executor prompts */
    directives: z.array(z.string().max(500)).max(10).optional(),
    /** Preset directive bundles — predefined behavioral instruction sets */
    presetDirectives: z
      .array(z.enum(['conversation-review']))
      .max(5)
      .optional(),
    loopDetection: z
      .object({
        enabled: z.boolean().optional(),
        historySize: z.number().int().min(5).max(200).optional(),
        warningThreshold: z.number().int().min(2).max(100).optional(),
        criticalThreshold: z.number().int().min(3).max(200).optional(),
        globalCircuitBreakerThreshold: z.number().int().min(5).max(500).optional(),
        detectors: z
          .object({
            genericRepeat: z.boolean().optional(),
            knownPollNoProgress: z.boolean().optional(),
            pingPong: z.boolean().optional(),
          })
          .optional(),
        knownPollTools: z.array(KnownPollToolSchema).optional(),
      })
      .optional(),
    userAwareness: z
      .object({
        enabled: z.boolean().optional(),
        activeWindowHours: z.number().min(1).max(168).optional(),
        maxUsers: z.number().int().min(1).max(20).optional(),
      })
      .optional(),
  })
  .optional();

const DynamicToolsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    storePath: z.string().default('./data/tools'),
    maxToolsPerBot: z.number().default(20),
  })
  .default({});

const AgentProposalsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    storePath: z.string().default('./data/agent-proposals'),
    maxAgents: z.number().default(20),
    maxProposalsPerBot: z.number().default(3),
  })
  .default({});

const SkillsFoldersConfigSchema = z
  .object({
    paths: z.array(z.string()).default([]),
  })
  .default({});

const BotTtsOverrideSchema = z
  .object({
    voiceId: z.string().optional(),
    modelId: z.string().optional(),
    outputFormat: z.string().optional(),
    languageCode: z.string().optional(),
    maxTextLength: z.number().int().positive().optional(),
    voiceSettings: z
      .object({
        stability: z.number().min(0).max(1).optional(),
        similarityBoost: z.number().min(0).max(1).optional(),
        style: z.number().min(0).max(1).optional(),
        useSpeakerBoost: z.boolean().optional(),
        speed: z.number().min(0.5).max(2).optional(),
      })
      .optional(),
  })
  .optional();

const BotProductionsConfigSchema = z
  .object({
    dir: z.string().optional(),
    trackOnly: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .optional();

const UserIsolationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    sharedCategories: z.array(z.string()).default(['identity', 'goals', 'constraints']),
  })
  .optional();

const UserIdentityVerificationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    required: z.boolean().default(false),
  })
  .optional();

const TopicGuardConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: z.string().optional(),
    botPurpose: z.string(),
    allowedTopics: z.array(z.string()).optional(),
    blockedTopics: z.array(z.string()).optional(),
    strictness: z.enum(['loose', 'moderate', 'strict']).default('moderate'),
    failOpen: z.boolean().default(true),
    customRejectMessage: z.string().optional(),
  })
  .optional();

export const BotConfigSchema = z.object({
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
  disabledSkills: z.array(z.string()).default([]),
  /** Per-bot max tool call rounds for conversation pipeline (overrides global webTools.maxToolRounds) */
  maxToolRounds: z.number().int().min(1).max(50).optional(),
  conversation: BotConversationOverrideSchema,
  agentLoop: BotAgentLoopOverrideSchema,
  tts: BotTtsOverrideSchema,
  productions: BotProductionsConfigSchema,
  userIsolation: UserIsolationConfigSchema,
  userIdentityVerification: UserIdentityVerificationConfigSchema,
  topicGuard: TopicGuardConfigSchema,
  allowedWritePaths: z.array(z.string()).optional(),
  // Multi-tenant hosting fields
  tenantId: z.string().optional(),
  apiKey: z.string().optional(),
  plan: z.enum(['free', 'starter', 'pro', 'enterprise']).default('free'),
  usageQuota: z
    .object({
      messagesPerMonth: z.number().int().positive().optional(),
      apiCallsPerMonth: z.number().int().positive().optional(),
      storageBytes: z.number().int().positive().optional(),
    })
    .optional(),
  billing: z
    .object({
      stripeCustomerId: z.string().optional(),
      stripeSubscriptionId: z.string().optional(),
      currentPeriodStart: z.string().datetime().optional(),
      currentPeriodEnd: z.string().datetime().optional(),
    })
    .optional(),
});

const OllamaConfigSchema = z.object({
  baseUrl: z.string().url(),
  timeout: z.number().int().positive().default(300_000),
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

const CompactionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    contextWindows: z
      .object({
        ollamaTokens: z.number().int().positive().default(8192),
        claudeCliTokens: z.number().int().positive().default(180_000),
      })
      .default({}),
    thresholdRatio: z.number().min(0.1).max(0.95).default(0.75),
    keepRecentMessages: z.number().int().min(2).default(6),
    maxMessageChars: z.number().int().positive().default(15_000),
    maxOverflowRetries: z.number().int().min(0).max(3).default(2),
  })
  .default({});

const ConversationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  systemPrompt: z.string().default('You are a helpful assistant.'),
  temperature: z.number().min(0).max(2).default(0.7),
  maxHistory: z.number().int().positive().default(20),
  compaction: CompactionConfigSchema,
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
  allowedPaths: z.array(z.string()).default([]), // extra read-only directories
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
  viewport: z
    .object({
      width: z.number().int().positive().default(1280),
      height: z.number().int().positive().default(720),
    })
    .default({}),
});

const DatetimeToolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timezone: z.string().default('America/Argentina/Buenos_Aires'),
  locale: z.string().default('es-AR'),
});

export const WebToolsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  search: WebToolsSearchConfigSchema.optional(),
  fetch: WebToolsFetchConfigSchema.optional(),
  maxToolRounds: z.number().int().min(1).max(50).default(5),
});

const AutoRagConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxResults: z.number().int().positive().default(3),
    minScore: z.number().min(0).max(1).default(0.25),
    maxContentChars: z.number().int().positive().default(2000),
  })
  .default({});

export const MMRConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    lambda: z.number().min(0).max(1).default(0.7),
  })
  .default({});

const MemorySearchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  embeddingModel: z.string().default(''),
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
  mmr: MMRConfigSchema,
});

const MemoryFlushConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    messageThreshold: z.number().int().positive().default(30),
  })
  .default({});

const SessionMemoryConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    indexOnStartup: z.boolean().default(false),
  })
  .default({});

const HealthCheckConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    cooldownMs: z.number().int().positive().default(86_400_000), // 24h
    consolidateMemory: z.boolean().default(true),
    llmBackend: z.enum(['ollama', 'claude-cli']).default('claude-cli'),
    model: z.string().optional(),
  })
  .default({});

const SoulConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default('./config/soul'),
  search: MemorySearchConfigSchema.default({}),
  memoryFlush: MemoryFlushConfigSchema,
  sessionMemory: SessionMemoryConfigSchema,
  versioning: z
    .object({
      enabled: z.boolean().default(true),
      maxVersionsPerFile: z.number().int().positive().default(10),
    })
    .default({}),
  healthCheck: HealthCheckConfigSchema,
});

const WhisperConfigSchema = z.object({
  endpoint: z.string(),
  model: z.string().default('whisper-1'),
  language: z.string().optional(),
  timeout: z.number().int().positive().default(60_000),
  apiKey: z.string().optional(),
});

const TtsConfigSchema = z.object({
  provider: z.enum(['elevenlabs']).default('elevenlabs'),
  apiKey: z.string(),
  voiceId: z.string().default('pMsXgVXv3BLzUgSXRplE'),
  modelId: z.string().default('eleven_multilingual_v2'),
  outputFormat: z.string().default('opus_48000_64'),
  languageCode: z.string().optional(),
  timeout: z.number().int().positive().default(30_000),
  maxTextLength: z.number().int().positive().default(1500),
  voiceSettings: z
    .object({
      stability: z.number().min(0).max(1).default(0.5),
      similarityBoost: z.number().min(0).max(1).default(0.75),
      style: z.number().min(0).max(1).default(0),
      useSpeakerBoost: z.boolean().default(true),
      speed: z.number().min(0.5).max(2).default(1),
    })
    .default({}),
});

const MediaConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxFileSizeMb: z.number().positive().default(10),
  whisper: WhisperConfigSchema.optional(),
  tts: TtsConfigSchema.optional(),
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

export const ClaudeCliConfigSchema = z
  .object({
    model: z.string().optional(),
  })
  .default({});

const ImproveToolConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    claudePath: z.string().default('claude'),
    timeout: z.number().int().positive().max(600_000).default(300_000),
    maxOutputLength: z.number().int().positive().default(15_000),
    soulDir: z.string().default('./config/soul'),
    allowedFocus: z.array(z.string()).default(['memory', 'soul', 'motivations', 'identity', 'all']),
  })
  .default({});

const CollaborationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxRounds: z.number().int().min(1).max(20).default(5),
    cooldownMs: z.number().int().min(0).default(30000),
    internalQueryTimeout: z.number().int().positive().default(60000),
    enableTargetTools: z.boolean().default(true),
    maxConverseTurns: z.number().int().min(1).max(10).default(3),
    sessionTtlMs: z.number().int().positive().default(600000),
    visibleMaxTurns: z.number().int().min(1).max(10).default(3),
  })
  .default({});

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

const ProductionsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    baseDir: z.string().default('./productions'),
  })
  .default({});

const ConversationsFeatureConfigSchema = z
  .object({
    baseDir: z.string().default('./data/conversations'),
  })
  .default({});

const KarmaConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    baseDir: z.string().default('./data/karma'),
    initialScore: z.number().default(50),
    decayDays: z.number().default(30),
    dedupCooldownMinutes: z.number().default(60),
  })
  .default({});

export const RedditConfigSchema = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string(),
  clientSecret: z.string(),
  username: z.string(),
  password: z.string(),
  userAgent: z.string().default('AIBot:aibot-framework:1.0 (by /u/aibot)'),
  cacheTtlMs: z.number().int().positive().default(300_000),
  timeout: z.number().int().positive().default(30_000),
});

export const TwitterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string(),
  apiSecret: z.string(),
  bearerToken: z.string(),
  accessToken: z.string().optional(),
  accessSecret: z.string().optional(),
  cacheTtlMs: z.number().int().positive().default(120_000),
  timeout: z.number().int().positive().default(30_000),
});

export const CalendarConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['calendly', 'google']),
  apiKey: z.string(),
  calendarId: z.string().optional(),
  defaultTimezone: z.string().default('America/Argentina/Buenos_Aires'),
  cacheTtlMs: z.number().int().positive().default(60_000),
  timeout: z.number().int().positive().default(30_000),
});

// ─── MCP Configuration ───

const McpServerEntrySchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  timeout: z.number().int().positive().default(30_000),
  autoReconnect: z.boolean().default(true),
  toolPrefix: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
});

const McpExposedServerSchema = z
  .object({
    enabled: z.boolean().default(false),
    transport: z.enum(['stdio', 'http']).default('http'),
    port: z.number().int().positive().default(3001),
    host: z.string().default('127.0.0.1'),
    exposedTools: z.array(z.string()).optional(),
    hiddenTools: z
      .array(z.string())
      .default(['exec', 'file_write', 'file_edit', 'process', 'create_tool']),
    authToken: z.string().optional(),
    maxCallsPerMinute: z.number().int().positive().default(60),
  })
  .default({});

export const McpConfigSchema = z
  .object({
    servers: z.array(McpServerEntrySchema).default([]),
    expose: McpExposedServerSchema,
  })
  .default({});

const MultiTenantConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    dataDir: z.string().default('./data/tenants'),
    stripe: z
      .object({
        secretKey: z.string(),
        webhookSecret: z.string(),
        priceIds: z
          .object({
            starter: z.string(),
            pro: z.string(),
            enterprise: z.string(),
          })
          .optional(),
      })
      .optional(),
  })
  .default({});

const ConfigSchema = z.object({
  bots: z.array(BotConfigSchema).default([]),
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
  claudeCli: ClaudeCliConfigSchema,
  improve: ImproveToolConfigSchema,
  collaboration: CollaborationConfigSchema,
  buffer: BufferConfigSchema,
  web: WebConfigSchema.default({}),
  agentLoop: GlobalAgentLoopConfigSchema,
  browserTools: BrowserToolsConfigSchema.default({}),
  dynamicTools: DynamicToolsConfigSchema,
  agentProposals: AgentProposalsConfigSchema,
  skillsFolders: SkillsFoldersConfigSchema,
  productions: ProductionsConfigSchema,
  conversations: ConversationsFeatureConfigSchema,
  karma: KarmaConfigSchema,
  mcp: McpConfigSchema,
  reddit: RedditConfigSchema.optional(),
  twitter: TwitterConfigSchema.optional(),
  calendar: CalendarConfigSchema.optional(),
  multiTenant: MultiTenantConfigSchema,
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
export type TtsConfig = z.infer<typeof TtsConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type DatetimeToolConfig = z.infer<typeof DatetimeToolConfigSchema>;
export type CronConfig = z.infer<typeof CronConfigSchema>;
export type PhoneCallConfig = z.infer<typeof PhoneCallConfigSchema>;
export type HumanizerConfig = z.infer<typeof HumanizerConfigSchema>;
export type ClaudeCliConfig = z.infer<typeof ClaudeCliConfigSchema>;
export type ImproveToolConfig = z.infer<typeof ImproveToolConfigSchema>;
export type CollaborationConfig = z.infer<typeof CollaborationConfigSchema>;
export type BufferConfig = z.infer<typeof BufferConfigSchema>;
export type WebConfig = z.infer<typeof WebConfigSchema>;
export type AgentLoopConfig = z.infer<typeof GlobalAgentLoopConfigSchema>;
export type AgentLoopRetryConfig = z.infer<typeof AgentLoopRetryConfigSchema>;
export type LoopDetectionConfig = z.infer<typeof LoopDetectionConfigSchema>;
export type BotAgentLoopOverride = z.infer<typeof BotAgentLoopOverrideSchema>;
export type DynamicToolsConfig = z.infer<typeof DynamicToolsConfigSchema>;
export type AgentProposalsConfig = z.infer<typeof AgentProposalsConfigSchema>;
export type MemoryFlushConfig = z.infer<typeof MemoryFlushConfigSchema>;
export type SessionMemoryConfig = z.infer<typeof SessionMemoryConfigSchema>;
export type LlmRelevanceCheckConfig = z.infer<typeof LlmRelevanceCheckSchema>;
export type BotConversationOverride = z.infer<typeof BotConversationOverrideSchema>;
export type BotTtsOverride = z.infer<typeof BotTtsOverrideSchema>;
export type ProductionsConfig = z.infer<typeof ProductionsConfigSchema>;
export type BotProductionsConfig = z.infer<typeof BotProductionsConfigSchema>;
export type BrowserToolsConfig = z.infer<typeof BrowserToolsConfigSchema>;
export type HealthCheckConfig = z.infer<typeof HealthCheckConfigSchema>;
export type KarmaConfig = z.infer<typeof KarmaConfigSchema>;
export type ConversationsFeatureConfig = z.infer<typeof ConversationsFeatureConfigSchema>;
export type RedditConfig = z.infer<typeof RedditConfigSchema>;
export type TwitterConfig = z.infer<typeof TwitterConfigSchema>;
export type CalendarConfig = z.infer<typeof CalendarConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type SkillsFoldersConfig = z.infer<typeof SkillsFoldersConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;
export type McpExposedServerConfig = z.infer<typeof McpExposedServerSchema>;
export type MMRConfig = z.infer<typeof MMRConfigSchema>;
export type UserIsolationConfig = z.infer<typeof UserIsolationConfigSchema>;
export type UserIdentityVerificationConfig = z.infer<typeof UserIdentityVerificationConfigSchema>;
export type TopicGuardConfig = z.infer<typeof TopicGuardConfigSchema>;
export type MultiTenantConfig = z.infer<typeof MultiTenantConfigSchema>;

/**
 * Substitute environment variables in strings
 * Supports ${VAR_NAME} syntax
 */
function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        console.warn(`Warning: Environment variable ${varName} is not defined, using empty string`);
        return '';
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
 * Derive the path to bots.json from the main config file path.
 */
export function botsPathFromConfigPath(configPath: string): string {
  return join(dirname(configPath), 'bots.json');
}

/**
 * Persist bots array to bots.json (sibling of configPath).
 */
export function persistBots(configPath: string, bots: BotConfig[]): void {
  const botsPath = botsPathFromConfigPath(configPath);
  writeFileSync(botsPath, `${JSON.stringify(bots, null, 2)}\n`, 'utf-8');
}

/**
 * Load and validate configuration from file.
 * Bots are loaded from a separate bots.json (sibling of configPath).
 * If bots.json doesn't exist but config.json contains a bots array,
 * they are auto-migrated to bots.json on first run.
 */
export async function loadConfig(configPath: string): Promise<Config> {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const rawConfig = JSON.parse(content);

    // Load bots from separate file, fall back to inline
    const botsPath = botsPathFromConfigPath(configPath);
    if (existsSync(botsPath)) {
      rawConfig.bots = JSON.parse(readFileSync(botsPath, 'utf-8'));
    } else if (Array.isArray(rawConfig.bots) && rawConfig.bots.length > 0) {
      // Auto-migrate: write bots.json, strip from config.json
      writeFileSync(botsPath, `${JSON.stringify(rawConfig.bots, null, 2)}\n`, 'utf-8');
      const rawClean = JSON.parse(content);
      rawClean.bots = undefined;
      writeFileSync(configPath, `${JSON.stringify(rawClean, null, 2)}\n`, 'utf-8');
      console.info(`[config] Migrated ${rawConfig.bots.length} bots → ${botsPath}`);
    }

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
export function resolveAgentConfig(
  globalConfig: Config,
  botConfig: BotConfig
): ResolvedAgentConfig {
  // When backend is claude-cli, default to claudeCli.model (not ollama's primary)
  const defaultModel =
    botConfig.llmBackend === 'claude-cli'
      ? (globalConfig.claudeCli?.model ?? 'claude')
      : globalConfig.ollama.models.primary;
  return {
    model: botConfig.model ?? defaultModel,
    llmBackend: botConfig.llmBackend,
    soulDir: botConfig.soulDir ?? `${globalConfig.soul.dir}/${botConfig.id}`,
    workDir:
      botConfig.workDir ??
      `${globalConfig.productions?.baseDir ?? './productions'}/${botConfig.id}`,
    systemPrompt: botConfig.conversation?.systemPrompt ?? globalConfig.conversation.systemPrompt,
    temperature: botConfig.conversation?.temperature ?? globalConfig.conversation.temperature,
    maxHistory: botConfig.conversation?.maxHistory ?? globalConfig.conversation.maxHistory,
  };
}

/**
 * Merge global → tenant → bot config.
 * Bot-level overrides win, then tenant-level, then global defaults.
 * Used when multi-tenant is enabled and a TenantConfig is available.
 *
 * When tenantId is provided, soulDir and workDir resolve to tenant-scoped paths
 * under the multiTenant.dataDir directory.
 */
export function resolveAgentConfigWithTenant(
  globalConfig: Config,
  tenantConfig:
    | {
        llmBackend?: string;
        model?: string;
        conversation?: { systemPrompt?: string; temperature?: number; maxHistory?: number };
      }
    | undefined,
  botConfig: BotConfig,
  tenantId?: string
): ResolvedAgentConfig {
  if (!tenantConfig && !tenantId) return resolveAgentConfig(globalConfig, botConfig);

  // Tenant-scoped paths when tenantId is provided
  const dataDir = globalConfig.multiTenant?.dataDir ?? './data/tenants';
  const defaultSoulDir = tenantId
    ? `${dataDir}/${tenantId}/bots/${botConfig.id}/soul`
    : `${globalConfig.soul.dir}/${botConfig.id}`;
  const defaultWorkDir = tenantId
    ? `${dataDir}/${tenantId}/bots/${botConfig.id}/productions`
    : `${globalConfig.productions?.baseDir ?? './productions'}/${botConfig.id}`;

  // Resolve llmBackend first so we can pick the right model default
  const resolvedBackend =
    botConfig.llmBackend ?? (tenantConfig?.llmBackend as 'ollama' | 'claude-cli' | undefined);
  const defaultModel =
    resolvedBackend === 'claude-cli'
      ? (globalConfig.claudeCli?.model ?? 'claude')
      : globalConfig.ollama.models.primary;

  return {
    model: botConfig.model ?? tenantConfig?.model ?? defaultModel,
    llmBackend: resolvedBackend,
    soulDir: botConfig.soulDir ?? defaultSoulDir,
    workDir: botConfig.workDir ?? defaultWorkDir,
    systemPrompt:
      botConfig.conversation?.systemPrompt ??
      tenantConfig?.conversation?.systemPrompt ??
      globalConfig.conversation.systemPrompt,
    temperature:
      botConfig.conversation?.temperature ??
      tenantConfig?.conversation?.temperature ??
      globalConfig.conversation.temperature,
    maxHistory:
      botConfig.conversation?.maxHistory ??
      tenantConfig?.conversation?.maxHistory ??
      globalConfig.conversation.maxHistory,
  };
}

/**
 * Merge global TTS config with per-bot overrides.
 * Only voice identity fields are overridable — apiKey and provider are global.
 */
export function resolveTtsConfig(globalTts: TtsConfig, botConfig: BotConfig): TtsConfig {
  const botOverride = botConfig.tts;
  if (!botOverride) return globalTts;
  return {
    ...globalTts,
    voiceId: botOverride.voiceId ?? globalTts.voiceId,
    modelId: botOverride.modelId ?? globalTts.modelId,
    outputFormat: botOverride.outputFormat ?? globalTts.outputFormat,
    languageCode: botOverride.languageCode ?? globalTts.languageCode,
    maxTextLength: botOverride.maxTextLength ?? globalTts.maxTextLength,
    voiceSettings: {
      stability: botOverride.voiceSettings?.stability ?? globalTts.voiceSettings.stability,
      similarityBoost:
        botOverride.voiceSettings?.similarityBoost ?? globalTts.voiceSettings.similarityBoost,
      style: botOverride.voiceSettings?.style ?? globalTts.voiceSettings.style,
      useSpeakerBoost:
        botOverride.voiceSettings?.useSpeakerBoost ?? globalTts.voiceSettings.useSpeakerBoost,
      speed: botOverride.voiceSettings?.speed ?? globalTts.voiceSettings.speed,
    },
  };
}
