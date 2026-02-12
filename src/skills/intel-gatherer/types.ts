// Type definitions for intel-gatherer

export interface RedditPost {
  id: string;
  title: string;
  url: string;
  score: number;
  comments: number;
  author: string;
  created: string;
  summary: string;
  source: string;
}

export interface HNStory {
  id: string;
  title: string;
  url: string;
  score: number;
  comments: number;
  author: string;
  created: string;
  summary: string;
  source: string;
}

export interface GitHubRelease {
  repo: string;
  version: string;
  url: string;
  published: string;
  body: string;
  isRecent: boolean;
}

export interface IntelData {
  reddit: Record<string, RedditPost[]>;
  hn: HNStory[];
  github: GitHubRelease[];
  date: string;
}

export interface SourcesConfig {
  reddit?: {
    communities: Array<{
      name: string;
      url: string;
      category: string;
      filter_min_score: number;
      filter_min_comments: number;
    }>;
  };
  hackernews?: {
    direct_endpoints: Array<{
      name: string;
      url: string;
    }>;
  };
  github?: {
    release_tracking: Array<{
      repo: string;
      url: string;
    }>;
  };
}

export interface TrendData {
  keyword: string;
  type: 'new' | 'surge';
  current: number;
  historical: number;
  change: string;
  significance: 'high' | 'medium' | 'low';
}

export interface AnalysisResult {
  date: string;
  generatedAt: string;
  summary: {
    totalTrends: number;
  };
  alerts: Array<{
    type: string;
    priority: string;
    message: string;
  }>;
  trends: {
    technology: TrendData[];
    tools: TrendData[];
    crypto: TrendData[];
  };
}
