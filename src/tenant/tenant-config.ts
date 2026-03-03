import { z } from 'zod';

/**
 * Per-tenant configuration schema.
 * Configurable by each tenant: LLM backend/model, API keys (BYOK),
 * feature toggles, conversation defaults, branding.
 *
 * Merge order: global config → tenant config → bot config (bot wins).
 */
export const TenantConfigSchema = z.object({
  // LLM settings
  llmBackend: z.enum(['ollama', 'claude-cli']).optional(),
  model: z.string().optional(),

  // BYOK API keys (stored encrypted/masked in API responses)
  apiKeys: z
    .object({
      claudeApiKey: z.string().optional(),
      elevenLabsApiKey: z.string().optional(),
      braveSearchApiKey: z.string().optional(),
    })
    .default({}),

  // Conversation defaults
  conversation: z
    .object({
      systemPrompt: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxHistory: z.number().int().positive().optional(),
    })
    .default({}),

  // Feature toggles
  features: z
    .object({
      agentLoop: z.boolean().default(true),
      productions: z.boolean().default(true),
      collaborations: z.boolean().default(true),
      tts: z.boolean().default(false),
    })
    .default({}),

  // Branding
  branding: z
    .object({
      displayName: z.string().optional(),
      logoUrl: z.string().optional(),
    })
    .default({}),
});

export type TenantConfig = z.infer<typeof TenantConfigSchema>;

/** Default empty tenant config */
export function defaultTenantConfig(): TenantConfig {
  return TenantConfigSchema.parse({});
}
