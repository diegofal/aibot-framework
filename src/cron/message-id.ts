/**
 * Id of the synthetic message a cron instruction sends its agent:
 * `cron-<jobId>-<ms>-<rand>`. The `cron-` prefix keeps it out of the human
 * inbound signals (`isHumanInboundMessage`); the job id links the message (and
 * the reply it produced) back to the job and its run-log row (`messageId`).
 */
const CRON_ID_RE = /^cron-(.+)-(\d+)-([a-z0-9]+)$/;

export function cronMessageId(
  jobId: string,
  nowMs: number,
  rand: string = Math.random().toString(36).slice(2, 8) || '0'
): string {
  return `cron-${jobId}-${nowMs}-${rand}`;
}

/** The job id inside a cron message id; null for ids without one (older runs, other messages). */
export function cronJobIdFromMessageId(messageId: string): string | null {
  const m = CRON_ID_RE.exec(String(messageId ?? ''));
  if (!m) return null;
  const jobId = m[1];
  // Old ids were `cron-<ms>-<rand>`: nothing but the timestamp before the suffix.
  return /^\d+$/.test(jobId) ? null : jobId;
}
