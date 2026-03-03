import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import type { TenantManager } from '../../tenant/manager';
import type { TenantContext } from '../../tenant/middleware';
import type { SessionStore } from '../../tenant/session-store';

export interface OnboardingRoutesDeps {
  tenantManager: TenantManager;
  botManager: BotManager;
  config: Config;
  logger: Logger;
  sessionStore?: SessionStore;
}

export function onboardingRoutes(deps: OnboardingRoutesDeps) {
  const { tenantManager, botManager, config, logger } = deps;
  const app = new Hono();

  // POST /onboarding/signup — create tenant + auto-setup directories
  app.post('/signup', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.name || !body?.email) {
      return c.json({ error: 'Missing required fields: name, email' }, 400);
    }

    const { name, email, plan = 'free' } = body;
    const password = body.password;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return c.json({ error: 'Invalid email format' }, 400);
    }

    // Password required, min 8 chars
    if (!password || typeof password !== 'string' || password.length < 8) {
      return c.json({ error: 'Password is required and must be at least 8 characters' }, 400);
    }

    // Check email dedup
    const existing = tenantManager
      .listTenants()
      .find((t) => t.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      return c.json({ error: 'An account with this email already exists' }, 409);
    }

    // Validate plan
    const validPlans = ['free', 'starter', 'pro', 'enterprise'];
    if (!validPlans.includes(plan)) {
      return c.json({ error: `Invalid plan. Must be one of: ${validPlans.join(', ')}` }, 400);
    }

    // Hash password and create tenant
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    const tenant = tenantManager.createTenant(name, email, plan, passwordHash);

    // Auto-create tenant directory structure
    const dataDir = config.multiTenant?.dataDir ?? './data/tenants';
    const tenantDir = join(dataDir, tenant.id);
    try {
      mkdirSync(join(tenantDir, 'bots'), { recursive: true });
      mkdirSync(join(tenantDir, 'sessions'), { recursive: true });
    } catch {
      // Directory creation is best-effort
    }

    logger.info({ tenantId: tenant.id, email }, 'Tenant onboarded');

    // Auto-login: create session token if session store available
    let sessionToken: string | undefined;
    if (deps.sessionStore) {
      const session = deps.sessionStore.createSession({
        role: 'tenant',
        tenantId: tenant.id,
        name: tenant.name,
      });
      sessionToken = session.id;
    }

    return c.json(
      {
        success: true,
        tenant: {
          id: tenant.id,
          name: tenant.name,
          email: tenant.email,
          plan: tenant.plan,
          apiKey: tenant.apiKey,
          usageQuota: tenant.usageQuota,
        },
        ...(sessionToken ? { sessionToken } : {}),
        nextSteps: [
          'Save your API key — it is for programmatic access and will not be shown again.',
          'Create your first bot using POST /api/agents with your API key or session token.',
        ],
      },
      201
    );
  });

  // POST /onboarding/first-bot — create first bot for a tenant (wizard)
  app.post('/first-bot', async (c) => {
    const tenant = c.get('tenant') as TenantContext | undefined;
    if (!tenant) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json().catch(() => null);
    if (!body?.name || !body?.token) {
      return c.json({ error: 'Missing required fields: name, token' }, 400);
    }

    const { name, token, description, personality } = body;

    // Check bot limit
    const tenantData = tenantManager.getTenant(tenant.tenantId);
    if (!tenantData) return c.json({ error: 'Tenant not found' }, 404);

    const existingBots = config.bots.filter((b) => b.tenantId === tenant.tenantId);
    const planLimits = tenantManager.getPlanLimits(tenantData.plan);
    if (existingBots.length >= planLimits.maxBots) {
      return c.json(
        {
          error: `Bot limit reached for ${tenantData.plan} plan (${planLimits.maxBots} bots).`,
          upgradeUrl: '/billing/upgrade',
        },
        403
      );
    }

    // Create a minimal bot config
    const botId = `bot-${Date.now().toString(36)}`;
    const botConfig = {
      id: botId,
      name,
      token,
      description: description || `Bot created via onboarding for ${tenantData.name}`,
      tenantId: tenant.tenantId,
      skills: [] as string[],
      personality: personality || '',
    };

    // Add to config bots array
    config.bots.push(botConfig as any);

    // Create bot directories
    const dataDir = config.multiTenant?.dataDir ?? './data/tenants';
    const botDir = join(dataDir, tenant.tenantId, 'bots', botId);
    try {
      mkdirSync(join(botDir, 'soul'), { recursive: true });
      mkdirSync(join(botDir, 'productions'), { recursive: true });
    } catch {
      // Best-effort
    }

    logger.info({ tenantId: tenant.tenantId, botId, name }, 'First bot created via onboarding');

    return c.json(
      {
        success: true,
        bot: {
          id: botId,
          name,
          tenantId: tenant.tenantId,
        },
        nextSteps: [
          'Start your bot using POST /api/agents/:botId/start with your API key.',
          'Configure the bot personality by updating its soul files.',
        ],
      },
      201
    );
  });

  return app;
}
