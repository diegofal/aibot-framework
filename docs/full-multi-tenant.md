# Multi-Tenant BaaS Architecture — Planning & Tracker

> **Created**: 2026-03-05
> **Branch**: `feat/baas-multi-tenant`
> **Status**: Phase 3.9 complete — BaaS Dashboard Pages + Chat UI. Phase 4 next.

This document is the **living tracker** for the BaaS multi-tenant feature. All work happens on the `feat/baas-multi-tenant` branch. Items are marked as completed when the corresponding code lands.

### Working Agreements

- All BaaS multi-tenant work happens on branch `feat/baas-multi-tenant`
- When a task is completed in code, mark it `[x]` in this file in the same commit (or the next)
- Tasks in progress are marked `[~]`
- Each completed task gets a dated entry in the [Change Log](#change-log) at the bottom
- This file is the single source of truth for planning, tracking, and architectural decisions

---

## Table of Contents

1. [Strategic Position](#strategic-position)
2. [Current Architecture Assessment](#current-architecture-assessment)
3. [Tenancy Model Decision](#tenancy-model-decision)
4. [End-User Isolation Gaps](#end-user-isolation-gaps)
5. [Multi-Tenant Infrastructure Gaps](#multi-tenant-infrastructure-gaps)
6. [Channel & API Gaps](#channel--api-gaps)
7. [Target Use Cases](#target-use-cases)
8. [Roadmap](#roadmap)
9. [Change Log](#change-log)

---

## Strategic Position

### Moat: the Soul system

The framework's differentiator is persistent personality — soul/memory/goals make bots that **accumulate value over time**. Replacing a bot that knows 6 months of context has high switching cost.

This moat does NOT apply to commodity use cases (FAQ bots, cart recovery, ticket routing). Those compete against Intercom, Zendesk AI, HubSpot AI which already have deep integrations.

### Where soul bots win

Use cases where **the relationship is the value** and each interaction makes the bot more useful:

| Vertical | Use Case | Why Soul Matters |
|----------|----------|-----------------|
| **AI Coaches** | Sales coach, onboarding mentor, language tutor | Memory of progress + personality that motivates + evolving goals |
| **AI Account Managers** | Customer success, proactive account management | Agent loop + accumulated client knowledge + proactive outreach |
| **AI Brand Personas** | Content creator, community manager, influencer | Consistent personality + productions + audience memory |
| **AI Professional Assistants** | Research analyst, executive assistant, legal/medical aide | Accumulated domain knowledge + autonomous research |

### Where NOT to compete

- **Tier 1 support / FAQ** — commodity, no soul needed, incumbents have deep integrations
- **Cart recovery / NPS** — transactional flows, no personality needed
- **IT helpdesk** — password resets don't need memory, just AD/LDAP/Jira integration

---

## Current Architecture Assessment

### What works today

| Capability | Status | Notes |
|-----------|--------|-------|
| Multi-tenant facade (TenantFacade, TenantManager) | Functional with bugs | CRUD, API keys, plans |
| Agent loop (planner → strategist → executor) | Solid | Periodic + continuous modes |
| Soul/Memory (identity, personality, goals, daily logs) | Solid | Per-bot isolation |
| Tool ecosystem (40+ tools, categories, MCP) | Solid | Extensible via MCP servers |
| Bot lifecycle (create, start, stop, export/import) | Functional | Per-bot |
| Stripe billing + onboarding | Functional | Webhooks, plans |
| Conversations API (web dashboard chat) | Functional | Internal-style (create → send → poll) |
| Bot-to-bot collaboration | Functional | Visible, internal, MCP |
| Human-in-the-loop (ask_human, ask_permission) | Functional | |
| Loop detection, context compaction, safety | Solid | 4-strategy loop detector |
| Productions (artifact tracking) | Functional | Changelog, evaluation, threads |
| Dashboard SPA | Functional | 17+ pages |
| Per-user core memory | Functional | `user_id` column, SQL isolation |

### What's broken or incomplete

See [Multi-Tenant Infrastructure Gaps](#multi-tenant-infrastructure-gaps) and [End-User Isolation Gaps](#end-user-isolation-gaps).

---

## Tenancy Model Decision

### Actors

| Actor | Role | Example |
|-------|------|---------|
| **Platform** (us) | Build and maintain the framework, provide templates | — |
| **Customer** (tenant) | Business that buys a bot for their use case | SaaS company, sales agency |
| **End User** | Person actually talking to the bot | Employee, client of the customer |

### Models evaluated

#### Model A: One bot per tenant (natural for soul bots)

Each tenant gets their own bot instance with its own soul copy.

```
Template: "Sales Coach Pro" (soul base + skills + tools)
 ├── Tenant A → Bot instance (customized soul, own memory, own goals)
 │    ├── End User 1 → core_memory + sessions
 │    └── End User 2 → core_memory + sessions
 ├── Tenant B → Bot instance (different customizations)
 └── ...
```

- **Pros**: Strong isolation, each tenant's bot evolves independently, export/import works naturally
- **Cons**: Doesn't scale past ~50-100 tenants (each bot = polling loop + agent loop cycle), LLM cost multiplied

#### Model B: One bot shared across tenants (discarded)

One soul shared by all tenants. Data isolated per tenant at row level.

- **Discarded**: Destroys the soul value proposition. No per-tenant personality evolution.

#### Model C: Hybrid — Soul template + per-tenant overlay (target architecture)

```
Template: "Sales Coach Pro"
 │   IDENTITY.md (base personality)
 │   SOUL.md (base boundaries)
 │   MOTIVATIONS.md (base drives)
 │   skills + tools (shared)
 │
 ├── Tenant A → overlay
 │    │   IDENTITY_OVERRIDE.md (name, tone)
 │    │   KNOWLEDGE/ (company docs, products, processes)
 │    │   GOALS.md (tenant-specific goals)
 │    │   RULES.md (tenant-specific boundaries)
 │    ├── End User 1 → core_memory + sessions + per-user daily logs
 │    └── End User 2 → core_memory + sessions + per-user daily logs
 └── Tenant B → different overlay
```

- **Pros**: Scales like Model B (template shared, composition at runtime), customizable like Model A, template updates propagate automatically
- **Cons**: More complex (merge logic, conflict resolution, template versioning), agent loop scheduling per-tenant or stateless

### Decision: Start with Model A, design toward Model C

| Phase | Model | Scale | Why |
|-------|-------|-------|-----|
| Phase 1 | Model A (one bot per tenant) | 1–50 tenants | Simplest path to first paying customers |
| Phase 2 | Model A optimized (workers) | 50–500 tenants | Process isolation, shared-nothing |
| Phase 3 | Model C (template + overlay) | 500+ tenants | Template system, overlay composition, efficient scaling |

---

## End-User Isolation Gaps

Within a single bot serving multiple end users, there are **4 data leak points** where User A's information can bleed into User B's context.

### What IS isolated (when `userIsolation.enabled = true`)

| Layer | Mechanism | Status |
|-------|-----------|--------|
| Conversation history | Session key `bot:{botId}:private:{userId}` | Isolated |
| Core memory reads | SQL `WHERE (user_id = ? OR user_id IS NULL)` | Isolated |
| Core memory writes | SQL `WHERE user_id = ?` | Isolated |
| Core memory in system prompt | `renderForSystemPrompt(800, botId, userId)` | Isolated |
| Memory search tool | `_userId` injected, passed to search | Isolated |
| Daily memory writes (with userId) | `appendDailyMemory(fact, userId)` → `memory/users/{userId}/` | Isolated |

### What is NOT isolated (4 leak points)

#### Leak 1: Memory flush writes to shared log without userId

**File**: `src/bot/memory-flush.ts:62`

```typescript
soulLoader.appendDailyMemory(summary.trim());
// Missing: should pass userId
```

When User A's session expires or compacts, the conversation summary is written to the **shared** daily log (`memory/YYYY-MM-DD.md`) without `userId`. User A's conversation summary ends up in the global log.

**Fix**: Pass `userId` through the flush pipeline. `flushSessionToMemory` and `flushWithScoring` need a `userId` parameter.

#### Leak 2: readRecentDailyLogs reads shared log without filtering

**File**: `src/soul.ts:319-328`

```typescript
readRecentDailyLogs(): string {
  const memoryDir = join(this.dir, 'memory');
  // Reads from memory/YYYY-MM-DD.md — the SHARED log
  // Does NOT read from memory/users/{userId}/
}
```

The shared daily log (containing all users' flushed conversations) is injected into the system prompt for ALL users via `composeSystemPrompt()`.

**Fix**: `readRecentDailyLogs(userId?)` should read from per-user dir when userId is provided, plus the shared log (for bot-level entries like agent loop actions).

#### Leak 3: RAG pre-fetch doesn't pass userId

**File**: `src/bot/conversation-pipeline.ts:61-66`

```typescript
const results = await this.ctx.memoryManager.search(
  query,
  ragConfig.maxResults,
  ragConfig.minScore,
  botId
  // Missing: userId
);
```

`prefetchMemoryContext()` searches semantic memory with only `botId`. The indexed daily logs (shared, containing all users' data) can surface in any user's RAG context.

**Fix**: Pass `userId` to `memoryManager.search()` in `prefetchMemoryContext()`. Requires the userId to be available earlier in the pipeline (before the RAG pre-fetch starts).

#### Leak 4: save_memory tool doesn't pass userId

**File**: `src/tools/soul.ts:62-65`

```typescript
const soulLoader = getSoulLoader(botId);
soulLoader.appendDailyMemory(fact);
// Missing: should pass userId from args._userId
```

When the bot decides to save something to memory via the `save_memory` tool, it writes to the shared daily log without `userId`.

**Fix**: Read `args._userId` and pass it to `appendDailyMemory(fact, userId)`.

### Leak flow visualization

```
User A: "I'm Juan, my pipeline has $500k in deals"
  │
  ├─► Session (isolated)
  ├─► Core memory (isolated) — "relationships.name = Juan" with user_id='A'
  ├─► save_memory tool [LEAK] — "Juan has $500k pipeline" → memory/2026-03-05.md (SHARED)
  └─► Session flush [LEAK] — Conversation summary → memory/2026-03-05.md (SHARED)
         │
         ▼
User B: talks to the bot
  ├─► System prompt includes readRecentDailyLogs() [LEAK] — sees "Juan has $500k pipeline"
  └─► RAG search may match [LEAK] — query about "pipeline" can surface User A's data
```

---

## Multi-Tenant Infrastructure Gaps

### 6 critical fixes

| # | Issue | File(s) | Severity |
|---|-------|---------|----------|
| 1 | **`resolveAgentConfigWithTenant` is dead code** — exists but never called in startup. All bots use `resolveAgentConfig` which ignores tenant paths. | `src/bot/bot-manager.ts`, `src/config.ts` | Critical |
| 2 | **Rate limiter reads wrong key** — uses `c.get('tenantId')` but auth middleware sets `c.set('tenant', { tenantId, ... })`. Rate limiting never applies. | `src/tenant/rate-limit-middleware.ts` | High |
| 3 | **Export route has no tenant check** — bot selection by `id` only, no verification that the bot belongs to the requesting tenant. Cross-tenant export possible if `botId` is known. | `src/web/routes/agents.ts` (export route) | High |
| 4 | **`_tenantRoot` injected but never validated** — `isPathWithinTenant()` exists in `tenant-paths.ts` but no tool calls it. File tools don't enforce tenant sandboxing. | `src/bot/tool-executor.ts`, `src/tools/files.ts` | High |
| 5 | **Agent loop executor lacks tenant/user context** — `ToolExecutor` for agent loop is created without `tenantRoot` or `userId`. Autonomous tool calls have no tenant path restriction. | `src/bot/agent-loop.ts` | High |
| 6 | **Shared data directories** — sessions, memory DB, and productions all live in global dirs. No per-tenant data isolation on the filesystem. | `src/session.ts`, `src/memory/`, `src/productions/` | Medium |

### Additional infrastructure issues

| Issue | Impact |
|-------|--------|
| No monthly usage reset job/cron | Metering accumulates forever |
| Storage metering incomplete (`storage_write` events not wired) | Can't enforce storage quotas |
| Tenant deletion route doesn't stop bots (uses `tenantManager.deleteTenant()` directly, not `TenantFacade.deleteTenant()`) | Orphaned running bots |
| Per-tenant BYOK (TenantConfigStore, resolveAgentConfigWithTenant) not integrated | Tenants can't bring their own LLM keys |
| Single process for all bots | One crash affects all tenants |

---

## Channel & API Gaps

### Current channels

| Channel | Status |
|---------|--------|
| Telegram (grammy + TelegramPoller) | Only channel. Polling-based. |
| Web dashboard chat (ConversationsService) | Internal-style, not embeddable. |

### Missing for BaaS

| Gap | Priority | Notes |
|-----|----------|-------|
| **Channel abstraction layer** | P0 | Pipeline is coupled to grammy `Context`. `MessageBuffer.enqueue()` requires grammy `ctx`. Need a `Channel` interface. |
| **Web widget (embeddable)** | P0 | Easiest channel to implement, enables all use cases. WebSocket-based. |
| **Public REST Chat API** (`/api/v1/chat`) | P0 | Synchronous request/response (or SSE streaming). Current Conversations API is internal. |
| **WhatsApp Business API** adapter | P1 | 6 of 10 original use cases need it. |
| **Outbound webhooks** | P1 | Notify external systems of events (new message, production, goal completed). |
| **OpenAPI/Swagger docs** | P1 | No API documentation for external consumers. |
| **API versioning** (`/api/v1/`) | P1 | No versioning currently. |
| **LLM response streaming** (SSE) | P2 | Better UX for real-time chat. |
| **Client SDKs** (JS/Python) | P2 | For external integrators. |
| **Email channel** | P2 | HR, IT helpdesk use cases. |
| **Slack adapter** | P3 | Enterprise internal use cases. |

### Missing domain tools (addressable via MCP servers)

| Domain | Tools needed |
|--------|-------------|
| CRM | HubSpot/Salesforce: leads, contacts, deals, pipeline |
| E-commerce | Shopify/WooCommerce: orders, products, tracking, returns |
| Booking | Calendly/Acuity: availability, scheduling, confirmation |
| Helpdesk | Zendesk/Jira: tickets, status, escalation |
| HR | BambooHR/Personio: PTO, policies, employee data |
| Surveys | NPS scoring, feedback collection, alerting |
| Payments | Stripe/MercadoPago: invoices, refunds, status |

---

## Target Use Cases

### Primary verticals (Phase 1)

| Vertical | Flagship Use Case | Current Readiness | Key Dependencies |
|----------|-------------------|-------------------|------------------|
| AI Coaches | Sales coach for teams | 30% | User isolation fixes, web widget, per-user memory |
| AI Account Managers | Proactive customer success | 25% | Agent loop tenant isolation, outbound webhooks, CRM tools |
| AI Brand Personas | Community manager / content creator | 50% | Already partially working (MFM, Cryptik bots are prototypes) |

### Secondary verticals (Phase 2+)

| Vertical | Use Case | Key Dependencies |
|----------|----------|------------------|
| AI Professional Assistants | Research analyst, executive assistant | Memory search improvements, productions, calendar |
| AI Onboarding Mentors | SaaS user onboarding | Web widget, goal tracking, analytics |

---

## Roadmap

### Phase 1 — Fix Foundation (enables first paying customers)

**Goal**: Proper tenant and user isolation. No data leaks.

- [x] 1.1 — Fix end-user isolation leak: memory flush (`memory-flush.ts` — pass userId)
- [x] 1.2 — Fix end-user isolation leak: `readRecentDailyLogs` (`soul.ts` — accept userId, read per-user dir)
- [x] 1.3 — Fix end-user isolation leak: RAG pre-fetch (`conversation-pipeline.ts` — pass userId to search)
- [x] 1.4 — Fix end-user isolation leak: `save_memory` tool (`tools/soul.ts` — pass `_userId`)
- [x] 1.5 — Wire `resolveAgentConfigWithTenant` in `bot-manager.ts startBot()`
- [x] 1.6 — Fix rate limiter bug (`c.get('tenantId')` → `c.get('tenant')?.tenantId`)
- [x] 1.7 — Add tenant check to export route
- [x] 1.8 — Enforce `isPathWithinTenant()` in file tools
- [x] 1.9 — Pass `tenantRoot` and `userId` to agent loop executor
- [x] 1.10 — Per-tenant data directories: soul/work dirs tenant-scoped via `resolveTenantPaths()`. Session transcripts organized in per-bot subdirectories (`transcripts/{botId}/`) with backward-compat fallback. Productions use `botConfig.workDir` (tenant-resolved). Memory DB uses query-level isolation (`bot_id`+`user_id` columns, all queries filtered).
- [x] 1.11 — Tests for all isolation boundaries

### Phase 2 — Channel Abstraction (enables non-Telegram use cases)

**Goal**: Channel-agnostic message pipeline. At least one non-Telegram channel.

- [x] 2.1 — Define `Channel` interface (`src/channel/types.ts`: `InboundMessage`, `Channel`, `ChannelKind`)
- [x] 2.2 — Refactor conversation pipeline to accept channel-agnostic messages (`handleChannelMessage()` + Telegram/REST adapters)
- [x] 2.3 — Embeddable web widget (`/ws/chat` WebSocket + `web/widget.js` self-contained embed)
- [x] 2.4 — Public REST Chat API (`POST /api/v1/chat/:botId`) with sync response
- [x] 2.5 — API versioning (`/api/v1/` prefix established)
- [x] 2.6 — OpenAPI spec (`GET /api/v1/openapi.json`)

### Phase 3 — BaaS Platform (enables self-service)

**Goal**: Customers can sign up, create bots from templates, customize, and serve their end users.

- [x] 3.1 — Bot template system (`src/tenant/template-service.ts`: CRUD + instantiation + version tracking)
- [x] 3.2 — Template versioning and update propagation (version bump on config change, `hasUpdate()` per instance)
- [x] 3.3 — Tenant customization layer (`src/tenant/customization.ts`: identity override, knowledge, goals, rules → system prompt overlay via `SystemPromptBuilder`)
- [x] 3.4 — Outbound webhooks (`src/tenant/webhook-service.ts`: register/emit, HMAC signatures, retry with backoff, auto-disable on failures)
- [x] 3.5 — WhatsApp Business API adapter (`src/channel/whatsapp.ts`: inbound message conversion, outbound via Cloud API, webhook signature verification; `src/web/routes/whatsapp-webhook.ts`: GET verification + POST inbound; per-bot `whatsapp` config with phoneNumberId/accessToken/verifyToken/appSecret)
- [x] 3.6 — Monthly usage rotation (`TenantManager.rotateUsage()`, auto-runs on startup via `TenantFacade`)
- [x] 3.7 — Analytics/reporting (`src/tenant/analytics-service.ts`: event recording, tenant-scoped JSONL storage, aggregation engine. Metrics: conversations, messages, unique users, resolution rate, tool usage, errors, per-day breakdowns, per-bot drill-down. API: `GET /api/baas/analytics/:tenantId`, `GET /api/baas/analytics/:tenantId/:botId`, `GET /api/baas/analytics/:tenantId/current-month`. Events emitted from `BotManager.handleChannelMessage()`)
- [x] 3.8 — Cross-bot isolation: `seenUsers` scoped by botId, `AskHumanStore` scoped by `botId:chatId`, `ProductionsService` path traversal protection

### Phase 3.9 — BaaS Dashboard Pages + Chat UI

**Goal**: Dashboard UI for all BaaS services + direct bot chat from the dashboard.

- [x] 3.9.1 — Chat page (`web/pages/chat.js`: bot selector, `renderThread()` integration, `POST /api/v1/chat/:botId`)
- [x] 3.9.2 — BaaS Templates page (`web/pages/baas-templates.js`: list, detail, CRUD modals, instantiate)
- [x] 3.9.3 — BaaS Webhooks page (`web/pages/baas-webhooks.js`: CRUD, health badges, toggle enabled)
- [x] 3.9.4 — BaaS Customizations page (`web/pages/baas-customizations.js`: card layout, inline editor with list editors for knowledge/goals/rules)
- [x] 3.9.5 — BaaS Analytics page (`web/pages/baas-analytics.js`: metrics cards, pure CSS bar charts, breakdown tables, date range + bot filter)

### Phase 4 — Scale & Optimize (Model C transition)

**Goal**: Efficient multi-tenant architecture for 500+ tenants.

- [ ] 4.1 — Soul template + overlay composition (Model C)
- [ ] 4.2 — Bot instances as Bun workers or child processes
- [ ] 4.3 — Shared-nothing per-tenant storage
- [ ] 4.4 — Agent loop scheduling optimization (staggered, priority-based)
- [ ] 4.5 — Per-end-user rate limiting
- [ ] 4.6 — LLM response streaming (SSE)
- [ ] 4.7 — Client SDKs (JS, Python)
- [ ] 4.8 — Bot template marketplace

### Phase 5 — Enterprise

- [ ] 5.1 — Sandbox isolation (container/worker per tenant)
- [ ] 5.2 — Workflow orchestration (DAGs for complex flows)
- [ ] 5.3 — A/B testing framework (prompt/model experimentation)
- [ ] 5.4 — Per-request cost attribution
- [ ] 5.5 — SOC2 / compliance readiness

---

## Change Log

| Date | Item | Commit | Notes |
|------|------|--------|-------|
| 2026-03-08 | Phase 3.9 complete (3.9.1–3.9.5) | — | Dashboard: Chat page, Templates CRUD, Webhooks CRUD, Customizations editor, Analytics dashboard with bar charts |
| 2026-03-08 | Phase 3 complete (3.1–3.8) | — | Bot templates, customization layer, outbound webhooks, WhatsApp adapter, usage rotation, analytics/reporting, cross-bot isolation fixes |
| 2026-03-07 | Phase 2 complete (2.1–2.6) | — | Channel abstraction layer, REST Chat API, WebSocket widget, OpenAPI spec, API versioning |
| 2026-03-06 | Phase 1 complete (1.1–1.11) | — | All 4 end-user data leaks fixed, 6 tenant infra gaps closed |
| 2026-03-05 | Document created | — | Initial architecture analysis and roadmap |
