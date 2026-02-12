# Deployment Guide

This guide covers deploying AIBot Framework in production environments.

## Prerequisites

- **Bun** runtime installed (https://bun.sh)
- **Ollama** running locally or remotely
- **Telegram bot token** from @BotFather
- **Linux**, **macOS**, or **Windows** server

## Installation

### 1. Clone and Setup

```bash
cd ~/projects
git clone <your-repo> aibot-framework
cd aibot-framework
bun install
```

### 2. Run Setup Wizard

```bash
bun run setup
```

This will:
- Create `config.json` from template
- Prompt for bot tokens
- Test Ollama connection
- Create data directories
- Generate `.env` file

### 3. Customize Configuration

Edit `config/config.json`:

```json
{
  "bots": [
    {
      "id": "production-bot",
      "name": "My Production Bot",
      "token": "${TELEGRAM_BOT_TOKEN}",
      "enabled": true,
      "allowedUsers": [123456789],
      "skills": ["example", "intel-gatherer"]
    }
  ],
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434",
    "models": {
      "primary": "llama3.3",
      "fallbacks": ["mistral"]
    }
  },
  "skills": {
    "enabled": ["example", "intel-gatherer"],
    "config": {
      "intel-gatherer": {
        "telegramChatId": 123456789,
        "sourcesFile": "./config/sources.yml",
        "dataDir": "./data/intel"
      }
    }
  },
  "logging": {
    "level": "info",
    "file": "./data/logs/aibot.log"
  }
}
```

### 4. Set Environment Variables

Create `.env` file:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token-here
OLLAMA_BASE_URL=http://127.0.0.1:11434
LOG_LEVEL=info
```

### 5. Test Configuration

```bash
# Test Ollama connection
bun run scripts/test-ollama.ts

# Test bot in development mode
bun run dev
```

## Production Deployment

### Option 1: Systemd (Linux)

Create `/etc/systemd/system/aibot.service`:

```ini
[Unit]
Description=AIBot Framework
After=network.target

[Service]
Type=simple
User=yourusername
WorkingDirectory=/home/yourusername/projects/aibot-framework
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable aibot
sudo systemctl start aibot
sudo systemctl status aibot
```

View logs:

```bash
sudo journalctl -u aibot -f
```

### Option 2: PM2 (Cross-platform)

Install PM2:

```bash
bun add -g pm2
```

Create `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'aibot',
    script: 'bun',
    args: 'run start',
    cwd: '/home/yourusername/projects/aibot-framework',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
```

Start with PM2:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Monitor:

```bash
pm2 status
pm2 logs aibot
pm2 monit
```

### Option 3: Docker

Create `Dockerfile`:

```dockerfile
FROM oven/bun:1

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Create data directories
RUN mkdir -p data/logs data/intel/raw data/intel/trends data/intel/html

# Expose ports (if needed)
# EXPOSE 3000

# Start bot
CMD ["bun", "run", "start"]
```

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  aibot:
    build: .
    restart: unless-stopped
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - OLLAMA_BASE_URL=http://ollama:11434
    volumes:
      - ./config:/app/config
      - ./data:/app/data
    depends_on:
      - ollama

  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    volumes:
      - ollama_data:/root/.ollama
    ports:
      - "11434:11434"

volumes:
  ollama_data:
```

Deploy:

```bash
docker-compose up -d
docker-compose logs -f aibot
```

## Scheduling

Set up automated jobs:

```bash
bun run setup-cron
```

See [cron-setup.md](./cron-setup.md) for detailed instructions.

## Security Best Practices

### 1. Environment Variables

Never commit secrets:

```bash
# Add to .gitignore
.env
config/config.json
```

### 2. User Authorization

Restrict bot access:

```json
{
  "bots": [
    {
      "allowedUsers": [123456789, 987654321]
    }
  ]
}
```

### 3. File Permissions

```bash
chmod 600 .env
chmod 600 config/config.json
chmod 700 data/
```

### 4. Firewall Rules

If exposing ports:

```bash
sudo ufw allow 22/tcp  # SSH only
sudo ufw enable
```

### 5. Regular Updates

```bash
cd ~/projects/aibot-framework
git pull
bun install
sudo systemctl restart aibot
```

## Monitoring

### Logs

Check application logs:

```bash
tail -f data/logs/aibot.log
```

### Health Checks

Create a monitoring script:

```bash
#!/bin/bash
# health-check.sh

if ! systemctl is-active --quiet aibot; then
  echo "AIBot is down! Restarting..."
  sudo systemctl restart aibot
  # Send alert via Telegram or email
fi
```

Add to crontab:

```bash
*/5 * * * * /path/to/health-check.sh
```

### Resource Usage

Monitor with htop or similar:

```bash
htop -p $(pgrep -f "bun run start")
```

## Troubleshooting

### Bot Not Responding

1. Check bot is running:
   ```bash
   ps aux | grep "bun run start"
   ```

2. Check logs:
   ```bash
   tail -f data/logs/aibot.log
   ```

3. Verify token:
   ```bash
   curl https://api.telegram.org/bot<TOKEN>/getMe
   ```

### Ollama Connection Failed

1. Check Ollama is running:
   ```bash
   curl http://127.0.0.1:11434/api/tags
   ```

2. Test connection:
   ```bash
   bun run scripts/test-ollama.ts
   ```

3. Check firewall:
   ```bash
   sudo ufw status
   ```

### Jobs Not Running

1. Check scheduler logs:
   ```bash
   grep "scheduler" data/logs/aibot.log
   ```

2. Verify cron syntax:
   ```bash
   # Use https://crontab.guru/ to validate
   ```

3. Test job manually:
   ```bash
   bun run start --job daily-intel-collection
   ```

### High Memory Usage

1. Check skill memory leaks
2. Limit Ollama context size
3. Restart periodically:
   ```bash
   sudo systemctl restart aibot
   ```

## Backup

### What to Backup

- `config/` directory
- `data/` directory
- `.env` file
- `src/skills/` (if customized)

### Backup Script

```bash
#!/bin/bash
# backup.sh

DATE=$(date +%Y-%m-%d)
BACKUP_DIR="/backups/aibot"

mkdir -p "$BACKUP_DIR"

tar -czf "$BACKUP_DIR/aibot-$DATE.tar.gz" \
  --exclude='node_modules' \
  --exclude='data/logs/*' \
  config/ data/ .env src/skills/

echo "Backup complete: aibot-$DATE.tar.gz"
```

## Scaling

### Horizontal Scaling

Run multiple instances with different bot tokens:

```bash
# Instance 1
cd ~/aibot-1
bun run start

# Instance 2
cd ~/aibot-2
bun run start
```

### Load Balancing

Use multiple bots in one instance:

```json
{
  "bots": [
    { "id": "bot1", "token": "${BOT1_TOKEN}", "enabled": true },
    { "id": "bot2", "token": "${BOT2_TOKEN}", "enabled": true }
  ]
}
```

## Production Checklist

- [ ] Bun and Ollama installed
- [ ] Configuration file created and validated
- [ ] Environment variables set
- [ ] Allowed users configured
- [ ] Logging enabled
- [ ] Service/PM2 configured
- [ ] Scheduled jobs set up
- [ ] Firewall rules applied
- [ ] Backup script configured
- [ ] Health check monitoring
- [ ] Documentation updated

## Getting Help

- Check logs: `data/logs/aibot.log`
- Review configuration: `config/config.json`
- Test components: `bun run scripts/test-ollama.ts`
- Community support: (link in main README)
