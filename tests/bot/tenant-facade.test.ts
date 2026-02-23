import { describe, test, expect, beforeEach, vi } from 'bun:test';
import { TenantFacade, type TenantFacadeDeps } from '../../src/bot/tenant-facade';

vi.mock('../../src/tenant/manager', () => ({
  TenantManager: vi.fn().mockImplementation(() => ({
    createTenant: vi.fn(),
    getTenant: vi.fn(),
    getTenantByApiKey: vi.fn(),
    listTenants: vi.fn().mockReturnValue([]),
    updateTenant: vi.fn(),
    deleteTenant: vi.fn(),
    regenerateApiKey: vi.fn(),
    recordUsage: vi.fn(),
    getCurrentMonthUsage: vi.fn(),
    checkQuota: vi.fn(),
    canCreateBot: vi.fn(),
  })),
}));

vi.mock('../../src/tenant/billing', () => ({
  NoOpBillingProvider: vi.fn().mockImplementation(() => ({
    createCustomer: vi.fn().mockResolvedValue('cust_123'),
    createSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    getInvoiceUrl: vi.fn(),
    handleWebhook: vi.fn(),
  })),
}));

const mockDeps = {
  config: { bots: [] } as any,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  runningBots: new Set<string>(),
  stopBot: vi.fn().mockResolvedValue(undefined),
  startBot: vi.fn().mockResolvedValue(undefined),
};

function freshDeps(): TenantFacadeDeps {
  return {
    config: { bots: [] } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    runningBots: new Set<string>(),
    stopBot: vi.fn().mockResolvedValue(undefined),
    startBot: vi.fn().mockResolvedValue(undefined),
  };
}

describe('TenantFacade', () => {
  let facade: TenantFacade;
  let deps: TenantFacadeDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = freshDeps();
    facade = new TenantFacade(deps);
  });

  // ----------------------------------------------------------------
  // 1. Initialization
  // ----------------------------------------------------------------
  describe('initialization', () => {
    test('isMultiTenant returns false before initialization', () => {
      expect(facade.isMultiTenant()).toBe(false);
    });

    test('getTenantManager returns undefined before initialization', () => {
      expect(facade.getTenantManager()).toBeUndefined();
    });

    test('initializeTenantManager creates TenantManager and sets multi-tenant to true', () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      expect(facade.isMultiTenant()).toBe(true);
      expect(facade.getTenantManager()).toBeDefined();
    });

    test('initializeTenantManager logs info', () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      expect(deps.logger.info).toHaveBeenCalledWith(
        { dataDir: '/tmp/test' },
        'Tenant manager initialized',
      );
    });
  });

  // ----------------------------------------------------------------
  // 2. CRUD delegates
  // ----------------------------------------------------------------
  describe('CRUD delegates', () => {
    let mgr: any;

    beforeEach(() => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      mgr = facade.getTenantManager()!;
    });

    test('createTenant delegates to TenantManager', () => {
      const fakeTenant = { id: 't1', name: 'Acme' };
      mgr.createTenant.mockReturnValue(fakeTenant);

      const result = facade.createTenant('Acme', 'a@b.com', 'pro');
      expect(mgr.createTenant).toHaveBeenCalledWith('Acme', 'a@b.com', 'pro');
      expect(result).toEqual(fakeTenant);
    });

    test('getTenant delegates to TenantManager', () => {
      const fakeTenant = { id: 't1' };
      mgr.getTenant.mockReturnValue(fakeTenant);

      expect(facade.getTenant('t1')).toEqual(fakeTenant);
      expect(mgr.getTenant).toHaveBeenCalledWith('t1');
    });

    test('getTenantByApiKey delegates to TenantManager', () => {
      const fakeTenant = { id: 't1', apiKey: 'key123' };
      mgr.getTenantByApiKey.mockReturnValue(fakeTenant);

      expect(facade.getTenantByApiKey('key123')).toEqual(fakeTenant);
      expect(mgr.getTenantByApiKey).toHaveBeenCalledWith('key123');
    });

    test('listTenants delegates to TenantManager', () => {
      const tenants = [{ id: 't1' }, { id: 't2' }];
      mgr.listTenants.mockReturnValue(tenants);

      expect(facade.listTenants()).toEqual(tenants);
    });

    test('updateTenant delegates to TenantManager', () => {
      const updated = { id: 't1', name: 'NewName' };
      mgr.updateTenant.mockReturnValue(updated);

      expect(facade.updateTenant('t1', { name: 'NewName' })).toEqual(updated);
      expect(mgr.updateTenant).toHaveBeenCalledWith('t1', { name: 'NewName' });
    });
  });

  // ----------------------------------------------------------------
  // 3. Tenant CRUD without init
  // ----------------------------------------------------------------
  describe('tenant CRUD without initialization', () => {
    test('createTenant returns undefined and warns', () => {
      const result = facade.createTenant('Acme', 'a@b.com');
      expect(result).toBeUndefined();
      expect(deps.logger.warn).toHaveBeenCalledWith('Tenant manager not initialized');
    });

    test('getTenant returns undefined', () => {
      expect(facade.getTenant('t1')).toBeUndefined();
    });

    test('getTenantByApiKey returns undefined', () => {
      expect(facade.getTenantByApiKey('key')).toBeUndefined();
    });

    test('listTenants returns empty array', () => {
      expect(facade.listTenants()).toEqual([]);
    });

    test('updateTenant returns undefined', () => {
      expect(facade.updateTenant('t1', { name: 'New' })).toBeUndefined();
    });

    test('regenerateTenantApiKey returns undefined', () => {
      expect(facade.regenerateTenantApiKey('t1')).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------
  // 4. deleteTenant
  // ----------------------------------------------------------------
  describe('deleteTenant', () => {
    test('returns false when not initialized', async () => {
      expect(await facade.deleteTenant('t1')).toBe(false);
    });

    test('stops running bots that belong to tenant before deleting', async () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      mgr.deleteTenant.mockReturnValue(true);

      // Set up config with bots belonging to this tenant
      deps.config.bots = [
        { id: 'bot1', tenantId: 'tenant1' },
        { id: 'bot2', tenantId: 'tenant1' },
        { id: 'bot3', tenantId: 'other' },
      ] as any;
      deps.runningBots.add('bot1');
      deps.runningBots.add('bot3');

      const result = await facade.deleteTenant('tenant1');

      // Only bot1 should be stopped (belongs to tenant1 and is running)
      expect(deps.stopBot).toHaveBeenCalledTimes(1);
      expect(deps.stopBot).toHaveBeenCalledWith('bot1');
      expect(mgr.deleteTenant).toHaveBeenCalledWith('tenant1');
      expect(result).toBe(true);
    });

    test('delegates to TenantManager.deleteTenant', async () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      mgr.deleteTenant.mockReturnValue(false);

      const result = await facade.deleteTenant('nonexistent');
      expect(mgr.deleteTenant).toHaveBeenCalledWith('nonexistent');
      expect(result).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // 5. recordUsage with different event types
  // ----------------------------------------------------------------
  describe('recordUsage', () => {
    let mgr: any;

    beforeEach(() => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      mgr = facade.getTenantManager()!;
    });

    test('does nothing when not initialized', () => {
      const uninit = new TenantFacade(freshDeps());
      uninit.recordUsage('t1', 'bot1', 'message_processed', 5);
      // No error thrown, no calls
    });

    test('message_processed sets messageCount', () => {
      facade.recordUsage('t1', 'bot1', 'message_processed', 3);
      expect(mgr.recordUsage).toHaveBeenCalledWith({
        tenantId: 't1',
        botId: 'bot1',
        messageCount: 3,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    });

    test('api_call sets apiCallCount', () => {
      facade.recordUsage('t1', 'bot1', 'api_call', 2);
      expect(mgr.recordUsage).toHaveBeenCalledWith({
        tenantId: 't1',
        botId: 'bot1',
        messageCount: 0,
        apiCallCount: 2,
        storageBytesUsed: 0,
      });
    });

    test('llm_request sets apiCallCount', () => {
      facade.recordUsage('t1', 'bot1', 'llm_request', 1);
      expect(mgr.recordUsage).toHaveBeenCalledWith({
        tenantId: 't1',
        botId: 'bot1',
        messageCount: 0,
        apiCallCount: 1,
        storageBytesUsed: 0,
      });
    });

    test('tool_execution sets apiCallCount', () => {
      facade.recordUsage('t1', 'bot1', 'tool_execution', 4);
      expect(mgr.recordUsage).toHaveBeenCalledWith({
        tenantId: 't1',
        botId: 'bot1',
        messageCount: 0,
        apiCallCount: 4,
        storageBytesUsed: 0,
      });
    });

    test('storage_write sets storageBytesUsed', () => {
      facade.recordUsage('t1', 'bot1', 'storage_write', 1024);
      expect(mgr.recordUsage).toHaveBeenCalledWith({
        tenantId: 't1',
        botId: 'bot1',
        messageCount: 0,
        apiCallCount: 0,
        storageBytesUsed: 1024,
      });
    });

    test('collaboration_initiated sets all to 0', () => {
      facade.recordUsage('t1', 'bot1', 'collaboration_initiated', 1);
      expect(mgr.recordUsage).toHaveBeenCalledWith({
        tenantId: 't1',
        botId: 'bot1',
        messageCount: 0,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    });

    test('webhook_received sets all to 0', () => {
      facade.recordUsage('t1', 'bot1', 'webhook_received', 1);
      expect(mgr.recordUsage).toHaveBeenCalledWith({
        tenantId: 't1',
        botId: 'bot1',
        messageCount: 0,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    });

    test('defaults quantity to 1 when not provided', () => {
      facade.recordUsage('t1', 'bot1', 'message_processed');
      expect(mgr.recordUsage).toHaveBeenCalledWith({
        tenantId: 't1',
        botId: 'bot1',
        messageCount: 1,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    });
  });

  // ----------------------------------------------------------------
  // 6. getTenantUsage and checkQuota
  // ----------------------------------------------------------------
  describe('getTenantUsage', () => {
    test('returns zero usage when not initialized', () => {
      expect(facade.getTenantUsage('t1')).toEqual({
        messages: 0,
        apiCalls: 0,
        storage: 0,
      });
    });

    test('delegates to getCurrentMonthUsage', () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      const usage = { messages: 10, apiCalls: 20, storage: 300 };
      mgr.getCurrentMonthUsage.mockReturnValue(usage);

      expect(facade.getTenantUsage('t1')).toEqual(usage);
      expect(mgr.getCurrentMonthUsage).toHaveBeenCalledWith('t1');
    });
  });

  describe('checkQuota', () => {
    test('returns true when not initialized (permissive default)', () => {
      expect(facade.checkQuota('t1', 'messages', 1)).toBe(true);
    });

    test('delegates to TenantManager.checkQuota', () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      mgr.checkQuota.mockReturnValue(false);

      expect(facade.checkQuota('t1', 'messages', 100)).toBe(false);
      expect(mgr.checkQuota).toHaveBeenCalledWith('t1', 'messages', 100);
    });

    test('defaults amount to 1', () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      mgr.checkQuota.mockReturnValue(true);

      facade.checkQuota('t1', 'apiCalls');
      expect(mgr.checkQuota).toHaveBeenCalledWith('t1', 'apiCalls', 1);
    });
  });

  // ----------------------------------------------------------------
  // 7. startBotWithTenant
  // ----------------------------------------------------------------
  describe('startBotWithTenant', () => {
    test('starts bot without tenant check when no tenantId', async () => {
      const botConfig = { id: 'bot1', name: 'Bot1' } as any;
      const result = await facade.startBotWithTenant(botConfig);

      expect(result).toEqual({ success: true });
      expect(deps.startBot).toHaveBeenCalledWith(botConfig);
    });

    test('returns error when tenant not found', async () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      mgr.getTenant.mockReturnValue(undefined);

      const botConfig = { id: 'bot1', tenantId: 't1' } as any;
      const result = await facade.startBotWithTenant(botConfig);

      expect(result).toEqual({ success: false, error: 'Tenant not found' });
      expect(deps.startBot).not.toHaveBeenCalled();
    });

    test('returns error when bot limit exceeded', async () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      mgr.getTenant.mockReturnValue({ id: 't1', plan: 'free' });
      mgr.canCreateBot.mockReturnValue(false);

      const botConfig = { id: 'bot1', tenantId: 't1' } as any;
      const result = await facade.startBotWithTenant(botConfig);

      expect(result).toEqual({ success: false, error: 'Bot limit exceeded for tenant plan' });
      expect(deps.startBot).not.toHaveBeenCalled();
    });

    test('starts bot when tenant exists and quota allows', async () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      mgr.getTenant.mockReturnValue({ id: 't1', plan: 'pro' });
      mgr.canCreateBot.mockReturnValue(true);

      const botConfig = { id: 'bot1', tenantId: 't1' } as any;
      const result = await facade.startBotWithTenant(botConfig);

      expect(result).toEqual({ success: true });
      expect(deps.startBot).toHaveBeenCalledWith(botConfig);
    });

    test('returns error when startBot throws', async () => {
      deps.startBot = vi.fn().mockRejectedValue(new Error('Token invalid'));

      const botConfig = { id: 'bot1' } as any;
      const result = await facade.startBotWithTenant(botConfig);

      expect(result).toEqual({ success: false, error: 'Error: Token invalid' });
    });

    test('skips tenant validation when tenantManager not initialized', async () => {
      // tenantId is set but tenantManager is not initialized
      const botConfig = { id: 'bot1', tenantId: 't1' } as any;
      const result = await facade.startBotWithTenant(botConfig);

      // The condition is: botConfig.tenantId && this.tenantManager
      // Both must be truthy to trigger validation.
      // Since tenantManager is undefined, it skips and calls startBot directly.
      expect(result).toEqual({ success: true });
      expect(deps.startBot).toHaveBeenCalledWith(botConfig);
    });
  });

  // ----------------------------------------------------------------
  // 8. getTenantBots and getRunningTenantBots
  // ----------------------------------------------------------------
  describe('getTenantBots', () => {
    test('returns bots belonging to the tenant', () => {
      deps.config.bots = [
        { id: 'bot1', tenantId: 't1' },
        { id: 'bot2', tenantId: 't2' },
        { id: 'bot3', tenantId: 't1' },
      ] as any;

      const result = facade.getTenantBots('t1');
      expect(result).toHaveLength(2);
      expect(result.map((b: any) => b.id)).toEqual(['bot1', 'bot3']);
    });

    test('returns empty array when no bots match', () => {
      deps.config.bots = [{ id: 'bot1', tenantId: 't2' }] as any;
      expect(facade.getTenantBots('t1')).toEqual([]);
    });
  });

  describe('getRunningTenantBots', () => {
    test('returns only running bots belonging to the tenant', () => {
      deps.config.bots = [
        { id: 'bot1', tenantId: 't1' },
        { id: 'bot2', tenantId: 't1' },
        { id: 'bot3', tenantId: 't2' },
      ] as any;
      deps.runningBots.add('bot1');
      deps.runningBots.add('bot3');

      const result = facade.getRunningTenantBots('t1');
      expect(result).toEqual(['bot1']);
    });

    test('returns empty array when no running bots for tenant', () => {
      deps.config.bots = [{ id: 'bot1', tenantId: 't1' }] as any;
      // bot1 is not in runningBots
      expect(facade.getRunningTenantBots('t1')).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // 9. getBillingProvider and createBillingCustomer
  // ----------------------------------------------------------------
  describe('getBillingProvider', () => {
    test('returns undefined before initialization', () => {
      expect(facade.getBillingProvider()).toBeUndefined();
    });

    test('returns billing provider after initialization', () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      expect(facade.getBillingProvider()).toBeDefined();
    });

    test('uses custom billing provider when provided', () => {
      const customBilling = {
        createCustomer: vi.fn(),
        createSubscription: vi.fn(),
        cancelSubscription: vi.fn(),
        updateSubscription: vi.fn(),
        getInvoiceUrl: vi.fn(),
        handleWebhook: vi.fn(),
      } as any;
      facade.initializeTenantManager({ dataDir: '/tmp/test' }, customBilling);
      expect(facade.getBillingProvider()).toBe(customBilling);
    });
  });

  describe('createBillingCustomer', () => {
    test('returns undefined when not initialized', async () => {
      expect(await facade.createBillingCustomer('t1')).toBeUndefined();
    });

    test('returns undefined when tenant not found', async () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      mgr.getTenant.mockReturnValue(undefined);

      expect(await facade.createBillingCustomer('t1')).toBeUndefined();
    });

    test('creates billing customer and updates tenant', async () => {
      const customBilling = {
        createCustomer: vi.fn().mockResolvedValue('cust_stripe_123'),
        createSubscription: vi.fn(),
        cancelSubscription: vi.fn(),
        updateSubscription: vi.fn(),
        getInvoiceUrl: vi.fn(),
        handleWebhook: vi.fn(),
      } as any;

      facade.initializeTenantManager({ dataDir: '/tmp/test' }, customBilling);
      const mgr = facade.getTenantManager()! as any;
      const tenant = { id: 't1', name: 'Acme', email: 'a@b.com', billing: {} };
      mgr.getTenant.mockReturnValue(tenant);

      const result = await facade.createBillingCustomer('t1');

      expect(result).toBe('cust_stripe_123');
      expect(customBilling.createCustomer).toHaveBeenCalledWith(tenant);
      expect(mgr.updateTenant).toHaveBeenCalledWith('t1', {
        billing: {
          stripeCustomerId: 'cust_stripe_123',
        },
      });
    });

    test('returns undefined and logs error when billing provider throws', async () => {
      const customBilling = {
        createCustomer: vi.fn().mockRejectedValue(new Error('Stripe down')),
        createSubscription: vi.fn(),
        cancelSubscription: vi.fn(),
        updateSubscription: vi.fn(),
        getInvoiceUrl: vi.fn(),
        handleWebhook: vi.fn(),
      } as any;

      facade.initializeTenantManager({ dataDir: '/tmp/test' }, customBilling);
      const mgr = facade.getTenantManager()! as any;
      mgr.getTenant.mockReturnValue({ id: 't1', name: 'Acme' });

      const result = await facade.createBillingCustomer('t1');
      expect(result).toBeUndefined();
      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // regenerateTenantApiKey delegate
  // ----------------------------------------------------------------
  describe('regenerateTenantApiKey', () => {
    test('delegates to TenantManager.regenerateApiKey', () => {
      facade.initializeTenantManager({ dataDir: '/tmp/test' });
      const mgr = facade.getTenantManager()! as any;
      mgr.regenerateApiKey.mockReturnValue('new_key_abc');

      expect(facade.regenerateTenantApiKey('t1')).toBe('new_key_abc');
      expect(mgr.regenerateApiKey).toHaveBeenCalledWith('t1');
    });
  });
});
