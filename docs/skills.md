# Building Skills

This guide explains how to create custom skills for the AIBot Framework.

## Quick Start

The fastest way to create a new skill:

```bash
bun run add-skill
```

This will interactively create a skill template.

## Skill Structure

Every skill must have:

```
src/skills/my-skill/
├── skill.json      # Manifest (required)
├── index.ts        # Main implementation (required)
└── README.md       # Documentation (recommended)
```

### 1. Skill Manifest (`skill.json`)

```json
{
  "id": "my-skill",
  "name": "My Skill",
  "version": "1.0.0",
  "description": "Description of what this skill does",
  "author": "Your Name",
  "main": "./index.ts",
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "someOption": {
          "type": "string",
          "description": "Description of this option"
        }
      }
    }
  }
}
```

**Required fields**:
- `id`: Unique identifier (lowercase, no spaces)
- `name`: Display name
- `version`: Semantic version
- `description`: What the skill does
- `main`: Entry point file (usually `./index.ts`)

### 2. Skill Implementation (`index.ts`)

```typescript
import type { Skill, SkillContext } from '../../core/types';

const skill: Skill = {
  id: 'my-skill',
  name: 'My Skill',
  version: '1.0.0',
  description: 'My awesome skill',

  // Optional: Called when skill loads
  async onLoad(ctx: SkillContext) {
    ctx.logger.info('My skill loaded');
  },

  // Optional: Called when skill unloads
  async onUnload() {
    console.log('My skill unloaded');
  },

  // Optional: Telegram commands
  commands: {
    mycommand: {
      description: 'Does something cool',
      async handler(args: string[], ctx: SkillContext) {
        return 'Hello from my skill!';
      },
    },
  },

  // Optional: Scheduled jobs
  jobs: [
    {
      id: 'my-daily-job',
      schedule: '0 9 * * *', // 9 AM daily
      async handler(ctx: SkillContext) {
        ctx.logger.info('Running daily job');
      },
    },
  ],

  // Optional: Handle non-command messages
  async onMessage(message, ctx) {
    if (message.text.includes('hello')) {
      await ctx.telegram.sendMessage(
        message.chat.id,
        'Hello back!'
      );
    }
  },
};

export default skill;
```

## Skill Context

Every skill receives a `SkillContext` with access to framework services:

```typescript
interface SkillContext {
  config: unknown;          // Skill-specific config
  logger: Logger;           // Contextual logger
  ollama: OllamaClient;     // AI inference
  telegram: TelegramClient; // Telegram API
  data: DataStore;          // Persistent storage
  skillId: string;          // Your skill ID
}
```

### Using the Logger

```typescript
async handler(args: string[], ctx: SkillContext) {
  ctx.logger.debug('Debug message');
  ctx.logger.info('Info message');
  ctx.logger.warn({ user: 123 }, 'Warning message');
  ctx.logger.error({ error }, 'Error message');
}
```

### Using Ollama (AI)

```typescript
async handler(args: string[], ctx: SkillContext) {
  const question = args.join(' ');

  const response = await ctx.ollama.generate(question, {
    system: 'You are a helpful assistant',
    temperature: 0.7,
    maxTokens: 1000,
  });

  return response;
}
```

### Using Telegram Client

```typescript
async handler(args: string[], ctx: SkillContext) {
  // Send message
  await ctx.telegram.sendMessage(
    chatId,
    'Hello!',
    { parse_mode: 'Markdown' }
  );

  // Send document
  await ctx.telegram.sendDocument(
    chatId,
    Buffer.from('file content'),
    { filename: 'report.txt' }
  );
}
```

### Using Data Store

```typescript
async handler(args: string[], ctx: SkillContext) {
  // Set data
  ctx.data.set('key', { value: 123 });

  // Get data
  const data = ctx.data.get<{ value: number }>('key');

  // Check if exists
  if (ctx.data.has('key')) {
    // ...
  }

  // Delete
  ctx.data.delete('key');
}
```

## Command Handlers

Commands are registered automatically:

```typescript
commands: {
  // Simple command: /hello
  hello: {
    description: 'Say hello',
    async handler(args, ctx) {
      return '👋 Hello!';
    },
  },

  // Command with arguments: /echo hello world
  echo: {
    description: 'Echo your message',
    async handler(args, ctx) {
      if (args.length === 0) {
        return 'Usage: /echo <message>';
      }
      return args.join(' ');
    },
  },

  // Complex command with subcommands
  admin: {
    description: 'Admin commands',
    async handler(args, ctx) {
      const [subcommand, ...rest] = args;

      switch (subcommand) {
        case 'stats':
          return await getStats(ctx);
        case 'reset':
          return await reset(ctx);
        default:
          return 'Unknown subcommand. Use: stats, reset';
      }
    },
  },
}
```

## Scheduled Jobs

Jobs use cron expressions:

```typescript
jobs: [
  {
    id: 'hourly-check',
    schedule: '0 * * * *', // Every hour
    async handler(ctx) {
      ctx.logger.info('Hourly check');
    },
  },
  {
    id: 'daily-report',
    schedule: '0 9 * * *', // 9 AM daily
    async handler(ctx) {
      const report = await generateReport();
      await ctx.telegram.sendMessage(
        chatId,
        report
      );
    },
  },
  {
    id: 'weekly-cleanup',
    schedule: '0 0 * * 0', // Sundays at midnight
    async handler(ctx) {
      await cleanup();
    },
  },
]
```

**Cron format**: `minute hour day month weekday`

## Configuration

Define configuration in `skill.json`:

```json
{
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "apiKey": {
          "type": "string",
          "description": "API key for external service"
        },
        "threshold": {
          "type": "number",
          "description": "Threshold value"
        }
      }
    }
  }
}
```

Access in skill:

```typescript
interface MySkillConfig {
  apiKey?: string;
  threshold?: number;
}

async handler(args, ctx) {
  const config = ctx.config as MySkillConfig;

  if (!config.apiKey) {
    return 'API key not configured';
  }

  // Use config.apiKey
}
```

User adds to `config.json`:

```json
{
  "skills": {
    "config": {
      "my-skill": {
        "apiKey": "${MY_API_KEY}",
        "threshold": 100
      }
    }
  }
}
```

## Error Handling

Always handle errors gracefully:

```typescript
async handler(args, ctx) {
  try {
    const result = await riskyOperation();
    return `✅ Success: ${result}`;
  } catch (error: any) {
    ctx.logger.error({ error: error.message }, 'Operation failed');
    return '❌ Operation failed. Please try again later.';
  }
}
```

## Best Practices

1. **Descriptive IDs**: Use clear skill IDs (e.g., `weather-forecast`, not `wf`)
2. **Meaningful Commands**: Make command names intuitive
3. **Help Messages**: Provide usage examples in responses
4. **Error Messages**: Be user-friendly, log details
5. **Logging**: Log important events, not everything
6. **Configuration**: Make skills configurable
7. **Documentation**: Write clear README files
8. **Dependencies**: Keep dependencies minimal
9. **Testing**: Test with `/intel collect` style commands
10. **Security**: Validate inputs, sanitize outputs

## Example: Weather Skill

```typescript
import type { Skill, SkillContext } from '../../core/types';

interface WeatherConfig {
  apiKey: string;
  defaultCity: string;
}

const skill: Skill = {
  id: 'weather',
  name: 'Weather Forecast',
  version: '1.0.0',
  description: 'Get weather forecasts',

  commands: {
    weather: {
      description: 'Get weather forecast',
      async handler(args, ctx) {
        const config = ctx.config as WeatherConfig;
        const city = args[0] || config.defaultCity;

        if (!city) {
          return 'Usage: /weather <city>';
        }

        try {
          const weather = await fetchWeather(city, config.apiKey);
          return `🌤️ Weather in ${city}:\nTemp: ${weather.temp}°C\n${weather.description}`;
        } catch (error: any) {
          ctx.logger.error({ error: error.message }, 'Weather fetch failed');
          return '❌ Could not fetch weather. Try again later.';
        }
      },
    },
  },
};

async function fetchWeather(city: string, apiKey: string) {
  // Implementation
  return { temp: 22, description: 'Sunny' };
}

export default skill;
```

## Publishing Skills

To share your skill:

1. Create a public repository
2. Include clear README with:
   - Installation instructions
   - Configuration options
   - Usage examples
3. Tag releases with semantic versions
4. Submit to skill marketplace (coming soon)

## Getting Help

- Check existing skills in `src/skills/` for examples
- Read the architecture docs: `docs/architecture.md`
- Join the community (link in main README)
