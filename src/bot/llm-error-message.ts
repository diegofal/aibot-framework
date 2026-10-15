/**
 * What a chat is told when the LLM call fails. The operator's chat gets the
 * detail (backend, HTTP status, the provider's own message, when a limit
 * resets, attempts); anyone else gets the reason and when, never internals.
 * Live (2026-10-15) a weekly Claude limit read "Failed to generate response.
 * Please try again later." and nobody could tell why.
 */
import { type LLMErrorInfo, classifyLLMError } from './llm-resilience';

/** The conversation's LLM call failed after its retries; carries the classified error. */
export class LLMCallFailedError extends Error {
  readonly info: LLMErrorInfo;
  readonly attempts: number;
  readonly backend?: string;

  constructor(info: LLMErrorInfo, opts: { attempts: number; backend?: string }) {
    super(`LLM call failed: ${info.message}`);
    this.name = 'LLMCallFailedError';
    this.info = info;
    this.attempts = opts.attempts;
    this.backend = opts.backend;
  }
}

interface ProviderFields {
  apiErrorStatus?: number;
  terminalReason?: string;
  resultText?: string;
  resetsAt?: Date;
  exitCode?: number;
}

const providerFields = (err: unknown): ProviderFields =>
  err && typeof err === 'object' ? (err as ProviderFields) : {};

function inWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const NOT_LOGGED_IN = /not logged in|please run \/login/i;

export function describeLLMFailure(
  error: unknown,
  opts: { detailed: boolean; nowMs?: number }
): string {
  const nowMs = opts.nowMs ?? Date.now();
  const failed = error instanceof LLMCallFailedError ? error : null;
  const info = failed?.info ?? classifyLLMError(error);
  const raw = providerFields(info.originalError);
  const message = error instanceof Error ? error.message : String(error);

  const resets =
    raw.resetsAt instanceof Date && raw.resetsAt.getTime() > nowMs
      ? ` It resets in ${inWords(raw.resetsAt.getTime() - nowMs)}.`
      : '';

  let headline: string;
  if (info.category === 'quota') {
    headline = `⏳ The AI account hit its usage limit, so I can't answer right now.${resets}`;
  } else if (NOT_LOGGED_IN.test(raw.resultText ?? info.message)) {
    headline = "❌ The AI backend is not logged in, so I can't answer right now.";
  } else if (message.includes('Circuit breaker is open')) {
    headline = '⏳ The AI service is temporarily overloaded. Please wait a moment and try again.';
  } else if (/timeout|timed out/i.test(message)) {
    headline = '⏱️ The request took too long. The service might be busy. Please try again.';
  } else if (/context length|too many tokens/i.test(message)) {
    headline = '📏 The conversation is too long. Try /reset to start fresh.';
  } else {
    headline = '❌ Failed to generate response. Please try again later.';
  }
  if (!opts.detailed) return headline;

  const facts = [
    failed?.backend,
    raw.apiErrorStatus ? `HTTP ${raw.apiErrorStatus}` : undefined,
    raw.terminalReason,
    info.category,
    failed ? `${failed.attempts} attempt${failed.attempts === 1 ? '' : 's'}` : undefined,
  ].filter(Boolean);
  const detail = (raw.resultText || info.message || message).replace(/\s+/g, ' ').slice(0, 400);
  const lines = [headline, '', `Detail: ${detail}`];
  if (facts.length > 0) lines.push(facts.join(' · '));
  if (NOT_LOGGED_IN.test(raw.resultText ?? info.message)) {
    lines.push('Fix: docker compose exec -it aibot claude auth login');
  } else if (info.category === 'quota') {
    lines.push('To keep going now: log the CLI into another account (claude auth login).');
  }
  return lines.join('\n');
}
