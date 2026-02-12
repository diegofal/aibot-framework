import type { Logger } from '../../logger';
import type {
  RedditPost,
  HNStory,
  GitHubRelease,
  IntelData,
  SourcesConfig,
} from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IntelCollector {
  constructor(private logger: Logger) {}

  /**
   * Fetch Reddit posts from JSON API
   */
  async fetchReddit(
    url: string,
    config: { minScore: number; minComments: number; keywords?: string[]; limit?: number }
  ): Promise<RedditPost[]> {
    const { minScore, minComments, keywords, limit = 10 } = config;

    try {
      const fullUrl = url.includes('?') ? url : `${url}?limit=${limit}`;
      const res = await fetch(fullUrl, {
        headers: {
          'User-Agent': 'AIBot-IntelGatherer/3.0',
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        if (res.status === 403) {
          this.logger.warn(`Reddit rate limit (403), skipping: ${url}`);
          return [];
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      let posts = (data.data?.children || [])
        .map((p: any) => p.data)
        .filter((p: any) => !p.stickied)
        .filter((p: any) => p.score >= minScore && p.num_comments >= minComments);

      // Keyword filtering if specified
      if (keywords && keywords.length > 0) {
        const keywordRegex = new RegExp(keywords.join('|'), 'i');
        posts = posts.filter(
          (p: any) => keywordRegex.test(p.title) || keywordRegex.test(p.selftext || '')
        );
        if (posts.length > 0) {
          this.logger.debug(`Keyword match: ${posts.length} posts`);
        }
      }

      return posts.map((p: any) => ({
        id: p.permalink,
        title: p.title,
        url: `https://reddit.com${p.permalink}`,
        score: p.score,
        comments: p.num_comments,
        author: p.author,
        created: new Date(p.created_utc * 1000).toISOString(),
        summary: (p.selftext || '[External Link]').substring(0, 300).replace(/\n/g, ' '),
        source: `r/${p.subreddit}`,
      }));
    } catch (err: any) {
      this.logger.error({ error: err.message }, 'Reddit fetch error');
      return [];
    }
  }

  /**
   * Fetch Hacker News top stories
   */
  async fetchHackerNews(limit = 15): Promise<HNStory[]> {
    try {
      this.logger.debug('Fetching Hacker News...');

      // Get top story IDs
      const topRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
      if (!topRes.ok) throw new Error(`HTTP ${topRes.status}`);
      const topIds = await topRes.json();

      const results: HNStory[] = [];
      for (const id of topIds.slice(0, limit)) {
        try {
          const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          if (!res.ok) continue;
          const story = await res.json();

          if (story && story.type === 'story') {
            results.push({
              id: `hn:${story.id}`,
              title: story.title,
              url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
              score: story.score || 0,
              comments: story.descendants || 0,
              author: story.by,
              created: new Date(story.time * 1000).toISOString(),
              summary: `[HN Discussion: ${story.descendants || 0} comments]`,
              source: 'news.ycombinator.com',
            });
          }
        } catch {
          // Skip failed stories
        }
        await sleep(50); // Be polite to API
      }

      this.logger.debug(`Fetched ${results.length} HN stories`);
      return results;
    } catch (err: any) {
      this.logger.error({ error: err.message }, 'HN fetch error');
      return [];
    }
  }

  /**
   * Fetch GitHub releases
   */
  async fetchGitHubReleases(repos: string[]): Promise<GitHubRelease[]> {
    const results: GitHubRelease[] = [];
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    this.logger.debug('Fetching GitHub releases...');

    for (const repo of repos) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
          headers: {
            'User-Agent': 'AIBot-IntelGatherer/3.0',
            Accept: 'application/vnd.github.v3+json',
          },
        });

        if (!res.ok) {
          if (res.status === 404) continue; // No releases
          throw new Error(`HTTP ${res.status}`);
        }

        const release = await res.json();
        const published = new Date(release.published_at).getTime();

        // Include if released in last 7 days
        if (now - published < 7 * ONE_DAY) {
          results.push({
            repo: repo,
            version: release.tag_name,
            url: release.html_url,
            published: release.published_at,
            body: (release.body || '').substring(0, 500).replace(/\n/g, ' '),
            isRecent: now - published < ONE_DAY,
          });
        }
      } catch (err: any) {
        this.logger.warn({ error: err.message, repo }, 'GitHub fetch error');
      }
      await sleep(100);
    }

    this.logger.debug(`Fetched ${results.length} recent releases`);
    return results;
  }

  /**
   * Collect all intelligence data
   */
  async collect(sources: SourcesConfig): Promise<IntelData> {
    const date = new Date().toISOString().split('T')[0];
    const redditData: Record<string, RedditPost[]> = {};
    let totalPosts = 0;

    // Collect Reddit data
    if (sources.reddit?.communities) {
      this.logger.info('Collecting Reddit communities...');
      for (const sub of sources.reddit.communities) {
        this.logger.debug(`Fetching r/${sub.name}...`);
        redditData[sub.name] = await this.fetchReddit(sub.url, {
          minScore: sub.filter_min_score,
          minComments: sub.filter_min_comments,
        });
        totalPosts += redditData[sub.name].length;
        await sleep(800); // Be polite
      }
    }

    // Collect Hacker News
    this.logger.info('Collecting Hacker News...');
    const hnData = await this.fetchHackerNews(15);
    await sleep(500);

    // Collect GitHub releases
    this.logger.info('Collecting GitHub releases...');
    const repos = sources.github?.release_tracking?.map((r) => r.repo) || [];
    const githubData = await this.fetchGitHubReleases(repos);

    this.logger.info({
      reddit: totalPosts,
      hn: hnData.length,
      github: githubData.length,
    }, 'Collection complete');

    return {
      reddit: redditData,
      hn: hnData,
      github: githubData,
      date,
    };
  }
}
