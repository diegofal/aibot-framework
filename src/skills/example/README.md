# Example Skill

A simple demonstration skill for the AIBot Framework.

## Features

This skill demonstrates the basic features of the framework:

- **Command Handlers**: Simple command-based interactions
- **AI Integration**: Using Ollama for AI-powered responses
- **Lifecycle Hooks**: onLoad and onUnload hooks
- **Logging**: Structured logging with context

## Commands

### /ping
Test bot responsiveness. Returns "Pong!" immediately.

**Usage**: `/ping`

### /echo
Echoes back your message.

**Usage**: `/echo <message>`

**Example**:
```
/echo Hello, world!
```
Returns: `🔊 Hello, world!`

### /ai
Ask the AI a question using Ollama.

**Usage**: `/ai <question>`

**Example**:
```
/ai What is the capital of France?
```

### /status
Shows skill status and available commands.

**Usage**: `/status`

## Configuration

No configuration required. This skill works out of the box.

## Development

This skill serves as a template for creating new skills. Key files:

- `skill.json` - Skill manifest
- `index.ts` - Main skill implementation
- `README.md` - Documentation

## Extending This Skill

To add more commands:

1. Add a new entry to the `commands` object
2. Implement the handler function
3. Update this README

Example:
```typescript
commands: {
  newcommand: {
    description: 'Description of command',
    async handler(args: string[], ctx: SkillContext) {
      // Your implementation
      return 'Response';
    },
  },
}
```
