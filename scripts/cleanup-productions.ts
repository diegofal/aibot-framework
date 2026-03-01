#!/usr/bin/env bun
/**
 * Production Cleanup & Reorganization Script
 *
 * Moves root files into categorized subdirectories and archives duplicates.
 * Run with `bun scripts/cleanup-productions.ts` for dry-run (shows what it would do).
 * Run with `bun scripts/cleanup-productions.ts --execute` to apply changes.
 *
 * After execution, rebuilds INDEX.md for each production.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { Config } from '../src/config';
import { ProductionsService } from '../src/productions/service';

const PROD_BASE = join(import.meta.dir, '..', 'productions');
const DRY_RUN = !process.argv.includes('--execute');

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

interface MoveOp {
  from: string; // relative path from production root
  to: string; // relative destination path
  type: 'move' | 'archive';
  reason?: string; // archive reason
}

let totalOps = 0;
let totalArchives = 0;

function plan(botId: string, ops: MoveOp[]): void {
  if (ops.length === 0) return;
  console.log(`\n=== ${botId} (${ops.length} operations) ===`);
  for (const op of ops) {
    if (op.type === 'archive') {
      console.log(`  ARCHIVE: ${op.from} → archived/${basename(op.from)}  [${op.reason}]`);
      totalArchives++;
    } else {
      console.log(`  MOVE:    ${op.from} → ${op.to}`);
    }
    totalOps++;
  }
}

function execute(botId: string, ops: MoveOp[], service: ProductionsService): void {
  const dir = join(PROD_BASE, botId);
  if (!existsSync(dir)) return;

  for (const op of ops) {
    const srcPath = join(dir, op.from);
    if (!existsSync(srcPath)) {
      console.log(`  SKIP (not found): ${op.from}`);
      continue;
    }

    if (op.type === 'archive') {
      const ok = service.archiveFile(botId, op.from, op.reason ?? 'Cleanup');
      console.log(`  ${ok ? 'ARCHIVED' : 'FAIL'}: ${op.from}`);
    } else {
      const destPath = join(dir, op.to);
      const destDir = join(destPath, '..');
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      renameSync(srcPath, destPath);
      console.log(`  MOVED: ${op.from} → ${op.to}`);
    }
  }
}

/** Check if a file exists in production root */
function rootExists(botId: string, name: string): boolean {
  return existsSync(join(PROD_BASE, botId, name));
}

/** Get root files (not dirs) for a production */
function getRootFiles(botId: string): string[] {
  const dir = join(PROD_BASE, botId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => {
      try {
        return statSync(join(dir, f)).isFile();
      } catch {
        return false;
      }
    })
    .filter((f) => !['changelog.jsonl', 'summary.json', 'INDEX.md', '.gitignore'].includes(f));
}

// ──────────────────────────────────────────────
// Job-seeker: 90+ root files → organized
// ──────────────────────────────────────────────
function planJobSeeker(): MoveOp[] {
  const ops: MoveOp[] = [];
  const rootFiles = getRootFiles('job-seeker');

  // Archive duplicates first
  const archives: [string, string][] = [
    ['pipeline_update_2026-02-22.md', 'Superseded by pipeline_tracker in diego_applications/'],
    ['pipeline_update_feb22_0727.md', 'Superseded by pipeline_tracker in diego_applications/'],
    ['pipeline_verification_feb22.md', 'Superseded by pipeline_tracker in diego_applications/'],
    ['pipeline_freshness_feb22_2026.md', 'Superseded by pipeline_tracker in diego_applications/'],
    ['linkedin_alternative_c.md', 'Superseded by linkedin_alternative_c_PUBLISHED.md'],
    ['linkedin_alternative_c_deploy_ready.md', 'Superseded by linkedin_alternative_c_PUBLISHED.md'],
    ['content_calendar_48h.md', 'Superseded by content_calendar_3_days.md in content/'],
    ['batch_job_analysis_results.md', 'Superseded by batch_analysis_feb23_2026.md'],
    ['test_cold_outreach_biodock_output.md', 'Test output'],
    ['test_generate_cold_outreach_biodock.json', 'Test output'],
  ];

  // Duplicate-of-existing-subdirectory archives
  const duplicateArchives: [string, string][] = [
    ['onboarding_questionnaire.md', 'Duplicate of methodology/onboarding_questionnaire.md'],
    ['outreach_templates.md', 'Duplicate of methodology/outreach_templates.md'],
    ['discord_bio_template.md', 'Duplicate of community_materials/discord_bio_template.md'],
    ['python_espanol_posts.md', 'Duplicate of community_materials/python_espanol_posts.md'],
    [
      'market_intelligence_shareable.md',
      'Duplicate of methodology/market_intelligence_shareable.md',
    ],
  ];

  for (const [file, reason] of [...archives, ...duplicateArchives]) {
    if (rootExists('job-seeker', file)) {
      ops.push({ from: file, to: '', type: 'archive', reason });
    }
  }

  // Categorize remaining root files
  const categorized = new Set(ops.map((o) => o.from));

  for (const file of rootFiles) {
    if (categorized.has(file)) continue;

    // Pipeline/batch
    if (/^(pipeline_|batch_|fresh_opportunities_|new_opportunities_|hn_)/.test(file)) {
      ops.push({ from: file, to: `pipeline/${file}`, type: 'move' });
    }
    // Outreach
    else if (
      /^(outreach_|cold_outreach_|hiring_manager_|personalized_dms_|dm_|target_intelligence_|LinkedIn_DM_)/.test(
        file
      )
    ) {
      ops.push({ from: file, to: `outreach/${file}`, type: 'move' });
    }
    // Content
    else if (/^(linkedin_|twitter_|reddit_|publication_|DualEntry_|Flow_RMS_)/.test(file)) {
      ops.push({ from: file, to: `content/${file}`, type: 'move' });
    }
    // Prospects
    else if (/^(prospect_|new_user_)/.test(file)) {
      ops.push({ from: file, to: `prospects/${file}`, type: 'move' });
    }
    // Operations
    else if (
      /^(calendly_|discovery_call_|ESCALATION_|emergency_|execution_|deployment_|checkpoint_|operator_|pivot_|MANUAL_|manual_|content_campaign_)/.test(
        file
      )
    ) {
      ops.push({ from: file, to: `operations/${file}`, type: 'move' });
    }
    // Research
    else if (/^(market_intelligence_|alternative_channels_)/.test(file)) {
      ops.push({ from: file, to: `research/${file}`, type: 'move' });
    }
    // Acquisition
    else if (/^acquisition_/.test(file)) {
      ops.push({ from: file, to: `outreach/${file}`, type: 'move' });
    }
    // Remaining uncategorized → operations (catch-all)
    else {
      ops.push({ from: file, to: `operations/${file}`, type: 'move' });
    }
  }

  return ops;
}

// ──────────────────────────────────────────────
// Therapist: 70 root → organized
// ──────────────────────────────────────────────
function planTherapist(): MoveOp[] {
  const ops: MoveOp[] = [];
  const rootFiles = getRootFiles('Therapist');

  // Archive duplicates
  const archives: [string, string][] = [
    [
      'capitulo_07_el_deseo_que_nos_averguenza.md',
      'Duplicate: also exists as cap 07 extended version',
    ],
    [
      'capitulo_08_el_deseo_que_nos_averguenza.md',
      'Duplicate: same title as cap 07, content moved to cap 08_el_duelo',
    ],
    [
      'capitulo_02_lo_que_heredamos.md',
      'Superseded by capitulo_02_lo_que_heredamos_y_los_secretos.md (extended version)',
    ],
    [
      'capitulo_09_cuando_el_deseo_se_agota.md',
      'Duplicate: topic covered in capitulo_07 extended version',
    ],
    ['capitulo_divan_digital.md', 'Superseded by numbered digital chapters (13-15)'],
  ];

  for (const [file, reason] of archives) {
    if (rootExists('Therapist', file)) {
      ops.push({ from: file, to: '', type: 'archive', reason });
    }
  }

  const categorized = new Set(ops.map((o) => o.from));

  for (const file of rootFiles) {
    if (categorized.has(file)) continue;

    // Capitulos
    if (/^(capitulo_|prologo_|epilogo_)/.test(file)) {
      ops.push({ from: file, to: `capitulos/${file}`, type: 'move' });
    }
    // Ensayos (md)
    else if (/^ensayo_/.test(file) && file.endsWith('.md')) {
      ops.push({ from: file, to: `ensayos/${file}`, type: 'move' });
    }
    // Ensayos (html)
    else if (/^ensayo[-_]/.test(file) && file.endsWith('.html')) {
      ops.push({ from: file, to: `ensayos/${file}`, type: 'move' });
    }
    // Manuscritos / structure
    else if (/^(manuscrito_|libro_estructura_)/.test(file)) {
      ops.push({ from: file, to: `manuscritos/${file}`, type: 'move' });
    }
    // Publishing
    else if (
      /^(book_description_|guia_kdp_|substack_|calendario_editorial_|research_substack_|portada_|micro_posts_)/.test(
        file
      ) ||
      file === 'rss.xml'
    ) {
      ops.push({ from: file, to: `publishing/${file}`, type: 'move' });
    }
    // Website
    else if (/\.(html|css|svg)$/.test(file) || ['vercel.json', '.vercelignore'].includes(file)) {
      ops.push({ from: file, to: `website/${file}`, type: 'move' });
    }
    // Keep .gitignore in root
    else if (file === '.gitignore') {
      // skip
    }
    // Anything else → publishing (catch-all for this bot)
    else {
      ops.push({ from: file, to: `publishing/${file}`, type: 'move' });
    }
  }

  // Move api/ subdir to website/api/ if it exists
  if (existsSync(join(PROD_BASE, 'Therapist', 'api'))) {
    ops.push({ from: 'api', to: 'website/api', type: 'move' });
  }

  return ops;
}

// ──────────────────────────────────────────────
// myfirstmillion: 28 root → organized
// ──────────────────────────────────────────────
function planMyfirstmillion(): MoveOp[] {
  const ops: MoveOp[] = [];
  const rootFiles = getRootFiles('myfirstmillion');

  // Files that stay in root
  const keepRoot = new Set(['soul.md', 'project-status-brief.md']);

  for (const file of rootFiles) {
    if (keepRoot.has(file)) continue;

    // Opportunities
    if (/opportunity|ranked-opportunities|top-3-|research-/.test(file)) {
      ops.push({ from: file, to: `opportunities/${file}`, type: 'move' });
    }
    // Frameworks
    else if (/Framework|Playbook|Strategy|Wealth|Revenue|rapid-response/.test(file)) {
      ops.push({ from: file, to: `frameworks/${file}`, type: 'move' });
    }
    // Outreach
    else if (/outreach|customer-discovery|launch-materials|botpress|TIDIO/.test(file)) {
      ops.push({ from: file, to: `outreach/${file}`, type: 'move' });
    }
    // Competitive / research
    else if (/competitive|api-research/.test(file)) {
      ops.push({ from: file, to: `opportunities/${file}`, type: 'move' });
    }
    // Remaining → frameworks
    else {
      ops.push({ from: file, to: `frameworks/${file}`, type: 'move' });
    }
  }

  return ops;
}

// ──────────────────────────────────────────────
// default: 13 root → organized
// ──────────────────────────────────────────────
function planDefault(): MoveOp[] {
  const ops: MoveOp[] = [];
  const rootFiles = getRootFiles('default');

  for (const file of rootFiles) {
    // Frameworks
    if (/^(tone_calibration_|deteccion_emocional_|contingencias_|estrategias_)/.test(file)) {
      ops.push({ from: file, to: `frameworks/${file}`, type: 'move' });
    }
    // Cultural
    else if (
      /^(comfort_catalog_|modismos_argentinos_|pri_cultural_|finny_recommends_)/.test(file)
    ) {
      ops.push({ from: file, to: `cultural/${file}`, type: 'move' });
    }
    // Analysis
    else if (/^(market_analysis_|error_analysis_|tauri-vs-electron)/.test(file)) {
      ops.push({ from: file, to: `analysis/${file}`, type: 'move' });
    }
    // ntransformer
    else if (file === 'ntransformer-setup.sh') {
      ops.push({ from: file, to: `ntransformer/${file}`, type: 'move' });
    }
    // Test files
    else if (/^test_/.test(file)) {
      ops.push({ from: file, to: '', type: 'archive', reason: 'Test output file' });
    }
  }

  // Move tauri-ntransformer-bridge into ntransformer/
  if (existsSync(join(PROD_BASE, 'default', 'tauri-ntransformer-bridge'))) {
    ops.push({
      from: 'tauri-ntransformer-bridge',
      to: 'ntransformer/tauri-ntransformer-bridge',
      type: 'move',
    });
  }

  return ops;
}

// ──────────────────────────────────────────────
// cryptik: 13 root → organized
// ──────────────────────────────────────────────
function planCryptik(): MoveOp[] {
  const ops: MoveOp[] = [];
  const rootFiles = getRootFiles('cryptik');

  // IDENTITY.md stays in root
  const keepRoot = new Set(['IDENTITY.md']);

  for (const file of rootFiles) {
    if (keepRoot.has(file)) continue;

    if (file === 'trade_log.csv') {
      ops.push({ from: file, to: `data/${file}`, type: 'move' });
    } else {
      // All other docs → docs/
      ops.push({ from: file, to: `docs/${file}`, type: 'move' });
    }
  }

  return ops;
}

// ──────────────────────────────────────────────
// makemylifeeasier: low severity
// ──────────────────────────────────────────────
function planMakemylifeeasier(): MoveOp[] {
  const ops: MoveOp[] = [];
  const integrationFiles = [
    'FRAMEWORK_INTEGRATION_PACKAGE.md',
    'INTEGRATION_GUIDE.md',
    'INTEGRATION_VERIFICATION_REPORT.md',
    'framework-integration.json',
  ];

  for (const file of integrationFiles) {
    if (rootExists('makemylifeeasier', file)) {
      ops.push({ from: file, to: `integrations/${file}`, type: 'move' });
    }
  }

  return ops;
}

// ──────────────────────────────────────────────
// tsc: low severity
// ──────────────────────────────────────────────
function planTsc(): MoveOp[] {
  const ops: MoveOp[] = [];
  const rootFiles = getRootFiles('tsc');

  // Keep package.json, tsconfig.json in root; move .md to docs/
  const keepRoot = new Set(['package.json', 'package-lock.json', 'tsconfig.json']);

  for (const file of rootFiles) {
    if (keepRoot.has(file)) continue;
    if (file.endsWith('.md')) {
      ops.push({ from: file, to: `docs/${file}`, type: 'move' });
    }
  }

  return ops;
}

// ──────────────────────────────────────────────
// bookwriter: low severity
// ──────────────────────────────────────────────
function planBookwriter(): MoveOp[] {
  const ops: MoveOp[] = [];
  const rootFiles = getRootFiles('bookwriter');

  for (const file of rootFiles) {
    if (/^(arquitectura_|propuestas_)/.test(file)) {
      ops.push({ from: file, to: `arquitectura/${file}`, type: 'move' });
    }
  }

  return ops;
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
function main(): void {
  console.log(`Production Cleanup — ${DRY_RUN ? 'DRY RUN' : 'EXECUTING'}`);
  console.log(`Base: ${PROD_BASE}`);
  console.log('');

  const allPlans: [string, MoveOp[]][] = [
    ['job-seeker', planJobSeeker()],
    ['Therapist', planTherapist()],
    ['myfirstmillion', planMyfirstmillion()],
    ['default', planDefault()],
    ['cryptik', planCryptik()],
    ['makemylifeeasier', planMakemylifeeasier()],
    ['tsc', planTsc()],
    ['bookwriter', planBookwriter()],
  ];

  // Print plan
  for (const [botId, ops] of allPlans) {
    plan(botId, ops);
  }

  console.log(`\nTotal: ${totalOps} operations (${totalArchives} archives)`);

  if (DRY_RUN) {
    console.log('\nThis was a dry run. Use --execute to apply changes.');
    return;
  }

  // Build a minimal config for ProductionsService
  const bots = allPlans.map(([id]) => ({
    id,
    name: id,
    token: '',
    enabled: true,
    skills: [],
    productions: { enabled: true, trackOnly: false },
  }));

  const config = {
    bots,
    productions: { enabled: true, baseDir: PROD_BASE },
  } as Config;

  const service = new ProductionsService(config, noopLogger);

  console.log('\nExecuting...\n');

  for (const [botId, ops] of allPlans) {
    if (ops.length === 0) continue;
    console.log(`\n--- ${botId} ---`);
    execute(botId, ops, service);
  }

  // Delete venv in default/ntransformer/ (post-move) or default/tauri-ntransformer-bridge/
  const venvPaths = [
    join(
      PROD_BASE,
      'default',
      'ntransformer',
      'tauri-ntransformer-bridge',
      'python_backend',
      'venv'
    ),
    join(PROD_BASE, 'default', 'tauri-ntransformer-bridge', 'python_backend', 'venv'),
  ];
  for (const venvPath of venvPaths) {
    if (existsSync(venvPath)) {
      console.log(`\nDeleting venv: ${venvPath}`);
      rmSync(venvPath, { recursive: true });
      console.log('  DELETED');
    }
  }

  // Rebuild INDEX.md for all productions
  console.log('\nRebuilding INDEX.md for all productions...');
  const allBotIds = readdirSync(PROD_BASE).filter((f) => {
    try {
      return statSync(join(PROD_BASE, f)).isDirectory();
    } catch {
      return false;
    }
  });

  // Skip openclone
  const skipBots = new Set(['openclone', 'selfimproveaibot', 'test-bot', 'theskillcreator']);
  for (const botId of allBotIds) {
    if (skipBots.has(botId)) continue;
    // Ensure bot is in config for service to work
    if (!config.bots.find((b) => b.id === botId)) {
      (config.bots as any[]).push({
        id: botId,
        name: botId,
        token: '',
        enabled: true,
        skills: [],
        productions: { enabled: true, trackOnly: false },
      });
    }
    try {
      service.rebuildIndex(botId);
      console.log(`  INDEX.md rebuilt: ${botId}`);
    } catch (err) {
      console.log(`  ERROR: ${botId}: ${err}`);
    }
  }

  console.log('\nDone!');
}

main();
