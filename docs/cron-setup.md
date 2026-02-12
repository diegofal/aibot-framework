# Cron/Scheduler Setup Guide

This guide explains how to set up automated job scheduling for AIBot Framework across different platforms.

## Overview

AIBot Framework includes a built-in scheduler that runs jobs in-process. However, for reliability and system integration, you may want to use the OS scheduler:

- **Linux/Unix**: crontab
- **macOS**: launchd (or crontab)
- **Windows**: Task Scheduler

## Quick Setup

Run the setup helper:

```bash
bun run setup-cron [platform]
```

Supported platforms:
- `linux` - Generate crontab
- `darwin` / `macos` - Generate launchd plist
- `win32` / `windows` - Generate Task Scheduler XML

## Linux (crontab)

### Generate Crontab

```bash
bun run setup-cron linux
```

This creates `aibot-crontab.txt` with entries like:

```cron
# AIBot Framework - Scheduled Jobs
# Daily intel collection at 9 AM
0 9 * * * cd /home/user/projects/aibot-framework && bun run start --job daily-intel-collection >> /home/user/projects/aibot-framework/data/logs/cron.log 2>&1
```

### Install

```bash
# Open crontab editor
crontab -e

# Copy contents from aibot-crontab.txt
# Save and exit
```

### Verify

```bash
# List installed crontabs
crontab -l

# Watch cron logs
tail -f data/logs/cron.log
```

### Cron Syntax

```
┌───────────── minute (0-59)
│ ┌──────────── hour (0-23)
│ │ ┌─────────── day of month (1-31)
│ │ │ ┌────────── month (1-12)
│ │ │ │ ┌───────── day of week (0-7, Sun=0 or 7)
│ │ │ │ │
* * * * * command
```

**Examples**:
- `0 9 * * *` - 9 AM daily
- `*/15 * * * *` - Every 15 minutes
- `0 0 * * 0` - Sundays at midnight
- `0 */6 * * *` - Every 6 hours

### Environment Variables

Cron has a minimal environment. Set variables in crontab:

```cron
TELEGRAM_BOT_TOKEN=your-token
OLLAMA_BASE_URL=http://127.0.0.1:11434

0 9 * * * cd /path/to/aibot && bun run start --job daily-intel-collection
```

Or source from .env:

```cron
0 9 * * * cd /path/to/aibot && source .env && bun run start --job daily-intel-collection
```

## macOS (launchd)

### Generate Plist

```bash
bun run setup-cron macos
```

This creates `com.aibot.daily-intel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aibot.daily-intel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/bun</string>
    <string>run</string>
    <string>start</string>
    <string>--job</string>
    <string>daily-intel-collection</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <!-- ... -->
</dict>
</plist>
```

### Install

```bash
# Copy to LaunchAgents
cp com.aibot.daily-intel.plist ~/Library/LaunchAgents/

# Load service
launchctl load ~/Library/LaunchAgents/com.aibot.daily-intel.plist

# Start immediately (optional)
launchctl start com.aibot.daily-intel
```

### Verify

```bash
# List loaded services
launchctl list | grep aibot

# Check logs
tail -f data/logs/cron.log
```

### Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.aibot.daily-intel.plist
rm ~/Library/LaunchAgents/com.aibot.daily-intel.plist
```

## Windows (Task Scheduler)

### Generate XML

```bash
bun run setup-cron windows
```

This creates `aibot-task.xml`.

### Install via GUI

1. Open **Task Scheduler** (search in Start menu)
2. Click **Action** → **Import Task...**
3. Select `aibot-task.xml`
4. Review settings:
   - **Triggers**: Daily at 9:00 AM
   - **Actions**: Run `bun run start --job daily-intel-collection`
   - **Conditions**: Adjust as needed
5. Click **OK**

### Install via Command Line

```powershell
schtasks /create /tn "AIBot-DailyIntel" /xml aibot-task.xml
```

### Verify

```powershell
# List tasks
schtasks /query /fo LIST /v | findstr "AIBot"

# Run manually
schtasks /run /tn "AIBot-DailyIntel"

# Check logs
Get-Content data\logs\cron.log -Tail 50 -Wait
```

### Modify Schedule

```powershell
# Delete old task
schtasks /delete /tn "AIBot-DailyIntel" /f

# Edit XML and re-import
schtasks /create /tn "AIBot-DailyIntel" /xml aibot-task.xml
```

## Using Built-in Scheduler

Instead of OS scheduler, use the built-in scheduler:

**Pros**:
- Simpler setup
- Cross-platform
- Jobs run in-process (shared state)

**Cons**:
- Bot must be running continuously
- No execution if bot crashes
- Less system integration

To use built-in scheduler:

1. Ensure skills define jobs:

```typescript
jobs: [
  {
    id: 'daily-report',
    schedule: '0 9 * * *',
    async handler(ctx) {
      // Job logic
    },
  },
]
```

2. Start bot normally:

```bash
bun run start
```

Jobs will run automatically.

## Best Practices

### 1. Logging

Always log cron job output:

```bash
# Append to log file
command >> data/logs/cron.log 2>&1

# Separate logs per job
command >> data/logs/job-name.log 2>&1
```

### 2. Error Notifications

Send notifications on failure:

```bash
#!/bin/bash
# run-job.sh

cd /path/to/aibot
bun run start --job daily-intel-collection

if [ $? -ne 0 ]; then
  # Send error notification
  echo "Job failed at $(date)" >> data/logs/errors.log
fi
```

### 3. Lock Files

Prevent concurrent execution:

```bash
#!/bin/bash
LOCKFILE=/tmp/aibot-job.lock

if [ -f "$LOCKFILE" ]; then
  echo "Job already running"
  exit 1
fi

touch "$LOCKFILE"
bun run start --job daily-intel-collection
rm "$LOCKFILE"
```

### 4. Retry Logic

Retry failed jobs:

```bash
#!/bin/bash
MAX_RETRIES=3
RETRY=0

while [ $RETRY -lt $MAX_RETRIES ]; do
  bun run start --job daily-intel-collection && break
  RETRY=$((RETRY+1))
  echo "Retry $RETRY/$MAX_RETRIES" >> data/logs/retries.log
  sleep 60
done
```

### 5. Environment Consistency

Ensure same environment as interactive shell:

```bash
# Source user profile
source ~/.bashrc
cd /path/to/aibot
bun run start --job daily-intel-collection
```

## Troubleshooting

### Job Not Running

**Check cron/scheduler status**:

```bash
# Linux
systemctl status cron

# macOS
launchctl list | grep aibot

# Windows
schtasks /query /tn "AIBot-DailyIntel"
```

**Check logs**:

```bash
# Application logs
tail -f data/logs/aibot.log

# Cron logs
tail -f data/logs/cron.log

# System logs (Linux)
tail -f /var/log/syslog | grep CRON
```

### Path Issues

Cron doesn't inherit PATH. Use absolute paths:

```bash
# Bad
bun run start --job daily-intel-collection

# Good
/usr/local/bin/bun run start --job daily-intel-collection
```

Or set PATH in crontab:

```cron
PATH=/usr/local/bin:/usr/bin:/bin

0 9 * * * cd /path/to/aibot && bun run start --job daily-intel-collection
```

### Permission Issues

Ensure files are readable:

```bash
chmod +x /path/to/aibot/scripts/run-job.sh
chmod 644 /path/to/aibot/config/config.json
```

### Timezone Confusion

Cron uses system timezone. Verify:

```bash
# Linux
timedatectl

# macOS
systemsetup -gettimezone

# Windows
tzutil /g
```

## Monitoring

### Email Notifications (Linux)

Install and configure mail:

```bash
sudo apt-get install mailutils
```

Cron will email output to user. Disable with:

```cron
MAILTO=""
```

### Healthchecks.io Integration

Use external monitoring:

```bash
#!/bin/bash
curl -fsS --retry 3 https://hc-ping.com/your-uuid-here

cd /path/to/aibot
bun run start --job daily-intel-collection

curl -fsS --retry 3 https://hc-ping.com/your-uuid-here/$?
```

### Custom Monitoring

Create a monitoring endpoint:

```typescript
// Add to skill
commands: {
  healthcheck: {
    description: 'Health check endpoint',
    async handler(args, ctx) {
      const lastRun = ctx.data.get<Date>('lastJobRun');
      const status = lastRun
        ? `Last run: ${lastRun.toISOString()}`
        : 'Never run';
      return `✅ Healthy\n${status}`;
    },
  },
}
```

## Multiple Jobs

If you have multiple jobs:

```bash
# Separate files per job
0 9 * * * cd /path/to/aibot && bun run start --job daily-intel-collection
0 12 * * * cd /path/to/aibot && bun run start --job midday-update
0 0 * * 0 cd /path/to/aibot && bun run start --job weekly-cleanup
```

Or use a wrapper script:

```bash
#!/bin/bash
# run-jobs.sh

JOBS=("daily-intel-collection" "midday-update")

for job in "${JOBS[@]}"; do
  echo "Running $job at $(date)"
  bun run start --job "$job"
done
```

## Resources

- [Crontab.guru](https://crontab.guru/) - Cron expression tester
- [Launchd.info](http://www.launchd.info/) - macOS launchd guide
- [Task Scheduler](https://docs.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page) - Windows docs
