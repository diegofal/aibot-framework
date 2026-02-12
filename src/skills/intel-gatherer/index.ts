import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { Skill, SkillContext } from '../../core/types';
import type { SourcesConfig } from './types';
import { IntelCollector } from './collector';
import { IntelAnalyzer } from './analyzer';
import { IntelFormatter } from './formatter';

interface IntelConfig {
  telegramChatId?: number;
  sourcesFile?: string;
  dataDir?: string;
}

const skill: Skill = {
  id: 'intel-gatherer',
  name: 'Intelligence Gatherer',
  version: '3.0.0',
  description: 'Collects and analyzes intelligence from multiple sources',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Intel-gatherer skill loaded');

    // Ensure data directories exist
    const config = ctx.config as IntelConfig;
    const dataDir = config.dataDir || './data/intel';
    const dirs = ['raw', 'trends', 'highlights', 'html'];

    for (const dir of dirs) {
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
        const [subcommand, ...rest] = args;

        switch (subcommand) {
          case 'collect':
            return await runCollection(ctx);
          case 'analyze':
            return await runAnalysis(ctx);
          case 'today':
            return await showToday(ctx);
          case 'help':
            return `📚 Intel-Gatherer Commands:

/intel collect - Run data collection from all sources
/intel analyze - Analyze collected data for trends
/intel today - Show today's report
/intel help - Show this help message

📋 Sources: Reddit, Hacker News, GitHub releases`;
          default:
            return `❓ Unknown subcommand: ${subcommand}

Use /intel help for available commands.`;
        }
      },
    },
  },

  jobs: [
    {
      id: 'daily-intel-collection',
      schedule: '0 9 * * *', // 9 AM daily
      async handler(ctx: SkillContext) {
        ctx.logger.info('Running scheduled intel collection');

        try {
          // Run collection
          const result = await runCollection(ctx);

          // Run analysis
          await runAnalysis(ctx);

          // Send to Telegram if configured
          const config = ctx.config as IntelConfig;
          if (config.telegramChatId) {
            const date = new Date().toISOString().split('T')[0];
            const dataDir = config.dataDir || './data/intel';
            const htmlPath = join(dataDir, 'html', `${date}.html`);

            if (existsSync(htmlPath)) {
              await ctx.telegram.sendMessage(
                config.telegramChatId,
                `📊 Daily Intel Report — ${date}\n\n${result}`
              );
            }
          }
        } catch (error: any) {
          ctx.logger.error({ error: error.message }, 'Scheduled collection failed');
        }
      },
    },
  ],
};

/**
 * Load sources configuration
 */
function loadSourcesConfig(ctx: SkillContext): SourcesConfig {
  const config = ctx.config as IntelConfig;
  const sourcesFile = config.sourcesFile || './config/sources.yml';

  if (!existsSync(sourcesFile)) {
    throw new Error(`Sources file not found: ${sourcesFile}`);
  }

  const content = readFileSync(sourcesFile, 'utf-8');
  return load(content) as SourcesConfig;
}

/**
 * Run intelligence collection
 */
async function runCollection(ctx: SkillContext): Promise<string> {
  const config = ctx.config as IntelConfig;
  const dataDir = config.dataDir || './data/intel';

  ctx.logger.info('Starting intelligence collection...');

  try {
    // Load sources
    const sources = loadSourcesConfig(ctx);

    // Collect data
    const collector = new IntelCollector(ctx.logger);
    const data = await collector.collect(sources);

    // Generate markdown
    const formatter = new IntelFormatter();
    const markdown = formatter.generateMarkdown(data);

    // Save markdown
    const date = data.date;
    const mdPath = join(dataDir, 'raw', `${date}.md`);
    writeFileSync(mdPath, markdown, 'utf-8');
    ctx.logger.info({ path: mdPath }, 'Markdown report saved');

    // Generate HTML
    const html = formatter.generateHTML(markdown, date);
    const htmlPath = join(dataDir, 'html', `${date}.html`);
    writeFileSync(htmlPath, html, 'utf-8');
    ctx.logger.info({ path: htmlPath }, 'HTML report saved');

    const totalRedditPosts = Object.values(data.reddit).reduce(
      (sum, posts) => sum + posts.length,
      0
    );

    return `✅ Collection complete!

📊 Summary:
• Reddit posts: ${totalRedditPosts}
• Hacker News: ${data.hn.length}
• GitHub releases: ${data.github.length}

📄 Reports saved:
• Markdown: ${mdPath}
• HTML: ${htmlPath}`;
  } catch (error: any) {
    ctx.logger.error({ error: error.message }, 'Collection failed');
    return `❌ Collection failed: ${error.message}`;
  }
}

/**
 * Run trend analysis
 */
async function runAnalysis(ctx: SkillContext): Promise<string> {
  const config = ctx.config as IntelConfig;
  const dataDir = config.dataDir || './data/intel';
  const date = new Date().toISOString().split('T')[0];

  ctx.logger.info('Starting trend analysis...');

  try {
    // Load today's markdown
    const mdPath = join(dataDir, 'raw', `${date}.md`);
    if (!existsSync(mdPath)) {
      return `❌ No data for ${date}. Run /intel collect first.`;
    }

    const currentMarkdown = readFileSync(mdPath, 'utf-8');

    // Load historical data (last 7 days)
    const history: Array<{ date: string; content: string }> = [];
    const rawDir = join(dataDir, 'raw');
    const files = readdirSync(rawDir).filter((f) => f.endsWith('.md'));

    for (const file of files.slice(-7)) {
      const path = join(rawDir, file);
      const content = readFileSync(path, 'utf-8');
      history.push({
        date: file.replace('.md', ''),
        content,
      });
    }

    // Analyze
    const analyzer = new IntelAnalyzer(ctx.logger);
    const analysis = analyzer.analyze(currentMarkdown, history);

    // Save analysis
    const analysisPath = join(dataDir, 'trends', `${date}.json`);
    writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf-8');
    ctx.logger.info({ path: analysisPath }, 'Analysis saved');

    return `✅ Analysis complete!

📈 Trends detected: ${analysis.summary.totalTrends}
🚨 Alerts: ${analysis.alerts.length}

📄 Analysis saved: ${analysisPath}`;
  } catch (error: any) {
    ctx.logger.error({ error: error.message }, 'Analysis failed');
    return `❌ Analysis failed: ${error.message}`;
  }
}

/**
 * Show today's report
 */
async function showToday(ctx: SkillContext): Promise<string> {
  const config = ctx.config as IntelConfig;
  const dataDir = config.dataDir || './data/intel';
  const date = new Date().toISOString().split('T')[0];

  const mdPath = join(dataDir, 'raw', `${date}.md`);
  const htmlPath = join(dataDir, 'html', `${date}.html`);

  if (!existsSync(mdPath)) {
    return `❌ No report for ${date}. Run /intel collect first.`;
  }

  // Read first few lines of markdown
  const markdown = readFileSync(mdPath, 'utf-8');
  const preview = markdown.split('\n').slice(0, 20).join('\n');

  return `📊 Intel Report — ${date}

${preview}

... (truncated)

📄 Full reports:
• Markdown: ${mdPath}
• HTML: ${htmlPath}`;
}

export default skill;
