import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { getPreset } from '../../bot/presets';
import type { BotConfig, Config } from '../../config';
import { persistBots, resolveAgentConfig } from '../../config';
import type { Logger } from '../../logger';
import { backupSoulFile } from '../../soul';
import { generateSoul as generateSoulDefault } from '../../soul-generator';
import { getTenantId, scopeBots } from '../../tenant/tenant-scoping';
import type { AgentProposal, AgentProposalStore } from '../../tools/agent-proposal-store';
import { serializeGoals } from '../../tools/goals';
import { agentProposalToWhy } from '../../why/builders/agent-proposal';
import { CycleIndex, type CycleReader } from '../../why/cycle-index';
import type { Why } from '../../why/types';

/**
 * "Why this?" for each proposal: one cycle-log read per proposing bot, then
 * `agentProposalToWhy`. A builder that throws leaves its proposal without one.
 */
export function withProposalWhy(
  proposals: AgentProposal[],
  read: CycleReader | undefined,
  logger: Logger
): Array<AgentProposal & { why?: Why }> {
  const cycles = CycleIndex.for(
    read,
    proposals.flatMap((p) => (p.cycleId ? [{ botId: p.proposedBy, at: p.createdAt }] : [])),
    (botId, err) => logger.warn({ err, botId }, 'agent-proposals: cycle log read failed')
  );
  return proposals.map((p) => {
    try {
      const cycle = p.cycleId ? cycles.byId(p.proposedBy, p.cycleId) : undefined;
      return { ...p, why: agentProposalToWhy({ proposal: p, cycle }) };
    } catch (err) {
      logger.warn({ err, id: p.id }, 'agent-proposals: why failed, skipping');
      return p;
    }
  });
}

const GOAL_NOTES_MAX = 500;

/**
 * GOALS.md for an approved proposal with goals (the mind's, from the
 * operator's brief): the operator approved them, so they are his
 * (`source: operator`, "Set by your operator" in the prompts). The first
 * carries what it serves and when to stop.
 */
export function proposalGoalsMarkdown(proposal: AgentProposal): string {
  // The kill criterion and the delivery go first: only the wants are clipped.
  const head = [
    proposal.killCriterion ? `Kill if: ${proposal.killCriterion}.` : '',
    proposal.delivery ? `Deliver via: ${proposal.delivery}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const serves = proposal.serves?.length
    ? `Serves: ${proposal.serves.map((s) => s.what).join('; ')}.`
    : '';
  // The head is never cut (vetting bounds it: ≤ 400 + 80 chars, under
  // goal-lint's 600); the wants get what is left of GOAL_NOTES_MAX.
  const room = GOAL_NOTES_MAX - head.length - (head ? 1 : 0);
  const notes = [head, room > 0 ? serves.slice(0, room) : ''].filter(Boolean).join(' ');
  const goals = (proposal.goals ?? []).map((text, i) => ({
    text,
    status: 'active',
    priority: i === 0 ? 'high' : 'medium',
    source: 'operator',
    ...(i === 0 && notes ? { notes } : {}),
  }));
  return `${serializeGoals(goals, [])}\n`;
}

export function agentProposalRoutes(deps: {
  store: AgentProposalStore;
  config: Config;
  configPath: string;
  logger: Logger;
  /** Agent-loop cycle rows of a bot (shared `readCycles` of server.ts): plan and goal for `why`. */
  readCycles?: CycleReader;
  /** The soul generator (tests); default the Claude CLI one. */
  generateSoul?: typeof generateSoulDefault;
}) {
  const generateSoul = deps.generateSoul ?? generateSoulDefault;
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
    return c.json(withProposalWhy(proposals, deps.readCycles, deps.logger));
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

    // A proposal of the mind (`src/watcher/roster/`): its deliverable and preset.
    const preset = getPreset(proposal.preset);
    if (proposal.deliverable) newBot.description = proposal.deliverable;
    if (preset) {
      newBot.preset = preset.id;
      newBot.disabledTools = [...preset.disabledTools];
    }

    deps.config.bots.push(newBot);
    persistBots(deps.configPath, deps.config.bots);

    // 2. Create soul directory + basic IDENTITY.md
    const soulDir = resolveAgentConfig(deps.config, newBot).soulDir;
    mkdirSync(join(soulDir, 'memory'), { recursive: true });
    if (proposal.goals?.length) {
      writeFileSync(join(soulDir, 'GOALS.md'), proposalGoalsMarkdown(proposal), 'utf-8');
    }
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
