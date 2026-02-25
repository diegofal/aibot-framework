import type { BotConfig } from '../config';

/**
 * Tenant represents a paying customer in the multi-tenant system.
 * Each tenant can have multiple bots but shares quota/billing.
 */
export interface Tenant {
  id: string;
  name: string;
  email: string;
  plan: 'free' | 'starter' | 'pro' | 'enterprise';
  apiKey: string;
  createdAt: Date;
  updatedAt: Date;
  
  // Quota configuration (from plan + custom overrides)
  quota: TenantQuota;
  
  // Current usage (reset monthly)
  usage: TenantUsage;
  
  // Billing info (Stripe integration)
  billing?: TenantBilling;
  
  // Feature flags
  features: TenantFeatures;
}

export interface TenantQuota {
  messagesPerMonth: number;
  apiCallsPerMonth: number;
  storageBytes: number;
  maxBots: number;
  maxSkillsPerBot: number;
  maxCollaborationsPerDay: number;
}

export interface TenantUsage {
  messagesThisMonth: number;
  apiCallsThisMonth: number;
  storageBytesUsed: number;
  collaborationsToday: number;
  lastResetAt: Date;
}

export interface TenantBilling {
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  status: 'active' | 'past_due' | 'canceled' | 'unpaid';
}

export interface TenantFeatures {
  customBranding: boolean;
  webDashboard: boolean;
  apiAccess: boolean;
  prioritySupport: boolean;
  customLLMProvider: boolean;
  whiteLabel: boolean;
}

/**
 * Usage event types for metering
 */
export type UsageEventType = 
  | 'message_processed'
  | 'api_call'
  | 'llm_request'
  | 'tool_execution'
  | 'collaboration_initiated'
  | 'storage_write'
  | 'webhook_received';

export interface UsageEvent {
  tenantId: string;
  botId?: string;
  type: UsageEventType;
  quantity: number;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

/**
 * API key validation result
 */
export interface ApiKeyValidationResult {
  valid: boolean;
  tenant?: Tenant;
  error?: 'invalid' | 'expired' | 'revoked' | 'quota_exceeded';
}

/**
 * Quota check result
 */
export interface QuotaCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
  resetsAt?: Date;
  error?: string;
}

/**
 * Plan definitions with default quotas
 */
export const PLAN_DEFINITIONS: Record<string, TenantQuota & { price: number; features: TenantFeatures }> = {
  free: {
    price: 0,
    messagesPerMonth: 500,
    apiCallsPerMonth: 100,
    storageBytes: 100 * 1024 * 1024, // 100MB
    maxBots: 1,
    maxSkillsPerBot: 3,
    maxCollaborationsPerDay: 10,
    features: {
      customBranding: false,
      webDashboard: false,
      apiAccess: false,
      prioritySupport: false,
      customLLMProvider: false,
      whiteLabel: false,
    },
  },
  starter: {
    price: 29,
    messagesPerMonth: 10_000,
    apiCallsPerMonth: 5_000,
    storageBytes: 1024 * 1024 * 1024, // 1GB
    maxBots: 3,
    maxSkillsPerBot: 10,
    maxCollaborationsPerDay: 100,
    features: {
      customBranding: false,
      webDashboard: true,
      apiAccess: true,
      prioritySupport: false,
      customLLMProvider: false,
      whiteLabel: false,
    },
  },
  pro: {
    price: 99,
    messagesPerMonth: 50_000,
    apiCallsPerMonth: 25_000,
    storageBytes: 5 * 1024 * 1024 * 1024, // 5GB
    maxBots: 10,
    maxSkillsPerBot: 20,
    maxCollaborationsPerDay: 500,
    features: {
      customBranding: true,
      webDashboard: true,
      apiAccess: true,
      prioritySupport: true,
      customLLMProvider: true,
      whiteLabel: false,
    },
  },
  enterprise: {
    price: 499,
    messagesPerMonth: 250_000,
    apiCallsPerMonth: 100_000,
    storageBytes: 25 * 1024 * 1024 * 1024, // 25GB
    maxBots: 50,
    maxSkillsPerBot: 50,
    maxCollaborationsPerDay: 2_000,
    features: {
      customBranding: true,
      webDashboard: true,
      apiAccess: true,
      prioritySupport: true,
      customLLMProvider: true,
      whiteLabel: true,
    },
  },
};

/**
 * Billing provider interface for Stripe integration
 */
export interface BillingProvider {
  createCustomer(tenant: Tenant): Promise<string>; // returns stripeCustomerId
  createSubscription(tenantId: string, plan: string): Promise<string>; // returns stripeSubscriptionId
  cancelSubscription(tenantId: string): Promise<void>;
  updateSubscription(tenantId: string, newPlan: string): Promise<void>;
  getInvoiceUrl(tenantId: string): Promise<string | undefined>;
  handleWebhook(payload: unknown, signature: string): Promise<WebhookResult>;
}

export interface WebhookResult {
  type: 'payment_succeeded' | 'payment_failed' | 'subscription_canceled' | 'unhandled';
  tenantId?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  invoiceId?: string;
}

/**
 * Storage provider interface for tenant data
 */
export interface TenantStorage {
  save(tenant: Tenant): Promise<void>;
  getById(id: string): Promise<Tenant | undefined>;
  getByApiKey(apiKey: string): Promise<Tenant | undefined>;
  getByEmail(email: string): Promise<Tenant | undefined>;
  list(): Promise<Tenant[]>;
  delete(id: string): Promise<void>;
  
  // Usage tracking
  recordUsage(event: UsageEvent): Promise<void>;
  getUsageHistory(tenantId: string, start: Date, end: Date): Promise<UsageEvent[]>;
  resetMonthlyUsage(tenantId: string): Promise<void>;
}
