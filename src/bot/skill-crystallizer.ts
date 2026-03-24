/**
 * Skill Crystallizer — Detects repeated successful multi-step tool sequences
 * and proposes crystallizing them into reusable dynamic tools.
 *
 * Analyzes tool audit logs for n-gram patterns. When a pattern exceeds
 * threshold, generates a tool proposal via the DynamicToolStore.
 */

import type { Logger } from '../logger';
import type { DynamicToolMeta, DynamicToolStore } from '../tools/dynamic-tool-store';
import type { RecentAction } from './agent-loop-utils';

// ── Types ──

export interface ToolSequencePattern {
  /** Ordered tool names in the sequence */
  tools: string[];
  /** Number of times this sequence appeared */
  count: number;
  /** Timestamp of most recent occurrence */
  lastSeen: number;
  /** Sample plan summaries associated with this pattern */
  sampleSummaries: string[];
}

export interface CrystallizationProposal {
  pattern: ToolSequencePattern;
  proposedName: string;
  proposedDescription: string;
  status: 'proposed' | 'submitted' | 'rejected';
}

// ── Constants ──

/** Minimum occurrences before a pattern is eligible */
const MIN_OCCURRENCES = 4;
/** Minimum n-gram size */
const MIN_NGRAM = 2;
/** Maximum n-gram size */
const MAX_NGRAM = 5;
/** Max proposals per bot per crystallization run */
const MAX_PROPOSALS_PER_RUN = 1;
/** Max total crystallized tools per bot */
const MAX_CRYSTALLIZED_PER_BOT = 5;
/** Tools that are safe to crystallize into automated sequences */
const SAFE_TOOL_PREFIXES = new Set([
  'web_search',
  'web_fetch',
  'memory_search',
  'file_read',
  'read_production_log',
  'get_datetime',
  'manage_goals',
  'list_files',
  'read_file',
]);
/** Tools that require human approval for crystallization */
const REQUIRES_APPROVAL = new Set([
  'file_write',
  'file_edit',
  'send_message',
  'send_proactive_message',
  'update_soul',
  'update_identity',
  'save_memory',
  'ask_human',
  'ask_permission',
]);

// ── Pattern Detection ──

/**
 * Extract tool-name n-grams from recent actions.
 * Returns patterns sorted by count (most frequent first).
 */
export function detectPatterns(
  recentActions: RecentAction[],
  windowMs = 7 * 24 * 3_600_000
): ToolSequencePattern[] {
  const cutoff = Date.now() - windowMs;
  const filtered = recentActions.filter((a) => a.timestamp >= cutoff && a.tools.length >= 2);

  // Extract n-grams of tool sequences from each action
  const ngramCounts = new Map<
    string,
    { count: number; lastSeen: number; tools: string[]; summaries: string[] }
  >();

  for (const action of filtered) {
    const tools = action.tools;
    for (let size = MIN_NGRAM; size <= Math.min(MAX_NGRAM, tools.length); size++) {
      for (let start = 0; start <= tools.length - size; start++) {
        const ngram = tools.slice(start, start + size);
        const key = ngram.join('→');

        const existing = ngramCounts.get(key);
        if (existing) {
          existing.count++;
          existing.lastSeen = Math.max(existing.lastSeen, action.timestamp);
          if (existing.summaries.length < 3) {
            existing.summaries.push(action.planSummary.slice(0, 80));
          }
        } else {
          ngramCounts.set(key, {
            count: 1,
            lastSeen: action.timestamp,
            tools: ngram,
            summaries: [action.planSummary.slice(0, 80)],
          });
        }
      }
    }
  }

  // Filter to patterns meeting threshold and sort by count
  const patterns: ToolSequencePattern[] = [];
  for (const [, data] of ngramCounts) {
    if (data.count >= MIN_OCCURRENCES) {
      patterns.push({
        tools: data.tools,
        count: data.count,
        lastSeen: data.lastSeen,
        sampleSummaries: data.summaries,
      });
    }
  }

  // Sort: longer sequences first (more specific), then by count
  patterns.sort((a, b) => {
    if (b.tools.length !== a.tools.length) return b.tools.length - a.tools.length;
    return b.count - a.count;
  });

  return patterns;
}

/**
 * Check if a tool sequence is safe to crystallize.
 * Returns true if all tools are read-only operations.
 */
export function isReadOnlySequence(tools: string[]): boolean {
  return tools.every((t) => {
    for (const prefix of SAFE_TOOL_PREFIXES) {
      if (t.startsWith(prefix)) return true;
    }
    return false;
  });
}

/**
 * Check if a tool sequence contains write operations that need approval.
 */
export function containsWriteOperations(tools: string[]): boolean {
  return tools.some((t) => {
    for (const prefix of REQUIRES_APPROVAL) {
      if (t.startsWith(prefix)) return true;
    }
    return false;
  });
}

/**
 * Generate a snake_case tool name from a sequence pattern.
 */
export function generateToolName(pattern: ToolSequencePattern): string {
  // Use the unique tool names in order, deduped
  const unique = [...new Set(pattern.tools)];
  const name = `crystallized_${unique.join('_then_')}`.slice(0, 60);
  return name.replace(/[^a-z0-9_]/g, '_');
}

/**
 * Generate a description for the crystallized tool.
 */
export function generateToolDescription(pattern: ToolSequencePattern): string {
  const steps = pattern.tools.map((t, i) => `${i + 1}. ${t}`).join(', ');
  const samples = pattern.sampleSummaries.slice(0, 2).join('; ');
  return `Crystallized sequence (${pattern.count}x observed): ${steps}. Example uses: ${samples}`.slice(
    0,
    200
  );
}

// ── SkillCrystallizer ──

export class SkillCrystallizer {
  /** botId → Set<toolName> of already-proposed tools (prevent re-proposing) */
  private proposedTools = new Map<string, Set<string>>();

  constructor(
    private dynamicToolStore: DynamicToolStore | null,
    private logger: Logger
  ) {}

  /**
   * Analyze recent actions and propose crystallized tools.
   * Returns proposals (at most MAX_PROPOSALS_PER_RUN per call).
   */
  analyze(botId: string, recentActions: RecentAction[]): CrystallizationProposal[] {
    if (!this.dynamicToolStore) return [];

    const patterns = detectPatterns(recentActions);
    if (patterns.length === 0) return [];

    // Check how many crystallized tools this bot already has
    const existing = this.dynamicToolStore
      .list()
      .filter(
        (t) => (t.scope === botId || t.scope === 'all') && t.name.startsWith('crystallized_')
      );
    if (existing.length >= MAX_CRYSTALLIZED_PER_BOT) {
      this.logger.debug({ botId, count: existing.length }, 'Crystallizer: max tools reached');
      return [];
    }

    // Track already-proposed for this bot
    let proposed = this.proposedTools.get(botId);
    if (!proposed) {
      proposed = new Set(existing.map((t) => t.name));
      this.proposedTools.set(botId, proposed);
    }

    const proposals: CrystallizationProposal[] = [];

    for (const pattern of patterns) {
      if (proposals.length >= MAX_PROPOSALS_PER_RUN) break;

      const name = generateToolName(pattern);
      if (proposed.has(name)) continue;

      // Skip if it contains dangerous tools (file_write, send_message, etc.)
      if (containsWriteOperations(pattern.tools) && !isReadOnlySequence(pattern.tools)) {
        this.logger.debug(
          { botId, name, tools: pattern.tools },
          'Crystallizer: skipping write-heavy pattern (requires manual approval)'
        );
        // Still record it as a proposal for the operator to see
        proposals.push({
          pattern,
          proposedName: name,
          proposedDescription: generateToolDescription(pattern),
          status: 'proposed',
        });
        proposed.add(name);
        continue;
      }

      proposals.push({
        pattern,
        proposedName: name,
        proposedDescription: generateToolDescription(pattern),
        status: 'proposed',
      });
      proposed.add(name);
    }

    return proposals;
  }

  /**
   * Submit a proposal to the DynamicToolStore for approval.
   * Generates a simple TypeScript tool wrapper.
   */
  submit(botId: string, proposal: CrystallizationProposal): DynamicToolMeta | null {
    if (!this.dynamicToolStore) return null;

    const source = generateToolSource(proposal);

    try {
      const meta = this.dynamicToolStore.create(
        {
          name: proposal.proposedName,
          description: proposal.proposedDescription,
          type: 'typescript',
          createdBy: `crystallizer:${botId}`,
          scope: botId,
          parameters: {
            input: {
              type: 'string',
              description: 'Input for the crystallized sequence',
              required: true,
            },
          },
        },
        source
      );

      this.logger.info(
        { botId, toolName: meta.name, pattern: proposal.pattern.tools },
        'Crystallizer: submitted tool proposal'
      );

      return meta;
    } catch (err) {
      this.logger.warn(
        { err, botId, toolName: proposal.proposedName },
        'Crystallizer: failed to submit'
      );
      return null;
    }
  }

  /**
   * Render crystallization context for the strategist prompt.
   */
  renderForPrompt(botId: string, recentActions: RecentAction[]): string | null {
    const patterns = detectPatterns(recentActions);
    if (patterns.length === 0) return null;

    const lines = ['## Crystallization Candidates'];
    lines.push('Repeated tool sequences detected that could become reusable tools:');
    for (const p of patterns.slice(0, 3)) {
      const readOnly = isReadOnlySequence(p.tools)
        ? '(read-only, auto-eligible)'
        : '(contains writes, needs approval)';
      lines.push(`- ${p.tools.join(' → ')} (${p.count}x) ${readOnly}`);
    }
    return lines.join('\n');
  }
}

// ── Source generation ──

function generateToolSource(proposal: CrystallizationProposal): string {
  const steps = proposal.pattern.tools.map((t, i) => `  // Step ${i + 1}: ${t}`).join('\n');

  return `/**
 * Auto-crystallized tool: ${proposal.proposedName}
 * Pattern: ${proposal.pattern.tools.join(' → ')} (observed ${proposal.pattern.count}x)
 * ${proposal.proposedDescription}
 */

// This tool was automatically proposed by the Skill Crystallizer.
// Review and approve via the dashboard before it becomes available.

${steps}

export default async function execute(args: { input: string }) {
  // TODO: Implement the crystallized sequence.
  // The operator should review and fill in the implementation.
  return { success: true, content: \`Crystallized sequence placeholder for: \${args.input}\` };
}
`;
}
