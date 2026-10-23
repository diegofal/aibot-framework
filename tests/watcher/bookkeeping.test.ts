import { describe, expect, test } from 'bun:test';
import { isBookkeepingLine } from '../../src/watcher/birth';

describe('isBookkeepingLine (daily-log lines birth skips)', () => {
  const bookkeeping = [
    'ask_human 264a4318 enviada: el recordatorio ÚNICO del dry run GitHub t-cff5b1 …',
    'Pregunta enviada al operador sobre el presupuesto',
    '[agent-loop] Ran 3 tools, plan: research suppliers',
    '[ERROR] Claude CLI exited with code 1',
    'cron-8f2a1c-1729700000000-ab12 ran: daily digest',
    'send_proactive_message to operator: weekly summary',
    'task_progress: drafted section 2',
    't-cff5b1',
    'g-1a2b3c4d, t-00aa11',
    'https://example.com/report.pdf',
    '<https://a.example/x> https://b.example/y',
  ];
  for (const line of bookkeeping) {
    test(`skips: ${line}`, () => expect(isBookkeepingLine(line)).toBe(true));
  }

  const facts = [
    'The operator prefers suppliers in Rosario over Buenos Aires',
    'Ana asked for the invoice to be sent on Friday',
    'Acme raised prices 12% in October (source https://acme.example/prices)',
    'Goal g-1a2b3c4d is about the newsletter launch',
    'El cliente pidió humanizar el tono del sitio',
  ];
  for (const line of facts) {
    test(`keeps: ${line}`, () => expect(isBookkeepingLine(line)).toBe(false));
  }

  test('empty or whitespace is bookkeeping (nothing to keep)', () => {
    expect(isBookkeepingLine('')).toBe(true);
    expect(isBookkeepingLine('   ')).toBe(true);
  });
});
