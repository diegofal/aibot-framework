/**
 * Topic guardrail pre-filter.
 * Uses a cheap LLM call to classify whether a message is on-topic
 * before running the full conversation pipeline.
 * Pattern: same as GroupActivation.checkLlmRelevance() — fail-open on error/timeout.
 */
import type { Logger } from '../logger';
import type { BotContext } from './types';

export interface TopicGuardConfig {
  enabled: boolean;
  model?: string;
  botPurpose: string;
  allowedTopics?: string[];
  blockedTopics?: string[];
  strictness?: 'loose' | 'moderate' | 'strict';
  failOpen?: boolean;
  customRejectMessage?: string;
}

export interface TopicGuardResult {
  allowed: boolean;
  reason?: string;
}

export class TopicGuard {
  constructor(private ctx: BotContext) {}

  /**
   * Check if a message is on-topic for the bot's purpose.
   * Returns { allowed: true } for on-topic, { allowed: false, reason } for off-topic.
   * Fail-open by default: errors/timeouts return allowed: true.
   */
  async check(
    message: string,
    botId: string,
    config: TopicGuardConfig,
    logger: Logger
  ): Promise<TopicGuardResult> {
    // Skip very short messages (greetings, acks)
    if (message.trim().length < 5) {
      return { allowed: true };
    }

    const failOpen = config.failOpen !== false; // default true
    const strictness = config.strictness || 'moderate';

    try {
      const prompt = this.buildClassifierPrompt(message, config, strictness);

      const model = config.model || 'claude-haiku-4-5-20251001';
      const llmResult = await Promise.race([
        this.ctx.getLLMClient(botId).generate(prompt, {
          model,
          temperature: 0.1,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Topic guard timeout')), 5000)
        ),
      ]);

      const text = llmResult.text.trim();
      // Try to parse JSON response
      let onTopic = true;
      let reason: string | undefined;

      try {
        // Try JSON parse first
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          onTopic = parsed.on_topic === true || parsed.on_topic === 'true';
          reason = parsed.reason;
        } else {
          // Fallback: look for yes/no
          const lower = text.toLowerCase();
          onTopic =
            lower.includes('"on_topic": true') ||
            lower.includes('"on_topic":true') ||
            lower.startsWith('yes') ||
            lower.includes('"yes"');
        }
      } catch {
        // If JSON parse fails, look for simple yes/no
        const lower = text.toLowerCase();
        onTopic =
          !lower.startsWith('no') &&
          !lower.includes('"on_topic": false') &&
          !lower.includes('"on_topic":false');
      }

      logger.info(
        {
          botId,
          onTopic,
          reason,
          messagePreview: message.substring(0, 80),
        },
        'Topic guard result'
      );

      return onTopic ? { allowed: true } : { allowed: false, reason };
    } catch (err) {
      logger.warn({ err, botId }, `Topic guard failed, ${failOpen ? 'allowing' : 'blocking'}`);
      return failOpen ? { allowed: true } : { allowed: false, reason: 'guard_error' };
    }
  }

  private buildClassifierPrompt(
    message: string,
    config: TopicGuardConfig,
    strictness: string
  ): string {
    const parts: string[] = [
      'You are a topic classifier. Determine if the user message is on-topic for this bot.',
      '',
      `Bot purpose: ${config.botPurpose}`,
    ];

    if (config.allowedTopics && config.allowedTopics.length > 0) {
      parts.push(`Allowed topics: ${config.allowedTopics.join(', ')}`);
    }

    if (config.blockedTopics && config.blockedTopics.length > 0) {
      parts.push(`Blocked topics: ${config.blockedTopics.join(', ')}`);
    }

    parts.push('');

    if (strictness === 'loose') {
      parts.push(
        'Be lenient — only block messages that are clearly unrelated. Allow tangential topics and casual conversation.'
      );
    } else if (strictness === 'strict') {
      parts.push(
        'Be strict — only allow messages that are directly related to the bot purpose and allowed topics.'
      );
    } else {
      parts.push(
        'Be moderate — allow related topics and reasonable tangents, but block clearly off-topic messages.'
      );
    }

    parts.push('');
    parts.push(
      'Always allow: greetings, thanks, follow-up questions about previous responses, meta-questions about the bot.'
    );
    parts.push('');
    parts.push(`User message: ${message}`);
    parts.push('');
    parts.push(
      'Respond with ONLY a JSON object: {"on_topic": true/false, "reason": "brief explanation"}'
    );

    return parts.join('\n');
  }
}
