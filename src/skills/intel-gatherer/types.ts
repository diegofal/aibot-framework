// Type definitions for intel-gatherer v4.1

// ── Trigger info (who invoked the collection) ──

export interface TriggerInfo {
  source: 'telegram' | 'cron' | 'api';
  chatId?: number;
  userId?: number;
}

// ── Skill config (from config.json) ──

export interface IntelConfig {
  telegramChatId?: number;
  sourcesFile?: string;
  dataDir?: string;
  githubToken?: string;
}

// ── Source definitions (from sources.yml categories) ──

export interface RedditSource {
  type: 'reddit';
  name: string;
  url: string;
  min_score: number;
  min_comments: number;
  keywords?: string[];
}

export interface HNSource {
  type: 'hn';
  name: string;
  url: string;
}

export interface GitHubSource {
  type: 'github';
  repo: string;
}

export type SourceDefinition = RedditSource | HNSource | GitHubSource;

export interface CategoryConfig {
  id: string;
  name: string;
  emoji: string;
  sources: SourceDefinition[];
}

// ── sources.yml root ──

export interface AnalysisConfig {
  keywords: Record<string, string[]>;
  llm_summary?: {
    enabled: boolean;
    temperature: number;
  };
}

export interface SourcesSettings {
  github_token?: string;
  reddit_delay_ms: number;
  hn_story_limit: number;
  hn_concurrency: number;
}

export interface SourcesConfig {
  settings: SourcesSettings;
  categories: CategoryConfig[];
  analysis: AnalysisConfig;
}

// ── Collected data items ──

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

// ── Aggregated data per category ──

export interface CategoryData {
  reddit: RedditPost[];
  hn: HNStory[];
  github: GitHubRelease[];
}

export interface IntelData {
  categories: Record<string, CategoryData>;
  date: string;
}

// ── Analysis ──

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
  trends: Record<string, TrendData[]>;
  sectionSummaries?: Record<string, string>;
  llmDigest?: string;
}
