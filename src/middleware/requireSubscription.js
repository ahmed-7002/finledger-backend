import { query } from "../db.js";

/**
 * requireSubscription
 * ----------------------------------------------------------------------
 * Server-side enforcement of the freemium paywall. The frontend also
 * gates the "Add Customer" button visually, but that is purely UX - 
 * this middleware is the actual security boundary, since client-side
 * checks can always be bypassed by a direct API call.
 *
 * IMPORTANT - subscription expiry:
 * `has_active_subscription` alone is NOT trusted forever. A subscription
 * is only treated as active if BOTH of these hold:
 *   1. has_active_subscription = TRUE
 *   2. subscription_period_end IS NULL (no expiry, e.g. a manual admin
 *      grant with no end date) OR subscription_period_end is still in
 *      the future.
 * This means a lapsed monthly plan blocks new writes automatically the
 * moment `now() > subscription_period_end`, with NO cron job or scheduled
 * task required to "flip a switch" - it's computed at request time.
 *
 * Crucially, this ONLY gates the ability to add a new customer. It never
 * deletes, hides, or restricts read access to existing customers or
 * transactions - those remain fully visible and intact indefinitely,
 * lapsed subscription or not.
 * ----------------------------------------------------------------------
 */
export async function requireSubscription(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT has_active_subscription, subscription_period_end
       FROM tenant_profiles WHERE owner_id = $1`,
      [req.ownerId]
    );

    const profile = rows[0];
    const notExpired =
      !profile?.subscription_period_end || new Date(profile.subscription_period_end) > new Date();
    const active = Boolean(profile?.has_active_subscription) && notExpired;

    if (!active) {
      const expired = Boolean(profile?.has_active_subscription) && !notExpired;
      return res.status(402).json({
        error: expired ? "subscription_expired" : "subscription_required",
        message: expired
          ? "Your subscription has expired. Renew to add new customers - your existing data is untouched."
          : "Upgrade your storage plan to add new customers.",
        subscriptionPeriodEnd: profile?.subscription_period_end ?? null,
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}
