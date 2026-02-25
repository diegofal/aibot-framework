import type { BillingProvider, Tenant, WebhookResult } from './types';

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

  async handleWebhook(_payload: unknown, _signature: string): Promise<WebhookResult> {
    return { type: 'unhandled' };
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

  async createSubscription(customerId: string, plan: string): Promise<string> {
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

    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    return subscription.id;
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.cancel(subscriptionId);
  }

  async updateSubscription(subscriptionId: string, newPlan: string): Promise<void> {
    const priceIds: Record<string, string> = {
      starter: process.env.STRIPE_STARTER_PRICE_ID || '',
      pro: process.env.STRIPE_PRO_PRICE_ID || '',
      enterprise: process.env.STRIPE_ENTERPRISE_PRICE_ID || '',
    };

    const priceId = priceIds[newPlan];
    if (!priceId) {
      throw new Error(`No price ID configured for plan: ${newPlan}`);
    }

    // Get current subscription to find the item to update
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const itemId = subscription.items.data[0]?.id;

    if (!itemId) {
      throw new Error('No subscription items found to update');
    }

    await this.stripe.subscriptions.update(subscriptionId, {
      items: [{ id: itemId, price: priceId }],
      proration_behavior: 'create_prorations',
    });
  }

  async getInvoiceUrl(customerId: string): Promise<string | undefined> {
    const invoices = await this.stripe.invoices.list({
      customer: customerId,
      limit: 1,
    });

    if (invoices.data.length > 0 && invoices.data[0].hosted_invoice_url) {
      return invoices.data[0].hosted_invoice_url;
    }

    return undefined;
  }

  async createBillingPortalSession(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return session.url;
  }

  async handleWebhook(payload: unknown, signature: string): Promise<WebhookResult> {
    try {
      const event = this.stripe.webhooks.constructEvent(
        payload as string,
        signature,
        this.webhookSecret
      );

      switch (event.type) {
        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;
          const tenantId = invoice.metadata?.tenantId || invoice.subscription_details?.metadata?.tenantId;
          return {
            type: 'payment_succeeded',
            tenantId,
            stripeCustomerId: invoice.customer,
            stripeSubscriptionId: invoice.subscription,
            invoiceId: invoice.id,
          };
        }
        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const tenantId = invoice.metadata?.tenantId || invoice.subscription_details?.metadata?.tenantId;
          return {
            type: 'payment_failed',
            tenantId,
            stripeCustomerId: invoice.customer,
            stripeSubscriptionId: invoice.subscription,
            invoiceId: invoice.id,
          };
        }
        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const tenantId = subscription.metadata?.tenantId;
          return {
            type: 'subscription_canceled',
            tenantId,
            stripeCustomerId: subscription.customer,
            stripeSubscriptionId: subscription.id,
          };
        }
        default:
          return { type: 'unhandled' };
      }
    } catch (err) {
      throw new Error(`Webhook signature verification failed: ${err}`);
    }
  }
}

export interface WebhookResult {
  type: 'payment_succeeded' | 'payment_failed' | 'subscription_canceled' | 'unhandled';
  tenantId?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  invoiceId?: string;
}
