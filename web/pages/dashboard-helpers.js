/**
 * Pure pieces of the Agent loop page (`dashboard.js`), testable without a DOM
 * (`tests/web/dashboard-helpers.test.ts`).
 */

/** Activity cell of the bot schedules table. Static markup: no user text. */
export function activityCell(isExecuting) {
  return isExecuting
    ? '<span class="loop-activity"><span class="processing-pulse"></span> Executing</span>'
    : '<span class="text-dim">Idle</span>';
}

/** Label next to the All / None links of the "Run" column. */
export function selectionSummary(selected, total) {
  const n = Number(selected) || 0;
  const t = Number(total) || 0;
  if (n === 0) return 'None selected — Run Now runs every running bot';
  if (t > 0 && n >= t) return `All ${t} selected`;
  return `${n} of ${t} selected`;
}

/** Error text when `/api/agent-loop` did not return a loop state, else null. */
export function loopStateError(res) {
  if (!res || typeof res !== 'object') return 'No response from /api/agent-loop';
  if (res.error) return String(res.error);
  return null;
}
