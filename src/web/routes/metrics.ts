import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';

/**
 * Prometheus exposition endpoint at GET /metrics.
 *
 * Returns a text/plain payload in the Prometheus text format so a scrape
 * target can be pointed at `http://<host>:3000/metrics` without any extra
 * adapter. Intentionally public (no auth) — the same posture as /api/status
 * — because a scraper needs a stable, credential-free target, and the values
 * exposed here are operational counters, not user data.
 *
 * Metrics exposed:
 *   - aibot_uptime_seconds            (gauge)   process uptime
 *   - aibot_bots_configured           (gauge)   bots in the roster
 *   - aibot_bots_running              (gauge)   bots with an active poller
 *   - aibot_ask_human_pending         (gauge)   pending ask_human requests
 *   - aibot_ask_permission_pending    (gauge)   pending ask_permission requests
 *   - aibot_agent_feedback_pending    (gauge)   pending operator feedback items
 */
export function metricsRoutes(deps: { config: Config; botManager: BotManager }) {
  const app = new Hono();
  const startedAt = Date.now();

  app.get('/', (c) => {
    const configured = deps.config.bots.length;
    const running = deps.botManager.getBotIds().length;
    const askHuman = deps.botManager.getAskHumanCount();
    const askPermission = deps.botManager.getPermissionsCount();
    const agentFeedback = deps.botManager.getAgentFeedbackPendingCount();
    const uptime = Math.floor((Date.now() - startedAt) / 1000);

    const lines = [
      '# HELP aibot_uptime_seconds Process uptime in seconds.',
      '# TYPE aibot_uptime_seconds gauge',
      `aibot_uptime_seconds ${uptime}`,
      '',
      '# HELP aibot_bots_configured Number of bots in the roster.',
      '# TYPE aibot_bots_configured gauge',
      `aibot_bots_configured ${configured}`,
      '',
      '# HELP aibot_bots_running Number of bots with an active poller.',
      '# TYPE aibot_bots_running gauge',
      `aibot_bots_running ${running}`,
      '',
      '# HELP aibot_ask_human_pending Pending ask_human requests.',
      '# TYPE aibot_ask_human_pending gauge',
      `aibot_ask_human_pending ${askHuman}`,
      '',
      '# HELP aibot_ask_permission_pending Pending ask_permission requests.',
      '# TYPE aibot_ask_permission_pending gauge',
      `aibot_ask_permission_pending ${askPermission}`,
      '',
      '# HELP aibot_agent_feedback_pending Pending operator feedback items.',
      '# TYPE aibot_agent_feedback_pending gauge',
      `aibot_agent_feedback_pending ${agentFeedback}`,
      '',
    ];

    return new Response(lines.join('\n'), {
      headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
    });
  });

  return app;
}