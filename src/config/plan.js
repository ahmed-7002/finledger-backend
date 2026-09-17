/**
 * Single source of truth for the paid plan's customer capacity AND its
 * billing model.
 *
 * Neon (Postgres) can comfortably hold far more than this per tenant - our
 * own testing suggests the platform as a whole can handle on the order of
 * 100,000 customer rows without issue. This 1,000 figure is a deliberate
 * PRODUCT/BILLING limit per subscribed shop owner, not a database ceiling - 
 * it exists to give the "Buy Storage" pitch a concrete, easy-to-understand
 * number rather than an abstract "more storage" claim.
 *
 * Billing model: Khaatabook uses Safepay for a ONE-TIME payment that unlocks
 * exactly BILLING_PERIOD_DAYS of access, rather than Safepay's own recurring
 * subscription/auto-billing (which adds saved-card tokenization, dunning,
 * and retry complexity we don't need for a first version). When the period
 * lapses, the shop owner simply pays again to renew - no card is ever kept
 * on file, and nothing about their existing customers/transactions changes.
 * See requireSubscription middleware and routes/webhooks.js.
 *
 * Keep this in sync with frontend/src/lib/plan.js.
 */
export const CUSTOMER_LIMIT = 1000;
export const BILLING_PERIOD_DAYS = 30;
