import type { EnvRequirement } from './config-sanitizer';

/**
 * Bundle schema version. Shares the `EXPORT_VERSION` convention of the per-bot
 * exporter (`src/bot/bot-export-service.ts`) rather than inventing a second
 * scheme: the system manifest records the per-bot version it nests under
 * `agents/` so a reader can tell the two apart and validate both.
 */
export const SYSTEM_EXPORT_VERSION = 1;

/** Discriminator so a per-bot archive and a system bundle can never be confused. */
export const SYSTEM_EXPORT_KIND = 'aibot-system-export';

/**
 * Restorable subsets of a bundle.
 *
 * - `config` — global `config/config.json` only (sanitized).
 * - `agents` — the bot roster (`config/bots.json`) plus one nested per-bot
 *   bundle per agent: soul, core memory, productions, conversations, karma
 *   and Telegram sessions (all included by default). The roster travels with the agents, not with the
 *   config, because "move my agents to a fresh install" must not overwrite the
 *   target's global settings.
 * - `data` — cron jobs, sessions, dynamic tools, agent proposals, karma,
 *   contacts.
 * - `tenants` — the tenant/billing tree, minus per-bot soul directories that
 *   the `agents` section already carries.
 */
export type SystemSection = 'config' | 'agents' | 'data' | 'tenants';

export const ALL_SECTIONS: readonly SystemSection[] = ['config', 'agents', 'data', 'tenants'];

export function parseSections(input: string | string[] | undefined): SystemSection[] {
  if (input === undefined) return [...ALL_SECTIONS];
  const raw = Array.isArray(input) ? input : input.split(',');
  const requested = raw.map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (requested.length === 0 || requested.includes('all')) return [...ALL_SECTIONS];

  const invalid = requested.filter((value) => !ALL_SECTIONS.includes(value as SystemSection));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown section(s): ${invalid.join(', ')}. Valid sections: ${ALL_SECTIONS.join(', ')}, all`
    );
  }
  return ALL_SECTIONS.filter((section) => requested.includes(section));
}

export interface AgentInventoryEntry {
  id: string;
  name: string;
  files: number;
  bytes: number;
  includes: {
    productions: boolean;
    conversations: boolean;
    karma: boolean;
    sessions: boolean;
  };
}

export interface ExclusionNote {
  path: string;
  reason: string;
}

export interface SystemManifest {
  kind: typeof SYSTEM_EXPORT_KIND;
  version: number;
  /** Version of the nested per-bot bundles under `agents/`. */
  agentExportVersion: number;
  frameworkVersion: string;
  exportedAt: string;
  source: {
    hostname: string;
    platform: string;
    arch: string;
    runtime: string;
  };
  sections: SystemSection[];
  inventory: {
    agents: AgentInventoryEntry[];
    files: number;
    bytes: number;
    excluded: ExclusionNote[];
  };
  security: {
    /** Config paths whose literal value was replaced by a `${VAR}` placeholder. */
    redacted: string[];
    /** Machine-specific config paths deliberately left out. */
    dropped: string[];
    requiredEnv: EnvRequirement[];
    /** Files where an embedded credential shape was scrubbed from the content. */
    scrubbedFiles: string[];
  };
  /** sha256 of every file in the bundle except `manifest.json` itself. */
  checksums: Record<string, string>;
}
