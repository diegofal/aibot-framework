import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotConfig, Config } from '../../config';
import { persistBots, resolveAgentConfig } from '../../config';
import type { Logger } from '../../logger';
import { backupSoulFile } from '../../soul';
import { generateSoul } from '../../soul-generator';
import { getTenantId, scopeBots } from '../../tenant/tenant-scoping';
import type { AgentProposal, AgentProposalStore } from '../../tools/agent-proposal-store';

export function agentProposalRoutes(deps: {
  store: AgentProposalStore;
  config: Config;
  configPath: string;
  logger: Logger;
}) {
  const app = new Hono();

  /** Filter proposals to only those from bots belonging to the requesting tenant */
  function filterByTenant(proposals: AgentProposal[], c: import('hono').Context): AgentProposal[] {
    const tenantId = getTenantId(c);
    if (!tenantId || tenantId === '__admin__') return proposals;
    const allowedIds = new Set(scopeBots(deps.config.bots, tenantId).map((b) => b.id));
    return proposals.filter((p) => allowedIds.has(p.proposedBy));
  }

  /** Check if a specific proposal is accessible to the requesting tenant */
  function isProposalAccessible(proposal: AgentProposal, c: import('hono').Context): boolean {
    const tenantId = getTenantId(c);
    if (!tenantId || tenantId === '__admin__') return true;
    const allowedIds = new Set(scopeBots(deps.config.bots, tenantId).map((b) => b.id));
    return allowedIds.has(proposal.proposedBy);
  }

  // List all proposals
  app.get('/', (c) => {
    const proposals = filterByTenant(deps.store.list(), c);
    return c.json(proposals);
  });

  // Pending count (for badge polling)
  app.get('/count', (c) => {
    const proposals = filterByTenant(deps.store.list(), c);
    const count = proposals.filter((p) => p.status === 'pending').length;
    return c.json({ count });
  });

  // Approve a proposal — triggers the creation pipeline
  app.post('/:id/approve', async (c) => {
    const id = c.req.param('id');
    const proposal = deps.store.get(id);

    if (!proposal || !isProposalAccessible(proposal, c)) {
      return c.json({ error: 'Proposal not found' }, 404);
    }

    if (proposal.status !== 'pending') {
      return c.json({ error: `Proposal is already ${proposal.status}` }, 400);
    }

    // Check no duplicate bot ID in current config
    if (deps.config.bots.some((b) => b.id === proposal.agentId)) {
      return c.json({ error: `An agent with id "${proposal.agentId}" already exists` }, 409);
    }

    // 1. Create BotConfig entry
    const newBot: BotConfig = {
      id: proposal.agentId,
      name: proposal.agentName,
      token: '',
      enabled: false,
      skills: proposal.skills,
      model: proposal.model,
      llmBackend: proposal.llmBackend,
      disabledSkills: [],
      plan: 'free',
    };

    if (proposal.agentLoop) {
      newBot.agentLoop = {
        mode: proposal.agentLoop.mode ?? 'periodic',
        continuousPauseMs: 5_000,
        continuousMemoryEvery: 5,
        every: proposal.agentLoop.every,
      };
    }

    deps.config.bots.push(newBot);
    persistBots(deps.configPath, deps.config.bots);

    // 2. Create soul directory + basic IDENTITY.md
    const soulDir = resolveAgentConfig(deps.config, newBot).soulDir;
    mkdirSync(join(soulDir, 'memory'), { recursive: true });
    writeFileSync(
      join(soulDir, 'IDENTITY.md'),
      `name: ${proposal.agentName}\nemoji: ${proposal.emoji || ''}\nvibe: ${proposal.role}\n`,
      'utf-8'
    );

    let soulGenerated = false;
    let soulError: string | undefined;

    // 3. Try to generate soul files via Claude CLI
    try {
      const result = await generateSoul(
        {
          name: proposal.agentName,
          role: proposal.role,
          personalityDescription: proposal.personalityDescription,
          language: proposal.language,
          emoji: proposal.emoji,
        },
        {
          soulDir: deps.config.soul.dir,
          claudeModel: deps.config.claudeCli?.model,
          logger: deps.logger,
        }
      );

      // 4. Apply generated soul files
      for (const filename of ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md'] as const) {
        const filepath = join(soulDir, filename);
        if (existsSync(filepath)) {
          backupSoulFile(filepath, deps.logger);
        }
      }

      writeFileSync(join(soulDir, 'IDENTITY.md'), result.identity, 'utf-8');
      writeFileSync(join(soulDir, 'SOUL.md'), result.soul, 'utf-8');
      writeFileSync(join(soulDir, 'MOTIVATIONS.md'), result.motivations, 'utf-8');

      // 5. Save baseline for reset
      const baselineDir = join(soulDir, '.baseline');
      mkdirSync(baselineDir, { recursive: true });
      writeFileSync(join(baselineDir, 'IDENTITY.md'), result.identity, 'utf-8');
      writeFileSync(join(baselineDir, 'SOUL.md'), result.soul, 'utf-8');
      writeFileSync(join(baselineDir, 'MOTIVATIONS.md'), result.motivations, 'utf-8');

      soulGenerated = true;
      deps.logger.info(
        { proposalId: id, agentId: proposal.agentId },
        'Agent created with generated soul'
      );
    } catch (err) {
      soulError = err instanceof Error ? err.message : String(err);
      deps.logger.warn(
        { proposalId: id, agentId: proposal.agentId, error: soulError },
        'Soul generation failed — agent created with basic IDENTITY.md'
      );
    }

    // 6. Update proposal status
    deps.store.updateStatus(id, 'approved');
    deps.store.updateApprovalResult(id, {
      configCreated: true,
      soulGenerated,
      soulDir,
      error: soulError,
    });

    const updated = deps.store.get(id);

    return c.json({
      proposal: updated,
      agent: { ...newBot, token: '' },
      soulGenerated,
      soulDir,
      error: soulError,
    });
  });

  // Reject a proposal
  app.post('/:id/reject', async (c) => {
    const id = c.req.param('id');
    const proposal = deps.store.get(id);

    if (!proposal || !isProposalAccessible(proposal, c)) {
      return c.json({ error: 'Proposal not found' }, 404);
    }

    if (proposal.status !== 'pending') {
      return c.json({ error: `Proposal is already ${proposal.status}` }, 400);
    }

    const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
    const updated = deps.store.updateStatus(id, 'rejected', body.note);

    deps.logger.info(
      { proposalId: id, agentId: proposal.agentId, note: body.note },
      'Agent proposal rejected'
    );

    return c.json(updated);
  });

  // Delete a proposal
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const proposal = deps.store.get(id);
    if (!proposal || !isProposalAccessible(proposal, c)) {
      return c.json({ error: 'Proposal not found' }, 404);
    }
    const deleted = deps.store.delete(id);
    if (!deleted) return c.json({ error: 'Proposal not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
