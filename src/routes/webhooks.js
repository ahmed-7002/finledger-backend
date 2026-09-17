import { Router } from "express";
import crypto from "crypto";
import { query } from "../db.js";
import { BILLING_PERIOD_DAYS } from "../config/plan.js";

const router = Router();

/**
 * POST /api/webhooks/payment
 * ----------------------------------------------------------------------
 * Built for Safepay. IMPORTANT: this route is mounted with
 * `express.raw({ type: "application/json" })` in server.js (NOT
 * express.json()) - signature verification requires the exact raw request
 * body bytes, not a re-serialized JSON object, or the computed HMAC will
 * never match what Safepay sent.
 *
 * Flow:
 *   1. Read the signature header Safepay sends. The header name and exact
 *      signing scheme are confirmed in Safepay's dashboard/API docs once
 *      you're onboarded - swap the placeholder header name below
 *      (`x-safepay-signature`) for whatever they actually document.
 *   2. Recompute an HMAC-SHA256 over the raw payload using
 *      PAYMENT_WEBHOOK_SECRET (Safepay's webhook signing secret).
 *   3. Compare using a constant-time comparison (crypto.timingSafeEqual)
 *      to avoid timing attacks.
 *   4. Only after verification succeeds do we trust `event.data` and
 *      apply it to the database.
 *
 * Billing model: Khaatabook charges a ONE-TIME payment per purchase, not an
 * auto-recurring subscription. On a verified successful payment we grant
 * exactly BILLING_PERIOD_DAYS (30) of access starting now, computed
 * server-side - we do NOT read a "next billing date" from Safepay, because
 * there isn't a recurring plan on their side to read one from. No card
 * details are ever stored by Khaatabook; Safepay's hosted checkout handles
 * the card entirely, and only tells us success/failure via this webhook.
 * ----------------------------------------------------------------------
 */
router.post("/payment", async (req, res, next) => {
  try {
    const signatureHeader = req.headers["x-safepay-signature"]; // <-- confirm exact header name in Safepay's docs
    const secret = process.env.PAYMENT_WEBHOOK_SECRET;

    if (!signatureHeader || !secret) {
      return res.status(400).json({ error: "missing_signature" });
    }

    // req.body is a Buffer here because this route uses express.raw().
    const rawBody = req.body;

    // ---- SIGNATURE VERIFICATION LOGIC (confirm Safepay's exact scheme here) ----
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const provided = Buffer.from(String(signatureHeader));
    const expected = Buffer.from(expectedSignature);

    const isValid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(provided, expected);

    if (!isValid) {
      console.warn("[webhook] signature mismatch - rejecting request");
      return res.status(401).json({ error: "invalid_signature" });
    }
    // ---- END SIGNATURE VERIFICATION ----

    const event = JSON.parse(rawBody.toString("utf8"));

    // Idempotency: ignore an event id we've already processed (gateways
    // routinely retry webhook delivery).
    const existing = await query("SELECT id FROM webhook_events WHERE id = $1", [event.id]);
    if (existing.rows.length > 0) {
      return res.status(200).json({ received: true, duplicate: true });
    }

    if (event.type === "payment.succeeded") {
      const ownerId = event.data?.owner_id || event.data?.metadata?.owner_id;

      if (!ownerId) {
        return res.status(400).json({ error: "missing_owner_id_in_payload" });
      }

      // One-time payment => we grant a fixed 30-day window starting now,
      // computed on our own server clock. This is what makes access lapse
      // automatically with no cron job (see requireSubscription middleware)
      // and it's what the "pay again every 30 days" reminder in the UI
      // is built around.
      await query(
        `UPDATE tenant_profiles
         SET has_active_subscription = TRUE,
             subscription_period_end = now() + make_interval(days => $2),
             updated_at = now()
         WHERE owner_id = $1`,
        [ownerId, BILLING_PERIOD_DAYS]
      );

      await query(
        `INSERT INTO webhook_events (id, owner_id, event_type, payload)
         VALUES ($1, $2, $3, $4)`,
        [event.id, ownerId, event.type, event]
      );
    } else if (event.type === "payment.refunded") {
      // A refund revokes access immediately rather than waiting for
      // subscription_period_end to pass. This still NEVER touches the
      // customers/transactions tables - only the access flag on this tenant.
      const ownerId = event.data?.owner_id || event.data?.metadata?.owner_id;
      if (ownerId) {
        await query(
          `UPDATE tenant_profiles SET has_active_subscription = FALSE, updated_at = now()
           WHERE owner_id = $1`,
          [ownerId]
        );
      }

      await query(
        `INSERT INTO webhook_events (id, owner_id, event_type, payload)
         VALUES ($1, $2, $3, $4)`,
        [event.id, ownerId ?? null, event.type, event]
      );
    } else {
      // Log unrecognized event types for observability without failing the request.
      await query(
        `INSERT INTO webhook_events (id, owner_id, event_type, payload)
         VALUES ($1, $2, $3, $4)`,
        [event.id, event.data?.owner_id ?? null, event.type ?? "unknown", event]
      );
    }

    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
});

export default router;
