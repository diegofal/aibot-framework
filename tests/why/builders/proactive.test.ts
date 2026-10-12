import { describe, expect, it } from 'bun:test';
import type { ToolAuditEntry } from '../../../src/bot/tool-audit-log';
import {
  type ProactiveSend,
  describeThrottle,
  proactiveFromAudit,
  proactiveToWhy,
} from '../../../src/why/builders/proactive';
import { WhySchema } from '../../../src/why/types';

const send = (over: Partial<ProactiveSend> = {}): ProactiveSend => ({
  botId: 'b1',
  sentAt: '2026-10-11T12:01:00Z',
  recipient: 'operator',
  toOperator: true,
  message: 'Synthetic: three new roles match your filters.',
  status: 'delivered',
  result: 'Message sent to the operator (chat 1)',
  ...over,
});

const row = {
  cycleId: 'c-1',
  startedAt: '2026-10-11T12:00:00Z',
  endedAt: '2026-10-11T12:05:00Z',
  planSummary: 'Check the job boards and tell the operator',
  goalId: 'g-1',
  goalTitle: 'Find remote roles',
};

const audit = (over: Partial<ToolAuditEntry> = {}): ToolAuditEntry => ({
  timestamp: '2026-10-11T12:01:00.000Z',
  botId: 'b1',
  chatId: 0,
  toolName: 'send_proactive_message',
  args: { chatId: 'operator', message: 'Synthetic hello' },
  success: true,
  result: 'Message sent to the operator (chat 1)',
  durationMs: 10,
  retryAttempts: 0,
  ...over,
});

const isOp = (raw: string) => raw === 'operator';

describe('proactiveFromAudit', () => {
  it('maps a delivered send to the operator', () => {
    const s = proactiveFromAudit(audit({ cycleId: 'c-1', goalId: 'g-1' }), isOp);
    expect(s).toEqual({
      botId: 'b1',
      sentAt: '2026-10-11T12:01:00.000Z',
      recipient: 'operator',
      toOperator: true,
      message: 'Synthetic hello',
      status: 'delivered',
      result: 'Message sent to the operator (chat 1)',
      cycleId: 'c-1',
      goalId: 'g-1',
    });
  });

  it('a policy failure is a throttle refusal; any other failure is a failure', () => {
    expect(
      proactiveFromAudit(audit({ success: false, failureKind: 'policy', result: 'x' }), isOp)
        ?.status
    ).toBe('refused');
    expect(
      proactiveFromAudit(audit({ success: false, result: 'Failed to send: boom' }), isOp)?.status
    ).toBe('failed');
  });

  it('a non-operator recipient keeps its id; other tools are not proactive sends', () => {
    const s = proactiveFromAudit(audit({ args: { chatId: ' 12345 ', message: 'm' } }), isOp);
    expect(s?.recipient).toBe('12345');
    expect(s?.toOperator).toBe(false);
    expect(proactiveFromAudit(audit({ toolName: 'ask_human' }), isOp)).toBeNull();
  });
});

describe('describeThrottle', () => {
  it('reads the per-bot cooldown', () => {
    const t = describeThrottle(
      'Proactive send throttled: b1 may send again at 2026-10-11T13:00:00.000Z. Per-bot cooldown 60m.'
    );
    expect(t.rule).toBe('One proactive message per agent every 60 min.');
    expect(t.retryAt).toBe('2026-10-11T13:00:00.000Z');
  });

  it('reads the fleet cap', () => {
    const t = describeThrottle(
      'Proactive send throttled: b1 may send again at 2026-10-12T09:00:00.000Z. Fleet cap 10/24h, used 10.'
    );
    expect(t.rule).toBe(
      'At most 10 proactive messages per 24 h across the fleet (10 already sent).'
    );
  });

  it('an unknown reason yields no rule', () => {
    expect(describeThrottle('nope')).toEqual({});
  });
});

describe('proactiveToWhy', () => {
  it('delivered to you, with its recorded cycle and goal', () => {
    const why = proactiveToWhy(send({ cycleId: 'c-1', goalId: 'g-1', cycle: row }));
    expect(WhySchema.safeParse(why).success).toBe(true);
    expect(why.what).toBe('A message it chose to send you');
    expect(why.by).toBe('agent');
    expect(why.cycle).toEqual({
      id: 'c-1',
      botId: 'b1',
      startedAt: '2026-10-11T12:00:00Z',
      plan: 'Check the job boards and tell the operator',
    });
    expect(why.goal).toEqual({ id: 'g-1', title: 'Find remote roles' });
    expect(why.outcome).toBe('Delivered to you on Telegram.');
    expect(why.missing).toBeUndefined();
  });

  it('a cycle id without a cycle-log row still links the cycle', () => {
    const why = proactiveToWhy(send({ cycleId: 'c-9' }));
    expect(why.cycle).toEqual({ id: 'c-9', botId: 'b1' });
    expect(why.goal).toBeUndefined();
  });

  it('no cycle recorded: says so', () => {
    const why = proactiveToWhy(send());
    expect(why.cycle).toBeUndefined();
    expect(why.missing).toContain('No record of the cycle');
  });

  it('refused by the throttle: rule and outcome', () => {
    const why = proactiveToWhy(
      send({
        status: 'refused',
        result:
          'Proactive send throttled: b1 may send again at 2026-10-11T13:00:00.000Z. Per-bot cooldown 60m.',
      })
    );
    expect(why.rule).toBe('One proactive message per agent every 60 min.');
    expect(why.outcome).toBe(
      'Not sent: the throttle refused it. It could send again at 2026-10-11 13:00 UTC.'
    );
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('failed delivery and a message to someone else', () => {
    const why = proactiveToWhy(
      send({
        recipient: '12345',
        toOperator: false,
        status: 'failed',
        result: 'Failed to send: chat not found',
      })
    );
    expect(why.what).toBe('A message it chose to send to 12345');
    expect(why.outcome).toBe('Not sent: Failed to send: chat not found');
  });

  it('queued for a web user and Telegram to another chat', () => {
    expect(
      proactiveToWhy(
        send({
          recipient: 'u-1',
          toOperator: false,
          result: 'Message queued for user u-1 (visible on reconnect)',
        })
      ).outcome
    ).toBe("Queued in u-1's web chat; they see it when they reconnect.");
    expect(
      proactiveToWhy(
        send({ recipient: '42', toOperator: false, result: 'Message sent to chat 42' })
      ).outcome
    ).toBe('Delivered to chat 42 on Telegram.');
  });
});
