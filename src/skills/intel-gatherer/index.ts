import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { Skill, SkillContext } from '../../core/types';
import type { IntelConfig, SourcesConfig, TriggerInfo } from './types';
import { IntelCollector } from './collector';
import { IntelAnalyzer } from './analyzer';
import { IntelFormatter } from './formatter';

// ── Helpers ──

function getConfig(ctx: SkillContext): IntelConfig {
  return ctx.config as IntelConfig;
}

function getDataDir(ctx: SkillContext): string {
  return getConfig(ctx).dataDir || './data/intel';
}

function resolveEnvVars(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}

function loadSourcesConfig(ctx: SkillContext): SourcesConfig {
  const config = getConfig(ctx);
  const sourcesFile = config.sourcesFile || './config/sources.yml';

  if (!existsSync(sourcesFile)) {
    throw new Error(`Sources file not found: ${sourcesFile}`);
  }

  const content = readFileSync(sourcesFile, 'utf-8');
  const parsed = load(content) as SourcesConfig;

  // Resolve env vars in settings
  if (parsed.settings?.github_token) {
    parsed.settings.github_token = resolveEnvVars(parsed.settings.github_token);
  }

  return parsed;
}

function loadHistory(dataDir: string): Array<{ date: string; content: string }> {
  const rawDir = join(dataDir, 'raw');
  if (!existsSync(rawDir)) return [];

  const files = readdirSync(rawDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  return files.slice(-7).map((file) => ({
    date: file.replace('.md', ''),
    content: readFileSync(join(rawDir, file), 'utf-8'),
  }));
}

// ── Core operations ──

async function runCollection(ctx: SkillContext, trigger?: TriggerInfo): Promise<string> {
  const dataDir = getDataDir(ctx);
  const config = getConfig(ctx);
  const date = new Date().toISOString().split('T')[0];

  // Dedup: skip if already collected today
  const lastDate = ctx.data.get<string>('lastCollectionDate');
  if (lastDate === date) {
    return `Already collected today (${date}). Data is up to date.`;
  }

  ctx.logger.info('Starting intelligence collection...');

  try {
    const sources = loadSourcesConfig(ctx);

    // Resolve GitHub token: config > sources.yml > env
    const githubToken =
      config.githubToken ||
      sources.settings.github_token ||
      process.env.GITHUB_TOKEN ||
      undefined;

    // 1. Collect data
    const collector = new IntelCollector(ctx.logger, githubToken);
    const data = await collector.collect(sources);

    // 2. Generate initial markdown (without LLM summaries)
    const formatter = new IntelFormatter();
    let markdown = formatter.generateMarkdown(data, sources.categories);

    // 3. Analyze trends
    const history = loadHistory(dataDir);
    const analyzer = new IntelAnalyzer(ctx.logger, ctx.ollama);
    const analysis = analyzer.analyze(markdown, history, sources.analysis);

    // 4. Generate LLM summaries
    const { sectionSummaries, llmDigest } = await analyzer.generateLLMSummaries(
      data,
      sources.categories,
      sources.analysis
    );
    analysis.sectionSummaries = sectionSummaries;
    analysis.llmDigest = llmDigest;

    // 5. Re-generate markdown with LLM summaries included
    markdown = formatter.generateMarkdown(data, sources.categories, analysis);

    // 6. Save files
    const mdPath = join(dataDir, 'raw', `${date}.md`);
    writeFileSync(mdPath, markdown, 'utf-8');
    ctx.logger.info({ path: mdPath }, 'Markdown report saved');

    const html = formatter.generateHTML(data, sources.categories, analysis);
    const htmlPath = join(dataDir, 'html', `${date}.html`);
    writeFileSync(htmlPath, html, 'utf-8');
    ctx.logger.info({ path: htmlPath }, 'HTML report saved');

    // Save analysis
    const analysisPath = join(dataDir, 'trends', `${date}.json`);
    writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf-8');

    // Mark as collected
    ctx.data.set('lastCollectionDate', date);

    // Send HTML to caller if triggered from Telegram
    if (trigger?.source === 'telegram' && trigger.chatId) {
      const htmlBuffer = Buffer.from(html);
      await ctx.telegram.sendDocument(trigger.chatId, htmlBuffer, {
        filename: `intel-report-${date}.html`,
      });
      ctx.logger.info({ chatId: trigger.chatId }, 'HTML report sent to caller');
    }

    // Count totals
    let totalReddit = 0;
    let totalHN = 0;
    let totalGitHub = 0;
    for (const catData of Object.values(data.categories)) {
      totalReddit += catData.reddit.length;
      totalHN += catData.hn.length;
      totalGitHub += catData.github.length;
    }

    const llmStatus = llmDigest ? 'yes' : 'no';

    return `Collection complete!

Summary:
- Reddit posts: ${totalReddit}
- Hacker News: ${totalHN}
- GitHub releases: ${totalGitHub}
- Categories: ${sources.categories.length}
- LLM digest: ${llmStatus}
- Trends detected: ${analysis.summary.totalTrends}

Reports saved:
- Markdown: ${mdPath}
- HTML: ${htmlPath}`;
  } catch (error: any) {
    ctx.logger.error({ error: error.message }, 'Collection failed');
    return `Collection failed: ${error.message}`;
  }
}

async function runAnalysis(ctx: SkillContext): Promise<string> {
  const dataDir = getDataDir(ctx);
  const date = new Date().toISOString().split('T')[0];

  ctx.logger.info('Starting trend analysis...');

  try {
    const mdPath = join(dataDir, 'raw', `${date}.md`);
    if (!existsSync(mdPath)) {
      return `No data for ${date}. Run /intel collect first.`;
    }

    const currentMarkdown = readFileSync(mdPath, 'utf-8');
    const history = loadHistory(dataDir);
    const sources = loadSourcesConfig(ctx);

    const analyzer = new IntelAnalyzer(ctx.logger, ctx.ollama);
    const analysis = analyzer.analyze(currentMarkdown, history, sources.analysis);

    const analysisPath = join(dataDir, 'trends', `${date}.json`);
    writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf-8');
    ctx.logger.info({ path: analysisPath }, 'Analysis saved');

    return `Analysis complete!

Trends detected: ${analysis.summary.totalTrends}
Alerts: ${analysis.alerts.length}

Analysis saved: ${analysisPath}`;
  } catch (error: any) {
    ctx.logger.error({ error: error.message }, 'Analysis failed');
    return `Analysis failed: ${error.message}`;
  }
}

async function showToday(ctx: SkillContext): Promise<string> {
  const dataDir = getDataDir(ctx);
  const date = new Date().toISOString().split('T')[0];

  const mdPath = join(dataDir, 'raw', `${date}.md`);
  const htmlPath = join(dataDir, 'html', `${date}.html`);

  if (!existsSync(mdPath)) {
    return `No report for ${date}. Run /intel collect first.`;
  }

  const markdown = readFileSync(mdPath, 'utf-8');
  const preview = markdown.split('\n').slice(0, 30).join('\n');

  return `Intel Report — ${date}

${preview}

... (truncated)

Full reports:
- Markdown: ${mdPath}
- HTML: ${htmlPath}`;
}

// ── Skill definition ──

const skill: Skill = {
  id: 'intel-gatherer',
  name: 'Intelligence Gatherer',
  version: '4.1.0',
  description: 'Collects and analyzes intelligence from multiple sources',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Intel-gatherer v4.1 loaded');

    const dataDir = getDataDir(ctx);
    for (const dir of ['raw', 'trends', 'highlights', 'html']) {
      const path = join(dataDir, dir);
      if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
        ctx.logger.debug({ path }, 'Created directory');
      }
    }
  },

  commands: {
    intel: {
      description: 'Intelligence gathering commands',
      async handler(args: string[], ctx: SkillContext) {
        const [subcommand] = args;

        const trigger: TriggerInfo = {
          source: 'telegram',
          chatId: ctx.session?.chatId,
          userId: ctx.session?.userId,
        };

        switch (subcommand) {
          case 'collect':
            return await runCollection(ctx, trigger);
          case 'analyze':
            return await runAnalysis(ctx);
          case 'today':
            return await showToday(ctx);
          case 'help':
            return `Intel-Gatherer v4.1 Commands:

/intel collect - Run data collection from all sources
/intel analyze - Analyze collected data for trends
/intel today - Show today's report
/intel help - Show this help message

Sources: Reddit, Hacker News, GitHub releases
Features: Category-based collection, LLM summaries, trend analysis`;
          default:
            return `Unknown subcommand: ${subcommand}\n\nUse /intel help for available commands.`;
        }
      },
    },
  },

  jobs: [
    {
      id: 'daily-intel-collection',
      schedule: '0 9 * * *',
      async handler(ctx: SkillContext) {
        ctx.logger.info('Running scheduled intel collection');

        try {
          const result = await runCollection(ctx, { source: 'cron' });
          await runAnalysis(ctx);

          const config = getConfig(ctx);
          if (config.telegramChatId) {
            const date = new Date().toISOString().split('T')[0];
            const dataDir = getDataDir(ctx);

            // Send digest via Telegram
            const trendsPath = join(dataDir, 'trends', `${date}.json`);
            let digestMsg = `Daily Intel Report — ${date}\n\n${result}`;

            if (existsSync(trendsPath)) {
              const analysis = JSON.parse(readFileSync(trendsPath, 'utf-8'));
              if (analysis.llmDigest) {
                digestMsg = `Daily Intel — ${date}\n\n${analysis.llmDigest}\n\n${result}`;
              }
            }

            await ctx.telegram.sendMessage(config.telegramChatId, digestMsg);

            // Send HTML as document if available
            const htmlPath = join(dataDir, 'html', `${date}.html`);
            if (existsSync(htmlPath)) {
              const htmlBuffer = Buffer.from(readFileSync(htmlPath, 'utf-8'));
              await ctx.telegram.sendDocument(config.telegramChatId, htmlBuffer, {
                filename: `intel-report-${date}.html`,
              });
            }
          }
        } catch (error: any) {
          ctx.logger.error({ error: error.message }, 'Scheduled collection failed');
        }
      },
    },
  ],
};

export default skill;
