# Skills Directory

This directory contains all skills for the AIBot Framework.

## Available Skills

### example
Basic demonstration skill showing framework capabilities.

**Commands**:
- `/ping` - Test responsiveness
- `/echo` - Echo messages
- `/ai` - Ask AI questions
- `/status` - Show skill status

See: [example/README.md](./example/README.md)

### intel-gatherer
Intelligence collection and analysis from multiple sources (Reddit, HN, GitHub).

**Commands**:
- `/intel collect` - Run data collection
- `/intel analyze` - Analyze trends
- `/intel today` - Show today's report

**Scheduled**: Daily at 9 AM

See: [intel-gatherer/README.md](./intel-gatherer/README.md)

## Creating New Skills

The fastest way to create a new skill:

```bash
bun run add-skill
```

Or manually:

1. Create directory: `src/skills/my-skill/`
2. Add `skill.json` manifest
3. Add `index.ts` implementation
4. Add `README.md` documentation

See the [Skills Guide](../../docs/skills.md) for detailed instructions.

## Skill Structure

```
my-skill/
├── skill.json      # Manifest (required)
├── index.ts        # Main implementation (required)
├── README.md       # Documentation (recommended)
└── ...             # Additional modules
```

## Enabling Skills

Add skill ID to `config.json`:

```json
{
  "skills": {
    "enabled": ["example", "intel-gatherer", "my-skill"]
  }
}
```

## Skill Configuration

Per-skill configuration in `config.json`:

```json
{
  "skills": {
    "config": {
      "my-skill": {
        "option1": "value1",
        "option2": 123
      }
    }
  }
}
```

## Documentation

- **Architecture**: [docs/architecture.md](../../docs/architecture.md)
- **Skills Guide**: [docs/skills.md](../../docs/skills.md)
- **Deployment**: [docs/deployment.md](../../docs/deployment.md)
