import type { BillingProvider, Tenant } from './types';

/**
 * No-op billing provider for self-hosted / open source deployments.
 * All billing operations succeed without doing anything.
 */
export class NoOpBillingProvider implements BillingProvider {
  async createCustomer(_tenant: Tenant): Promise<string> {
    return 'noop_customer_' + Date.now();
  }

  async createSubscription(_tenantId: string, _plan: string): Promise<string> {
    return 'noop_subscription_' + Date.now();
  }

  async cancelSubscription(_tenantId: string): Promise<void> {
    // No-op
  }

  async updateSubscription(_tenantId: string, _newPlan: string): Promise<void> {
    // No-op
  }

  async getInvoiceUrl(_tenantId: string): Promise<string | undefined> {
    return undefined;
  }

  async handleWebhook(_payload: unknown, _signature: string): Promise<void> {
    // No-op
  }
}

/**
 * Stripe billing provider for managed hosting.
 * Requires STRIPE_SECRET_KEY environment variable.
 */
export class StripeBillingProvider implements BillingProvider {
  private stripe: any; // Stripe SDK instance
  private webhookSecret: string;

  constructor(stripeSecretKey: string, webhookSecret: string) {
    // Dynamic import to avoid requiring stripe in self-hosted mode
    this.webhookSecret = webhookSecret;
    
    // Lazy load stripe SDK
    try {
      const Stripe = require('stripe');
      this.stripe = new Stripe(stripeSecretKey, {
        apiVersion: '2024-12-18.acacia',
      });
    } catch {
      throw new Error('Stripe SDK not installed. Run: npm install stripe');
    }
  }

  async createCustomer(tenant: Tenant): Promise<string> {
    const customer = await this.stripe.customers.create({
      email: tenant.email,
      name: tenant.name,
      metadata: {
        tenantId: tenant.id,
        plan: tenant.plan,
      },
    });
    return customer.id;
  }

  async createSubscription(tenantId: string, plan: string): Promise<string> {
    // Map plan to price ID (these should be configured in Stripe dashboard)
    const priceIds: Record<string, string> = {
      starter: process.env.STRIPE_STARTER_PRICE_ID || '',
      pro: process.env.STRIPE_PRO_PRICE_ID || '',
      enterprise: process.env.STRIPE_ENTERPRISE_PRICE_ID || '',
    };

    const priceId = priceIds[plan];
    if (!priceId) {
      throw new Error(`No price ID configured for plan: ${plan}`);
    }

    // Note: This requires the customer to already exist in Stripe
    // In practice, you'd store stripeCustomerId on the tenant
    throw new Error('Stripe subscription creation requires customer ID - implement tenant.billing.stripeCustomerId flow');
  }

  async cancelSubscription(tenantId: string): Promise<void> {
    // Requires storing subscription ID on tenant
    throw new Error('Stripe subscription cancellation requires subscription ID - implement tenant.billing.stripeSubscriptionId flow');
  }

  async updateSubscription(tenantId: string, newPlan: string): Promise<void> {
    // Requires storing subscription ID on tenant
    throw new Error('Stripe subscription update requires subscription ID - implement tenant.billing.stripeSubscriptionId flow');
  }

  async getInvoiceUrl(tenantId: string): Promise<string | undefined> {
    // List invoices for customer and return portal URL
    throw new Error('Stripe invoice URL retrieval requires customer ID - implement tenant.billing.stripeCustomerId flow');
  }

  async handleWebhook(payload: unknown, signature: string): Promise<void> {
    try {
      const event = this.stripe.webhooks.constructEvent(
        payload as string,
        signature,
        this.webhookSecret
      );

      switch (event.type) {
        case 'invoice.payment_succeeded':
          // Update tenant billing status
          break;
        case 'invoice.payment_failed':
          // Mark tenant as past_due
          break;
        case 'customer.subscription.deleted':
          // Handle cancellation
          break;
        default:
          // Unhandled event type
      }
    } catch (err) {
      throw new Error(`Webhook signature verification failed: ${err}`);
    }
  }
}
