# Intel-Gatherer Skill v3.0.0

Cross-platform TypeScript port of the intel-gatherer system. Collects and analyzes intelligence from multiple sources including Reddit, Hacker News, and GitHub.

## Features

- **Multi-Source Collection**: Reddit, Hacker News, GitHub releases
- **Trend Analysis**: 7-day trend detection with keyword tracking
- **Report Generation**: Markdown and HTML output
- **Scheduled Jobs**: Automatic daily collection
- **Telegram Integration**: Send daily reports to Telegram

## Commands

### /intel collect
Run intelligence collection from all configured sources.

**Example**:
```
/intel collect
```

Returns: Summary of collected posts, stories, and releases.

### /intel analyze
Analyze collected data for trends and alerts.

**Example**:
```
/intel analyze
```

Returns: Trend analysis with detected patterns.

### /intel today
Show today's intelligence report preview.

**Example**:
```
/intel today
```

## Configuration

Add to your `config.json`:

```json
{
  "skills": {
    "config": {
      "intel-gatherer": {
        "telegramChatId": 123456789,
        "sourcesFile": "./config/sources.yml",
        "dataDir": "./data/intel"
      }
    }
  }
}
```

### Configuration Options

- **telegramChatId** (optional): Chat ID for daily report notifications
- **sourcesFile** (optional): Path to sources.yml configuration (default: `./config/sources.yml`)
- **dataDir** (optional): Directory for storing collected data (default: `./data/intel`)

## Sources Configuration

The `sources.yml` file defines what data to collect:

```yaml
reddit:
  communities:
    - name: LocalLLaMA
      url: "https://www.reddit.com/r/LocalLLaMA/hot.json?limit=10"
      category: ai_models
      filter_min_score: 50
      filter_min_comments: 20

hackernews:
  direct_endpoints:
    - name: frontpage
      url: "https://hacker-news.firebaseio.com/v0/topstories.json"

github:
  release_tracking:
    - repo: langchain-ai/langchain
      url: "https://api.github.com/repos/langchain-ai/langchain/releases/latest"
```

Copy `sources.yml` to your config directory and customize as needed.

## Scheduled Jobs

The skill automatically runs daily at 9 AM with the following schedule:

```typescript
schedule: '0 9 * * *'  // 9 AM daily
```

The scheduled job:
1. Collects data from all sources
2. Generates markdown and HTML reports
3. Runs trend analysis
4. Sends report to configured Telegram chat (if configured)

## Output Structure

```
data/intel/
├── raw/              # Daily markdown reports
│   └── 2026-02-11.md
├── trends/           # Trend analysis JSON
│   └── 2026-02-11.json
├── highlights/       # Highlights summaries
└── html/             # HTML reports
    └── 2026-02-11.html
```

## Migration from v2.x (Bash)

If migrating from the bash-based intel-gatherer:

1. Copy your `sources.yml` to the new location
2. Update file paths in configuration
3. Test with `/intel collect`
4. Verify HTML output format
5. Update cron jobs to use new framework

## Improvements over v2.x

- **Cross-platform**: Pure TypeScript, no bash scripts
- **Type-safe**: Full TypeScript typing for all data structures
- **Modular**: Separated collector, analyzer, and formatter
- **Configurable**: All paths and settings in config
- **Tested**: Better error handling and logging
- **Integrated**: Works seamlessly with Telegram bot

## Development

### Adding New Sources

1. Update `sources.yml` with new source configuration
2. Add collection logic to `collector.ts` if needed
3. Update types in `types.ts`
4. Test with `/intel collect`

### Extending Analysis

1. Add new keywords to `analyzer.ts`
2. Implement custom trend detection logic
3. Update alert generation as needed

## Troubleshooting

**No data collected**:
- Check `sources.yml` exists and is valid YAML
- Verify API endpoints are accessible
- Check logs for rate limiting issues

**HTML not generated**:
- Ensure `dataDir` is writable
- Check markdown was generated successfully
- Verify no template errors in logs

**Trends not detected**:
- Ensure at least 7 days of historical data
- Check keyword list in `analyzer.ts`
- Verify markdown format is correct

## API Rate Limits

- **Reddit**: ~60 requests/minute
- **Hacker News**: No official limit (be polite)
- **GitHub**: 60 requests/hour (unauthenticated)

The collector includes delays between requests to respect rate limits.
