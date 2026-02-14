#!/usr/bin/env bash
# Kill running aibot-framework bun process

pids=$(pgrep -x bun 2>/dev/null)

if [ -z "$pids" ]; then
  echo "No running bun process found."
  exit 0
fi

echo "Sending SIGTERM to: $pids"
kill $pids 2>/dev/null
sleep 1

# Check if still alive, force kill
remaining=$(pgrep -x bun 2>/dev/null)
if [ -n "$remaining" ]; then
  echo "Still alive, sending SIGKILL: $remaining"
  kill -9 $remaining 2>/dev/null
fi

echo "Done."
