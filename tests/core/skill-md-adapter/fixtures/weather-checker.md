---
name: weather-checker
version: 1.0.0
description: Check current weather and forecasts. Use when user asks about weather conditions, forecasts, or recommendations based on weather.
metadata:
  aibot:
    emoji: "🌤️"
    category: "web"
    requires:
      anyBins: ["curl", "wget"]
    maxRetries: 2
---

# Weather Checker Skill

You help users check weather conditions and provide recommendations.

## Guidelines

- Always ask for location if not provided
- Convert units based on user's preference (default to metric)
- Provide brief recommendations (umbrella, jacket, etc.)

## Tools

### get-current-weather

**Description:** Fetch current weather for a location using OpenWeatherMap API
**Parameters:**
- `location` (string, required): City name or coordinates (lat,lon)
- `units` (string, optional): "metric" | "imperial", default: `"metric"`

**Implementation:** `scripts/fetch-weather.ts`

### get-forecast

**Description:** Get 5-day weather forecast
**Parameters:**
- `location` (string, required): City name
- `days` (number, optional): Days to forecast (1-5), default: `3`

**Implementation:** `scripts/fetch-forecast.ts`
