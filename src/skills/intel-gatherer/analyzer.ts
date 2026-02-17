import type { Logger } from '../../logger';
import type { LLMClient } from '../../core/llm-client';
import type {
  TrendData,
  AnalysisResult,
  AnalysisConfig,
  IntelData,
  CategoryData,
  CategoryConfig,
} from './types';

export class IntelAnalyzer {
  constructor(
    private logger: Logger,
    private llm?: LLMClient
  ) {}

  /**
   * Extract all text content from markdown
   */
  private extractTextFromMarkdown(md: string): string {
    return md
      .replace(/#+ /g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*|__/g, '')
      .replace(/`/g, '')
      .replace(/\n+/g, ' ')
      .toLowerCase();
  }

  /**
   * Count keyword occurrences
   */
  private countKeywords(text: string, keywords: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const kw of keywords) {
      const regex = new RegExp(`\\b${kw.toLowerCase()}\\b`, 'g');
      const matches = text.match(regex);
      counts[kw] = matches ? matches.length : 0;
    }
    return counts;
  }

  /**
   * Detect trends by comparing current vs historical
   */
  detectTrends(
    currentText: string,
    history: Array<{ date: string; content: string }>,
    keywords: string[]
  ): TrendData[] {
    const trends: TrendData[] = [];
    const currentCounts = this.countKeywords(currentText, keywords);

    // Historical average (last 7 days)
    const historicalCounts: Record<string, number> = {};
    for (const kw of keywords) historicalCounts[kw] = 0;

    for (const h of history) {
      const text = this.extractTextFromMarkdown(h.content);
      const counts = this.countKeywords(text, keywords);
      for (const kw of keywords) {
        historicalCounts[kw] += counts[kw];
      }
    }

    const daysCount = Math.max(history.length, 1);
    for (const kw of keywords) {
      historicalCounts[kw] = historicalCounts[kw] / daysCount;
    }

    // Detect significant changes
    for (const kw of keywords) {
      const current = currentCounts[kw];
      const historical = historicalCounts[kw];

      if (current > 0) {
        if (historical === 0) {
          trends.push({
            keyword: kw,
            type: 'new',
            current,
            historical: 0,
            change: '+∞',
            significance: 'high',
          });
        } else if (current > historical * 2) {
          const change = Math.round(((current - historical) / historical) * 100);
          trends.push({
            keyword: kw,
            type: 'surge',
            current,
            historical: Math.round(historical * 10) / 10,
            change: `+${change}%`,
            significance: change > 300 ? 'high' : 'medium',
          });
        }
      }
    }

    return trends.sort((a, b) => {
      const sigOrder = { high: 3, medium: 2, low: 1 };
      return sigOrder[b.significance] - sigOrder[a.significance];
    });
  }

  /**
   * Convert a category's data into plain text for LLM consumption
   */
  private categoryToText(catId: string, data: CategoryData): string {
    const lines: string[] = [`Category: ${catId}`];

    for (const post of data.reddit) {
      lines.push(`[Reddit r/${post.source}] ${post.title} (score: ${post.score})`);
    }
    for (const story of data.hn) {
      lines.push(`[HN] ${story.title} (points: ${story.score})`);
    }
    for (const rel of data.github) {
      lines.push(`[GitHub] ${rel.repo} ${rel.version}`);
    }

    return lines.join('\n');
  }

  /**
   * Generate LLM summaries per category + global digest
   */
  async generateLLMSummaries(
    data: IntelData,
    categories: CategoryConfig[],
    analysisConfig: AnalysisConfig
  ): Promise<{ sectionSummaries: Record<string, string>; llmDigest?: string }> {
    const sectionSummaries: Record<string, string> = {};

    if (!this.llm || !analysisConfig.llm_summary?.enabled) {
      return { sectionSummaries };
    }

    const temperature = analysisConfig.llm_summary.temperature;

    // Per-category summaries
    for (const cat of categories) {
      const catData = data.categories[cat.id];
      if (!catData) continue;

      const itemCount = catData.reddit.length + catData.hn.length + catData.github.length;
      if (itemCount === 0) continue;

      const text = this.categoryToText(cat.id, catData);

      try {
        const summary = await this.llm.generate(
          `Summarize these ${cat.name} items in 2-3 sentences. Focus on the most notable stories and themes. Be concise.\n\n${text}`,
          {
            temperature,
            maxTokens: 300,
            system: 'You are a concise tech news analyst. Output only the summary, no preamble.',
          }
        );
        sectionSummaries[cat.id] = summary.trim();
      } catch (err: any) {
        this.logger.warn({ error: err.message, category: cat.id }, 'LLM summary failed for category');
      }
    }

    // Global digest
    let llmDigest: string | undefined;
    const allSummaries = Object.entries(sectionSummaries)
      .map(([id, s]) => `${id}: ${s}`)
      .join('\n\n');

    if (allSummaries.length > 0) {
      try {
        llmDigest = (
          await this.llm.generate(
            `Based on these category summaries, write a brief executive digest (4-6 sentences) highlighting the most important developments across all categories.\n\n${allSummaries}`,
            {
              temperature,
              maxTokens: 800,
              system: 'You are a concise tech intelligence analyst. Output only the digest, no preamble.',
            }
          )
        ).trim();
      } catch (err: any) {
        this.logger.warn({ error: err.message }, 'LLM global digest failed');
      }
    }

    return { sectionSummaries, llmDigest };
  }

  /**
   * Analyze collected intelligence with configurable keywords
   */
  analyze(
    currentMarkdown: string,
    history: Array<{ date: string; content: string }>,
    analysisConfig: AnalysisConfig
  ): AnalysisResult {
    const currentText = this.extractTextFromMarkdown(currentMarkdown);

    // Build trends from all keyword groups dynamically
    const trends: Record<string, TrendData[]> = {};
    let totalTrends = 0;

    for (const [group, keywords] of Object.entries(analysisConfig.keywords)) {
      const groupTrends = this.detectTrends(currentText, history, keywords);
      trends[group] = groupTrends;
      totalTrends += groupTrends.length;
    }

    const result: AnalysisResult = {
      date: new Date().toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      summary: { totalTrends },
      alerts: [],
      trends,
    };

    // Generate alerts from all groups
    for (const [group, groupTrends] of Object.entries(trends)) {
      const major = groupTrends.filter((t) => t.significance === 'high');
      if (major.length > 0) {
        result.alerts.push({
          type: 'trend',
          priority: 'medium',
          message: `${major.length} major trend(s) in ${group}`,
        });
      }
    }

    this.logger.info({ totalTrends, alerts: result.alerts.length }, 'Analysis complete');

    return result;
  }
}
