import { Router } from "express";
import { query } from "../db.js";
import { tenantOnboardingSchema, tenantSettingsUpdateSchema } from "../validation/schemas.js";
import { writeLimiter } from "../middleware/rateLimiters.js";

const router = Router();

/**
 * GET /api/tenant/me
 * Fetches (and lazily creates) the tenant profile row for the authenticated
 * owner. The frontend uses `location_captured_at` to decide whether to show
 * the one-time geolocation onboarding modal.
 */
router.get("/me", async (req, res, next) => {
  try {
    const existing = await query(
      "SELECT * FROM tenant_profiles WHERE owner_id = $1",
      [req.ownerId]
    );

    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    }

    const email = req.auth?.email || null;
    const created = await query(
      `INSERT INTO tenant_profiles (owner_id, email)
       VALUES ($1, $2)
       ON CONFLICT (owner_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [req.ownerId, email]
    );

    res.json(created.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tenant/onboarding
 * Persists the tenant's one-time location + currency + bank details.
 * After this call `location_captured_at` is set, so the frontend will
 * never show the geolocation prompt again for this owner.
 */
router.post("/onboarding", writeLimiter, async (req, res, next) => {
  try {
    const data = tenantOnboardingSchema.parse(req.body);

    const result = await query(
      `UPDATE tenant_profiles
       SET country_code = $1,
           currency_code = $2,
           latitude = $3,
           longitude = $4,
           bank_name = $5,
           account_number = $6,
           shop_name = COALESCE($7, shop_name),
           location_captured_at = now(),
           updated_at = now()
       WHERE owner_id = $8
       RETURNING *`,
      [
        data.countryCode.toUpperCase(),
        data.currencyCode.toUpperCase(),
        data.latitude ?? null,
        data.longitude ?? null,
        data.bankName,
        data.accountNumber,
        data.shopName ?? null,
        req.ownerId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "tenant_not_found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/tenant/settings
 * ----------------------------------------------------------------------
 * Lets the shop owner edit shop name / bank name / account holder name /
 * account number at any time after onboarding - not just once. These are
 * exactly the details auto-filled into the WhatsApp payment reminder
 * message (see buildWhatsAppLink in the frontend), so editing them here
 * immediately changes what future reminders say. Not gated by
 * subscription - editing your own settings is housekeeping, the same
 * category as Edit Profile on a customer, which also stays open
 * regardless of subscription status.
 * ----------------------------------------------------------------------
 */
router.patch("/settings", writeLimiter, async (req, res, next) => {
  try {
    const data = tenantSettingsUpdateSchema.parse(req.body);

    const result = await query(
      `UPDATE tenant_profiles
       SET shop_name = COALESCE($1, shop_name),
           bank_name = COALESCE($2, bank_name),
           account_holder_name = COALESCE($3, account_holder_name),
           account_number = COALESCE($4, account_number),
           updated_at = now()
       WHERE owner_id = $5
       RETURNING *`,
      [
        data.shopName ?? null,
        data.bankName ?? null,
        data.accountHolderName ?? null,
        data.accountNumber ?? null,
        req.ownerId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "tenant_not_found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
