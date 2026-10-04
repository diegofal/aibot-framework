/**
 * Natural-language cron proposals (session S8 of docs/plans/jarvis-fleet-plan.md).
 * Pure functions only: the deterministic fallback parser, cron -> human text,
 * the LLM prompt and the validation of what the LLM sends back. No LLM here.
 */
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_FALLBACK_SCHEDULE,
  buildParsePrompt,
  composeProposal,
  cronToHuman,
  deterministicParse,
  isCronExpr,
  jobNameFor,
  mentionsOperator,
  parseLlmProposal,
  validateLlmProposal,
} from '../../src/cron/nl-parse';

const TZ = 'America/Argentina/Buenos_Aires';
const NOW = Date.UTC(2026, 8, 14, 15, 0, 0); // 12:00 in Buenos Aires
const noopLogger = { warn: () => {} };

describe('isCronExpr', () => {
  it('accepts a 5-field expression croner can schedule', () => {
    expect(isCronExpr('0 */3 * * *')).toBe(true);
    expect(isCronExpr('30 9 * * 1-5')).toBe(true);
    expect(isCronExpr('  0 9 * * *  ')).toBe(true);
  });

  it('rejects 6-field, short, non-string and unparsable expressions', () => {
    expect(isCronExpr('0 0 9 * * *')).toBe(false);
    expect(isCronExpr('9 * *')).toBe(false);
    expect(isCronExpr('')).toBe(false);
    expect(isCronExpr(undefined)).toBe(false);
    expect(isCronExpr(42)).toBe(false);
    expect(isCronExpr('99 99 * * *')).toBe(false);
    expect(isCronExpr('every 3 hours')).toBe(false);
  });
});

describe('cronToHuman', () => {
  it('reads the common shapes', () => {
    expect(cronToHuman('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronToHuman('* * * * *')).toBe('Every minute');
    expect(cronToHuman('0 */3 * * *')).toBe('Every 3 hours');
    expect(cronToHuman('30 */3 * * *')).toBe('Every 3 hours at :30');
    expect(cronToHuman('0 * * * *')).toBe('Every hour');
    expect(cronToHuman('15 * * * *')).toBe('Every hour at :15');
    expect(cronToHuman('0 9 * * *')).toBe('Every day at 09:00');
    expect(cronToHuman('30 18 * * 1')).toBe('Every Monday at 18:30');
    expect(cronToHuman('0 9 * * 1,3,5')).toBe('Every Monday, Wednesday and Friday at 09:00');
    expect(cronToHuman('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(cronToHuman('0 10 * * 6,0')).toBe('Weekends at 10:00');
    expect(cronToHuman('0 9 */2 * *')).toBe('Every 2 days at 09:00');
    expect(cronToHuman('0 8 1 * *')).toBe('On day 1 of every month at 08:00');
  });

  it('appends the timezone and falls back to the raw expression', () => {
    expect(cronToHuman('0 9 * * *', TZ)).toBe(`Every day at 09:00 (${TZ})`);
    expect(cronToHuman('5 4 * 2 *')).toBe('Cron "5 4 * 2 *"');
    expect(cronToHuman('garbage')).toBe('Cron "garbage"');
  });
});

describe('mentionsOperator', () => {
  it('spots "message me" / "tell me" / "let me know" and friends', () => {
    expect(mentionsOperator('check job boards every 3 hours and message me')).toBe(true);
    expect(mentionsOperator('Tell me the weather every morning')).toBe(true);
    expect(mentionsOperator('summarise the news and let me know')).toBe(true);
    expect(mentionsOperator('ping me at 9')).toBe(true);
    expect(mentionsOperator('report back to me weekly')).toBe(true);
  });

  it('is quiet otherwise', () => {
    expect(mentionsOperator('archive old sessions every day')).toBe(false);
    expect(mentionsOperator('')).toBe(false);
  });
});

describe('deterministicParse', () => {
  it('every N hours', () => {
    const r = deterministicParse('check job boards every 3 hours and message me');
    expect(r.matched).toBe(true);
    expect(r.schedule).toBe('0 */3 * * *');
    expect(r.instruction).toBe('Check job boards');
    expect(r.confidence).toBe('medium');
  });

  it('every N minutes, every minute, hourly', () => {
    expect(deterministicParse('poll the feed every 15 minutes').schedule).toBe('*/15 * * * *');
    expect(deterministicParse('poll the feed every 5 mins').schedule).toBe('*/5 * * * *');
    expect(deterministicParse('poll the feed every minute').schedule).toBe('* * * * *');
    expect(deterministicParse('poll the feed hourly').schedule).toBe('0 * * * *');
    expect(deterministicParse('poll the feed every hour').schedule).toBe('0 * * * *');
  });

  it('every day at HH:MM, with am/pm, noon and defaults', () => {
    expect(deterministicParse('summarise my inbox every day at 8:30').schedule).toBe('30 8 * * *');
    expect(deterministicParse('summarise my inbox daily at 6pm').schedule).toBe('0 18 * * *');
    expect(deterministicParse('summarise my inbox every day at 12 am').schedule).toBe('0 0 * * *');
    expect(deterministicParse('summarise my inbox at noon').schedule).toBe('0 12 * * *');
    expect(deterministicParse('summarise my inbox every morning').schedule).toBe('0 9 * * *');
    expect(deterministicParse('summarise my inbox every evening').schedule).toBe('0 18 * * *');
    expect(deterministicParse('summarise my inbox every night').schedule).toBe('0 21 * * *');
    expect(deterministicParse('summarise my inbox every day').schedule).toBe('0 9 * * *');
  });

  it('every monday at 9, weekdays, weekends, several days', () => {
    expect(deterministicParse('send the report every monday at 9').schedule).toBe('0 9 * * 1');
    expect(deterministicParse('send the report on fridays at 17:30').schedule).toBe('30 17 * * 5');
    expect(deterministicParse('send the report every weekday at 8').schedule).toBe('0 8 * * 1-5');
    expect(deterministicParse('send the report every weekend').schedule).toBe('0 9 * * 6,0');
    expect(deterministicParse('send the report every monday and thursday at 10am').schedule).toBe(
      '0 10 * * 1,4'
    );
  });

  it('every N days, weekly, monthly', () => {
    expect(deterministicParse('clean the workspace every 2 days at 7').schedule).toBe(
      '0 7 */2 * *'
    );
    expect(deterministicParse('clean the workspace every 2 days').schedule).toBe('0 9 */2 * *');
    expect(deterministicParse('clean the workspace weekly').schedule).toBe('0 9 * * 1');
    expect(deterministicParse('clean the workspace every month').schedule).toBe('0 9 1 * *');
  });

  it('takes a literal cron expression verbatim with high confidence', () => {
    const r = deterministicParse('run the digest 0 7 * * 1-5');
    expect(r.schedule).toBe('0 7 * * 1-5');
    expect(r.confidence).toBe('high');
    expect(r.instruction).toBe('Run the digest');
  });

  it('strips the delivery phrase from the instruction', () => {
    expect(deterministicParse('check job boards every 3 hours and message me').instruction).toBe(
      'Check job boards'
    );
    expect(deterministicParse('every morning tell me the weather').instruction).toBe('The weather');
    expect(deterministicParse('review the PRs at 9 and let me know').instruction).toBe(
      'Review the PRs'
    );
  });

  it('falls back to a daily default with low confidence when no schedule is found', () => {
    const r = deterministicParse('watch the competitors');
    expect(r.matched).toBe(false);
    expect(r.schedule).toBe(DEFAULT_FALLBACK_SCHEDULE);
    expect(r.confidence).toBe('low');
    expect(r.instruction).toBe('Watch the competitors');
  });

  it('keeps the whole text as the instruction when stripping leaves nothing', () => {
    const r = deterministicParse('every 3 hours');
    expect(r.instruction).toBe('every 3 hours');
  });
});

describe('buildParsePrompt', () => {
  it('names the agent, the timezone, the current time and the JSON contract', () => {
    const p = buildParsePrompt({
      text: 'check job boards every 3 hours and message me',
      botId: 'hunter',
      botName: 'Hunter',
      tz: TZ,
      nowIso: '2026-09-14T12:00:00-03:00',
      operatorConfigured: true,
    });
    expect(p).toContain(TZ);
    expect(p).toContain('Hunter');
    expect(p).toContain('2026-09-14T12:00:00-03:00');
    expect(p).toContain('"schedule"');
    expect(p).toContain('"operator"');
    expect(p).toContain('check job boards every 3 hours and message me');
  });

  it('warns the model when no operator chat is configured', () => {
    const p = buildParsePrompt({
      text: 'x',
      botId: 'b',
      botName: 'B',
      tz: TZ,
      nowIso: 'now',
      operatorConfigured: false,
    });
    expect(p.toLowerCase()).toContain('no operator');
  });
});

describe('validateLlmProposal', () => {
  it('accepts the documented shape and normalises confidence/warnings', () => {
    const v = validateLlmProposal({
      schedule: '0 */3 * * *',
      instruction: 'Check job boards',
      chatId: 'operator',
      confidence: 'HIGH',
      explanation: 'Every three hours.',
      warnings: ['one', 2, null],
    });
    expect(v).toEqual({
      schedule: '0 */3 * * *',
      instruction: 'Check job boards',
      chatId: 'operator',
      confidence: 'high',
      explanation: 'Every three hours.',
      warnings: ['one'],
    });
  });

  it('rejects a bad cron, an empty instruction or a non-object', () => {
    expect(validateLlmProposal(null)).toBeNull();
    expect(validateLlmProposal('0 9 * * *')).toBeNull();
    expect(validateLlmProposal({ schedule: '0 0 9 * * *', instruction: 'x' })).toBeNull();
    expect(validateLlmProposal({ schedule: '0 9 * * *', instruction: '' })).toBeNull();
    expect(validateLlmProposal({ instruction: 'x' })).toBeNull();
  });

  it('keeps a numeric chatId, drops anything else, defaults confidence to medium', () => {
    expect(validateLlmProposal({ schedule: '0 9 * * *', instruction: 'x', chatId: -100 })).toEqual(
      expect.objectContaining({ chatId: -100, confidence: 'medium' })
    );
    expect(
      validateLlmProposal({ schedule: '0 9 * * *', instruction: 'x', chatId: 'bob' })?.chatId
    ).toBeUndefined();
  });
});

describe('parseLlmProposal', () => {
  it('reads fenced JSON and prose-wrapped JSON', () => {
    const fenced = '```json\n{"schedule":"0 9 * * *","instruction":"Say hi"}\n```';
    expect(parseLlmProposal(fenced, noopLogger)?.schedule).toBe('0 9 * * *');
    const prose = 'Sure! Here it is: {"schedule":"0 9 * * *","instruction":"Say hi"} Done.';
    expect(parseLlmProposal(prose, noopLogger)?.instruction).toBe('Say hi');
  });

  it('returns null on garbage', () => {
    expect(parseLlmProposal('I cannot do that.', noopLogger)).toBeNull();
    expect(parseLlmProposal('', noopLogger)).toBeNull();
  });
});

describe('jobNameFor', () => {
  it('trims and caps the instruction', () => {
    expect(jobNameFor('Check job boards')).toBe('Check job boards');
    expect(jobNameFor(`${'a'.repeat(80)} tail`)).toHaveLength(60);
    expect(jobNameFor('')).toBe('Automation');
  });
});

describe('composeProposal', () => {
  const base = {
    text: 'check job boards every 3 hours and message me',
    botId: 'hunter',
    tz: TZ,
    nowMs: NOW,
    operator: { telegramChatId: 4242 },
  };

  it('builds the LLM proposal into the API shape with the operator resolved', () => {
    const p = composeProposal({
      ...base,
      llm: {
        schedule: '0 */3 * * *',
        instruction: 'Check job boards for new roles',
        chatId: 'operator',
        confidence: 'high',
        explanation: 'Every three hours, report to you.',
        warnings: [],
      },
    });
    expect(p.source).toBe('llm');
    expect(p.schedule).toBe('0 */3 * * *');
    expect(p.tz).toBe(TZ);
    expect(p.scheduleHuman).toBe(`Every 3 hours (${TZ})`);
    expect(p.instruction).toBe('Check job boards for new roles');
    expect(p.botId).toBe('hunter');
    expect(p.chatId).toBe('operator');
    expect(p.operatorChatId).toBe(4242);
    expect(p.confidence).toBe('high');
    expect(p.name).toBe('Check job boards for new roles');
    expect(p.warnings).toEqual([]);
    expect(p.nextRunAt).toBe('2026-09-14T18:00:00.000Z'); // 15:00 BA = next multiple of 3h
  });

  it('uses the deterministic parser when there is no LLM proposal and says why', () => {
    const p = composeProposal({ ...base, llm: null, llmNote: 'Agent is not running' });
    expect(p.source).toBe('fallback');
    expect(p.schedule).toBe('0 */3 * * *');
    expect(p.instruction).toBe('Check job boards');
    expect(p.confidence).toBe('medium');
    expect(p.warnings.some((w) => w.includes('Agent is not running'))).toBe(true);
  });

  it('warns when the operator chat is not configured and the target is the operator', () => {
    const p = composeProposal({ ...base, operator: {}, llm: null });
    expect(p.chatId).toBe('operator');
    expect(p.operatorChatId).toBeNull();
    expect(p.warnings.some((w) => /operator/i.test(w) && /chat/i.test(w))).toBe(true);
  });

  it('accepts a numeric chatId from the LLM only when the text itself carries it', () => {
    const invented = composeProposal({
      ...base,
      llm: {
        schedule: '0 9 * * *',
        instruction: 'x',
        chatId: -100999,
        confidence: 'high',
        explanation: '',
        warnings: [],
      },
    });
    expect(invented.chatId).toBe('operator');
    expect(invented.warnings.some((w) => /chat id/i.test(w))).toBe(true);

    const quoted = composeProposal({
      ...base,
      text: 'post the digest to chat -100999 every day at 9',
      llm: {
        schedule: '0 9 * * *',
        instruction: 'Post the digest',
        chatId: -100999,
        confidence: 'high',
        explanation: '',
        warnings: [],
      },
    });
    expect(quoted.chatId).toBe(-100999);
  });

  it('flags a disagreement between the LLM and a confident built-in reading', () => {
    const p = composeProposal({
      ...base,
      llm: {
        schedule: '0 9 * * *',
        instruction: 'Check job boards',
        chatId: 'operator',
        confidence: 'high',
        explanation: '',
        warnings: [],
      },
    });
    expect(p.schedule).toBe('0 9 * * *');
    expect(p.warnings.some((w) => w.includes('Every 3 hours'))).toBe(true);
  });

  it('marks a low-confidence default when neither side found a schedule', () => {
    const p = composeProposal({ ...base, text: 'watch the competitors', llm: null });
    expect(p.schedule).toBe(DEFAULT_FALLBACK_SCHEDULE);
    expect(p.confidence).toBe('low');
    expect(p.warnings.some((w) => /schedule/i.test(w))).toBe(true);
  });
});
