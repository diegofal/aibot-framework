import type { Logger } from '../../logger';
import type {
  RedditPost,
  RedditSource,
  HNStory,
  HNSource,
  GitHubRelease,
  GitHubSource,
  IntelData,
  CategoryData,
  SourcesConfig,
} from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IntelCollector {
  private seenIds = new Set<string>();

  constructor(
    private logger: Logger,
    private githubToken?: string
  ) {}

  /**
   * Fetch Reddit posts from a single subreddit source
   */
  async fetchReddit(source: RedditSource): Promise<RedditPost[]> {
    const { url, min_score, min_comments, keywords } = source;

    try {
      const fullUrl = url.includes('?') ? url : `${url}?limit=10`;
      const res = await fetch(fullUrl, {
        headers: {
          'User-Agent': 'AIBot-IntelGatherer/4.0',
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        if (res.status === 403) {
          this.logger.warn(`Reddit rate limit (403), skipping: ${source.name}`);
          return [];
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      let posts = (data.data?.children || [])
        .map((p: any) => p.data)
        .filter((p: any) => !p.stickied)
        .filter((p: any) => p.score >= min_score && p.num_comments >= min_comments);

      // Keyword filtering if specified
      if (keywords && keywords.length > 0) {
        const keywordRegex = new RegExp(keywords.join('|'), 'i');
        posts = posts.filter(
          (p: any) => keywordRegex.test(p.title) || keywordRegex.test(p.selftext || '')
        );
      }

      return posts
        .map((p: any) => ({
          id: p.permalink,
          title: p.title,
          url: `https://reddit.com${p.permalink}`,
          score: p.score,
          comments: p.num_comments,
          author: p.author,
          created: new Date(p.created_utc * 1000).toISOString(),
          summary: (p.selftext || '[External Link]').substring(0, 300).replace(/\n/g, ' '),
          source: `r/${p.subreddit}`,
        }))
        .filter((p: RedditPost) => !this.seenIds.has(p.id));
    } catch (err: any) {
      this.logger.error({ error: err.message, source: source.name }, 'Reddit fetch error');
      return [];
    }
  }

  /**
   * Fetch Hacker News stories with parallel item fetching
   */
  async fetchHackerNews(source: HNSource, limit: number, concurrency: number): Promise<HNStory[]> {
    try {
      this.logger.debug('Fetching Hacker News...');

      const topRes = await fetch(source.url);
      if (!topRes.ok) throw new Error(`HTTP ${topRes.status}`);
      const topIds: number[] = await topRes.json();

      const ids = topIds.slice(0, limit);
      const results: HNStory[] = [];

      // Fetch in batches of `concurrency`
      for (let i = 0; i < ids.length; i += concurrency) {
        const batch = ids.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(async (id) => {
            try {
              const res = await fetch(
                `https://hacker-news.firebaseio.com/v0/item/${id}.json`
              );
              if (!res.ok) return null;
              const story = await res.json();

              if (story && story.type === 'story') {
                return {
                  id: `hn:${story.id}`,
                  title: story.title,
                  url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
                  score: story.score || 0,
                  comments: story.descendants || 0,
                  author: story.by,
                  created: new Date(story.time * 1000).toISOString(),
                  summary: `[HN Discussion: ${story.descendants || 0} comments]`,
                  source: 'news.ycombinator.com',
                } as HNStory;
              }
              return null;
            } catch {
              return null;
            }
          })
        );

        for (const story of batchResults) {
          if (story && !this.seenIds.has(story.id)) {
            results.push(story);
          }
        }
      }

      this.logger.debug(`Fetched ${results.length} HN stories`);
      return results;
    } catch (err: any) {
      this.logger.error({ error: err.message }, 'HN fetch error');
      return [];
    }
  }

  /**
   * Fetch a single GitHub repo's latest release
   */
  async fetchGitHubRelease(source: GitHubSource): Promise<GitHubRelease | null> {
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'AIBot-IntelGatherer/4.0',
        Accept: 'application/vnd.github.v3+json',
      };

      if (this.githubToken) {
        headers.Authorization = `token ${this.githubToken}`;
      }

      const res = await fetch(
        `https://api.github.com/repos/${source.repo}/releases/latest`,
        { headers }
      );

      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`HTTP ${res.status}`);
      }

      const release = await res.json();
      const published = new Date(release.published_at).getTime();

      // Include if released in last 7 days
      if (now - published < 7 * ONE_DAY) {
        const id = `gh:${source.repo}:${release.tag_name}`;
        if (this.seenIds.has(id)) return null;

        return {
          repo: source.repo,
          version: release.tag_name,
          url: release.html_url,
          published: release.published_at,
          body: (release.body || '').substring(0, 500).replace(/\n/g, ' '),
          isRecent: now - published < ONE_DAY,
        };
      }

      return null;
    } catch (err: any) {
      this.logger.warn({ error: err.message, repo: source.repo }, 'GitHub fetch error');
      return null;
    }
  }

  /**
   * Collect all intelligence data organized by category
   */
  async collect(config: SourcesConfig): Promise<IntelData> {
    const date = new Date().toISOString().split('T')[0];
    const categories: Record<string, CategoryData> = {};
    const { settings } = config;

    for (const cat of config.categories) {
      const catData: CategoryData = { reddit: [], hn: [], github: [] };

      for (const source of cat.sources) {
        switch (source.type) {
          case 'reddit': {
            this.logger.debug(`Fetching r/${source.name} [${cat.id}]...`);
            const posts = await this.fetchReddit(source);
            for (const p of posts) this.seenIds.add(p.id);
            catData.reddit.push(...posts);
            await sleep(settings.reddit_delay_ms);
            break;
          }
          case 'hn': {
            this.logger.debug(`Fetching HN ${source.name} [${cat.id}]...`);
            const stories = await this.fetchHackerNews(
              source,
              settings.hn_story_limit,
              settings.hn_concurrency
            );
            for (const s of stories) this.seenIds.add(s.id);
            catData.hn.push(...stories);
            break;
          }
          case 'github': {
            this.logger.debug(`Fetching GitHub ${source.repo} [${cat.id}]...`);
            const release = await this.fetchGitHubRelease(source);
            if (release) {
              this.seenIds.add(`gh:${source.repo}:${release.version}`);
              catData.github.push(release);
            }
            await sleep(100);
            break;
          }
        }
      }

      categories[cat.id] = catData;

      this.logger.info(
        {
          category: cat.id,
          reddit: catData.reddit.length,
          hn: catData.hn.length,
          github: catData.github.length,
        },
        'Category collected'
      );
    }

    return { categories, date };
  }
}
