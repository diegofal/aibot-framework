/**
 * Fill cost and prompt-cache tokens into the LLM query log from the Claude
 * CLI's own transcripts (src/stats/claude-transcripts.ts). The log recorded
 * neither before 2026-10-15, so Insights → Usage showed $0.
 *
 *   bun scripts/usage/backfill-claude-costs.ts [dataDir]           # dry run: what it would do
 *   bun scripts/usage/backfill-claude-costs.ts [dataDir] --apply   # backup, then write
 *
 * Sessions no logged call accounts for (skills, consolidation, reviews run the
 * CLI without logging) go to the bot whose "## Agent identity" name they
 * carry, as caller `unlogged`; the rest to `_unattributed`. Run inside the
 * container: dataDir defaults to /app/data. Idempotent: entries that already
 * have a cost are skipped, and so are sessions already backfilled.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LlmQueryEntry } from '../../src/bot/llm-query-log';
import {
  type TranscriptSession,
  enrichEntries,
  matchSessions,
  parseTranscript,
} from '../../src/stats/claude-transcripts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dataDir = args.find((a) => !a.startsWith('--')) ?? '/app/data';
const logDir = join(dataDir, 'llm-query-log');

const transcriptDirs = [join(dataDir, 'claude', 'projects', '-tmp')];
const accountsDir = join(dataDir, 'claude-accounts');
if (existsSync(accountsDir))
  for (const a of readdirSync(accountsDir))
    transcriptDirs.push(join(accountsDir, a, 'projects', '-tmp'));

// 1. Sessions
const sessions: TranscriptSession[] = [];
for (const dir of transcriptDirs) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const s = parseTranscript(readFileSync(join(dir, f), 'utf8'));
    if (s) sessions.push(s);
  }
}

// 2. Log entries, all bots, all days (file + index kept to write back)
interface Loc {
  file: string;
  line: number;
}
const entries: LlmQueryEntry[] = [];
const locs: Loc[] = [];
const fileLines = new Map<string, string[]>();
const alreadyBackfilled = new Set<string>();
for (const bot of existsSync(logDir) ? readdirSync(logDir) : []) {
  const botDir = join(logDir, bot);
  let days: string[] = [];
  try {
    days = readdirSync(botDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    continue;
  }
  for (const day of days) {
    const file = join(botDir, day);
    const lines = readFileSync(file, 'utf8').split('\n');
    fileLines.set(file, lines);
    lines.forEach((l, line) => {
      if (!l.trim()) return;
      try {
        const e = JSON.parse(l) as LlmQueryEntry;
        for (const id of e.sessionIds ?? []) alreadyBackfilled.add(id);
        entries.push(e);
        locs.push({ file, line });
      } catch {
        /* malformed line stays as it is */
      }
    });
  }
}
const fresh = sessions.filter((s) => !alreadyBackfilled.has(s.sessionId));

// 3. Match
const { byEntry, unmatched } = matchSessions(entries, fresh);
const enriched = enrichEntries(entries, byEntry);

// 4. Unmatched → by agent name, else _unattributed
const nameToBot = new Map<string, string>();
for (const root of [join(dataDir, 'tenants', '__admin__', 'bots')]) {
  if (!existsSync(root)) continue;
  for (const bot of readdirSync(root)) {
    try {
      const id = readFileSync(join(root, bot, 'soul', 'IDENTITY.md'), 'utf8');
      const m = /^name:\s*(.+)$/m.exec(id);
      if (m) nameToBot.set(m[1].trim().toLowerCase(), bot);
    } catch {
      /* no identity */
    }
  }
}
const synthetic: Record<string, Array<Record<string, unknown>>> = {};
for (const s of unmatched) {
  const bot = (s.agentName && nameToBot.get(s.agentName.toLowerCase())) || '_unattributed';
  (synthetic[bot] ??= []).push({
    timestamp: new Date(s.startMs).toISOString(),
    botId: bot,
    caller: 'unlogged',
    model: s.model ?? 'claude',
    backend: 'claude-cli',
    durationMs: 0,
    success: true,
    promptTokens: s.inputTokens,
    completionTokens: s.outputTokens,
    totalTokens: s.inputTokens + s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheCreationTokens: s.cacheCreationTokens,
    costUsd: s.costUsd,
    sessionIds: [s.sessionId],
    backfilled: true,
  });
}

// 5. Report
const money = (n: number) => `$${n.toFixed(2)}`;
const matchedSessions = [...byEntry.values()].flat();
const perBot: Record<string, number> = {};
enriched.forEach((e) => {
  if (e.costUsd !== undefined) perBot[e.botId] = (perBot[e.botId] ?? 0) + e.costUsd;
});
for (const [bot, rows] of Object.entries(synthetic))
  perBot[bot] = (perBot[bot] ?? 0) + rows.reduce((a, r) => a + Number(r.costUsd), 0);
console.log(`transcript sessions: ${sessions.length} (${fresh.length} not backfilled yet)`);
console.log(
  `log entries: ${entries.length}; enriched: ${byEntry.size} (${matchedSessions.length} sessions, ${money(matchedSessions.reduce((a, s) => a + s.costUsd, 0))})`
);
for (const [bot, rows] of Object.entries(synthetic))
  console.log(
    `unlogged → ${bot}: ${rows.length} sessions, ${money(rows.reduce((a, r) => a + Number(r.costUsd), 0))}`
  );
console.log('cost per bot (all known):');
for (const [bot, c] of Object.entries(perBot).sort((a, b) => b[1] - a[1]))
  console.log(`  ${bot}: ${money(c)}`);

if (!apply) {
  console.log('\nDry run. Re-run with --apply to write (the log is backed up first).');
  process.exit(0);
}

// 6. Write: backup, rewrite enriched lines, append unlogged sessions
const backup = `${logDir}.bak-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}`;
cpSync(logDir, backup, { recursive: true });
const changed = new Set<string>();
for (const i of byEntry.keys()) {
  const { file, line } = locs[i];
  (fileLines.get(file) as string[])[line] = JSON.stringify(enriched[i]);
  changed.add(file);
}
for (const file of changed) writeFileSync(file, (fileLines.get(file) as string[]).join('\n'));
for (const [bot, rows] of Object.entries(synthetic)) {
  mkdirSync(join(logDir, bot), { recursive: true });
  for (const r of rows)
    appendFileSync(
      join(logDir, bot, `${String(r.timestamp).slice(0, 10)}.jsonl`),
      `${JSON.stringify(r)}\n`
    );
}
console.log(`\nWritten. ${changed.size} files rewritten, backup at ${backup}`);
