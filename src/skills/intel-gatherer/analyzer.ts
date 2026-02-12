import type { Logger } from '../../logger';
import type { TrendData, AnalysisResult } from './types';

export class IntelAnalyzer {
  constructor(private logger: Logger) {}

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
    keywords.forEach((kw) => {
      const regex = new RegExp(`\\b${kw.toLowerCase()}\\b`, 'g');
      const matches = text.match(regex);
      counts[kw] = matches ? matches.length : 0;
    });
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

    // Current counts
    const currentCounts = this.countKeywords(currentText, keywords);

    // Historical average (last 7 days)
    const historicalCounts: Record<string, number> = {};
    keywords.forEach((kw) => (historicalCounts[kw] = 0));

    history.forEach((h) => {
      const text = this.extractTextFromMarkdown(h.content);
      const counts = this.countKeywords(text, keywords);
      keywords.forEach((kw) => {
        historicalCounts[kw] += counts[kw];
      });
    });

    // Calculate averages
    const daysCount = Math.max(history.length, 1);
    keywords.forEach((kw) => {
      historicalCounts[kw] = historicalCounts[kw] / daysCount;
    });

    // Detect significant changes (>100% increase or new appearances)
    keywords.forEach((kw) => {
      const current = currentCounts[kw];
      const historical = historicalCounts[kw];

      if (current > 0) {
        if (historical === 0) {
          // New appearance
          trends.push({
            keyword: kw,
            type: 'new',
            current,
            historical: 0,
            change: '+∞',
            significance: 'high',
          });
        } else if (current > historical * 2) {
          // Significant increase
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
    });

    return trends.sort((a, b) => {
      const sigOrder = { high: 3, medium: 2, low: 1 };
      return sigOrder[b.significance] - sigOrder[a.significance];
    });
  }

  /**
   * Analyze collected intelligence
   */
  analyze(
    currentMarkdown: string,
    history: Array<{ date: string; content: string }>
  ): AnalysisResult {
    const currentText = this.extractTextFromMarkdown(currentMarkdown);

    // Keywords to track
    const techKeywords = [
      'openclaw',
      'langchain',
      'langgraph',
      'n8n',
      'dify',
      'autogpt',
      'agent',
      'local llm',
      'swarm',
      'multi-agent',
      'workflow',
    ];

    const toolKeywords = [
      'claude',
      'gpt-4',
      'gpt-5',
      'ollama',
      'llama',
      'mistral',
      'fastapi',
      'nextjs',
      'react',
      'docker',
    ];

    const cryptoKeywords = [
      'bitcoin',
      'ethereum',
      'solana',
      'crypto',
      'blockchain',
      'trading',
      'defi',
    ];

    // Detect trends
    const techTrends = this.detectTrends(currentText, history, techKeywords);
    const toolTrends = this.detectTrends(currentText, history, toolKeywords);
    const cryptoTrends = this.detectTrends(currentText, history, cryptoKeywords);

    const totalTrends = techTrends.length + toolTrends.length + cryptoTrends.length;

    // Build analysis result
    const result: AnalysisResult = {
      date: new Date().toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      summary: {
        totalTrends,
      },
      alerts: [],
      trends: {
        technology: techTrends,
        tools: toolTrends,
        crypto: cryptoTrends,
      },
    };

    // Generate alerts
    const majorTrends = techTrends.filter((t) => t.significance === 'high');
    if (majorTrends.length > 0) {
      result.alerts.push({
        type: 'trend',
        priority: 'medium',
        message: `📈 ${majorTrends.length} major trend(s) detected`,
      });
    }

    this.logger.info({ totalTrends, alerts: result.alerts.length }, 'Analysis complete');

    return result;
  }
}
