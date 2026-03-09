import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import { getTenantId, scopeBots } from '../../tenant/tenant-scoping';

type DashboardDeps = {
  config: Config;
  botManager: BotManager;
  logger: Logger;
};

/**
 * Batched badge counts endpoint — replaces 4 individual polling calls
 * to stay within free-plan rate limits.
 */
export function dashboardRoutes(deps: DashboardDeps) {
  const app = new Hono();

  function getAllowedBotIds(c: import('hono').Context): Set<string> | undefined {
    const tenantId = getTenantId(c);
    if (!tenantId || !deps.config) return undefined;
    return new Set(scopeBots(deps.config.bots, tenantId).map((b) => b.id));
  }

  app.get('/badges', (c) => {
    const allowedIds = getAllowedBotIds(c);

    // ask-human count
    let askHuman = 0;
    const conversationsService = deps.botManager.getConversationsService();
    if (conversationsService) {
      for (const botId of conversationsService.getBotIds()) {
        if (allowedIds && !allowedIds.has(botId)) continue;
        askHuman += conversationsService.countByInboxStatus(botId, 'pending');
      }
    } else if (allowedIds) {
      const questions = deps.botManager.getAskHumanPending();
      askHuman = questions.filter((q) => allowedIds.has(q.botId)).length;
    } else {
      askHuman = deps.botManager.getAskHumanCount();
    }

    // agent-feedback count
    const agentFeedback = deps.botManager.getAgentFeedbackPendingCount();

    // ask-permission count
    let askPermission = 0;
    if (allowedIds) {
      const requests = deps.botManager.getPermissionsPending();
      askPermission = requests.filter((r) => allowedIds.has(r.botId)).length;
    } else {
      askPermission = deps.botManager.getPermissionsCount();
    }

    // agent-proposals count
    let agentProposals = 0;
    const proposalStore = deps.botManager.getAgentProposalStore();
    if (proposalStore) {
      let proposals = proposalStore.list();
      if (allowedIds) {
        proposals = proposals.filter((p) => allowedIds.has(p.proposedBy));
      }
      agentProposals = proposals.filter((p) => p.status === 'pending').length;
    }

    return c.json({ askHuman, agentFeedback, askPermission, agentProposals });
  });

  return app;
}
