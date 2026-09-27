import { Router } from "express";
import crypto from "crypto";
import { pool, query } from "../db.js";
import { requireSubscription } from "../middleware/requireSubscription.js";
import { writeLimiter } from "../middleware/rateLimiters.js";
import { CUSTOMER_LIMIT } from "../config/plan.js";
import {
  customerCreateSchema,
  customerUpdateSchema,
  idParamSchema,
} from "../validation/schemas.js";

const router = Router();

/**
 * assertOwnership
 * ----------------------------------------------------------------------
 * Fetches a row by primary key WITHOUT the owner_id filter first, so we
 * can distinguish "doesn't exist" (404) from "exists but belongs to a
 * different tenant" (403 Forbidden) - this is the explicit IDOR-prevention
 * behavior requested: cross-tenant access attempts must be rejected with
 * 403, not silently 404'd.
 * ----------------------------------------------------------------------
 */
async function assertOwnership(table, id, ownerId) {
  const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (rows.length === 0) {
    const err = new Error("not_found");
    err.status = 404;
    err.publicMessage = "not_found";
    throw err;
  }
  if (rows[0].owner_id !== ownerId) {
    const err = new Error("forbidden");
    err.status = 403;
    err.publicMessage = "forbidden";
    throw err;
  }
  return rows[0];
}

// GET /api/customers - always scoped to the authenticated tenant only.
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM customers WHERE owner_id = $1 ORDER BY updated_at DESC`,
      [req.ownerId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/transactions - customer detail + history, tenant-scoped.
router.get("/:id/transactions", async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    await assertOwnership("customers", id, req.ownerId);

    const { rows } = await query(
      `SELECT * FROM transactions WHERE customer_id = $1 AND owner_id = $2 ORDER BY created_at DESC`,
      [id, req.ownerId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/customers
 * ----------------------------------------------------------------------
 * Creates a new customer, optionally with an initial debt amount set right
 * away - so an owner adding a customer who already owes them something
 * doesn't have to separately navigate to Record Transaction afterward.
 *
 * When an initial debt is given, the customer row AND the corresponding
 * 'add' transaction are created atomically in one database transaction -
 * matching the same pattern already used for POS sales - so a failure
 * partway through can never leave a customer created with a debt amount
 * that has no matching transaction history entry to explain it.
 *
 * Also gated behind an active subscription (the paywall), and capped at
 * CUSTOMER_LIMIT customers per tenant. The cap is a billing/plan limit, not
 * a database limit - Neon can hold far more per tenant than this; it
 * exists to give the paywall pitch a concrete number.
 * ----------------------------------------------------------------------
 */
router.post("/", writeLimiter, requireSubscription, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const countRes = await client.query(
      "SELECT COUNT(*)::int AS count FROM customers WHERE owner_id = $1",
      [req.ownerId]
    );
    const currentCount = countRes.rows[0].count;

    if (currentCount >= CUSTOMER_LIMIT) {
      return res.status(409).json({
        error: "customer_limit_reached",
        message: `You've reached your plan's limit of ${CUSTOMER_LIMIT} customers.`,
        limit: CUSTOMER_LIMIT,
        currentCount,
      });
    }

    const data = customerCreateSchema.parse(req.body);
    const initialDebt = data.initialDebtAmount ?? 0;

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO customers (owner_id, name, phone, phone_verified, national_id, pending_amount, client_uuid)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_id, client_uuid) WHERE client_uuid IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING *`,
      [
        req.ownerId,
        data.name,
        data.phone,
        data.phoneVerified ?? false,
        data.nationalId ?? null,
        initialDebt,
        data.clientUuid ?? null,
      ]
    );

    const customer = rows[0];

    // Give this opening balance the same paper trail every other debt-
    // creating action in the app gets - a real transaction row, not just a
    // number quietly set on the customer.
    if (initialDebt > 0) {
      await client.query(
        `INSERT INTO transactions (owner_id, customer_id, type, amount, payment_method, status, reference)
         VALUES ($1, $2, 'add', $3, 'cash', 'pending', 'Opening balance')`,
        [req.ownerId, customer.id, initialDebt]
      );
    }

    await client.query("COMMIT");

    res.status(201).json(customer);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/customers/:id - edit profile.
router.patch("/:id", writeLimiter, async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    await assertOwnership("customers", id, req.ownerId);
    const data = customerUpdateSchema.parse(req.body);

    const { rows } = await query(
      `UPDATE customers
       SET name = COALESCE($1, name),
           phone = COALESCE($2, phone),
           phone_verified = COALESCE($3, phone_verified),
           national_id = COALESCE($4, national_id),
           updated_at = now()
       WHERE id = $5 AND owner_id = $6
       RETURNING *`,
      [
        data.name ?? null,
        data.phone ?? null,
        data.phoneVerified ?? null,
        data.nationalId ?? null,
        id,
        req.ownerId,
      ]
    );

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customers/:id - blocked server-side if pending_amount > 0,
// mirroring the disabled/hidden delete button in the UI.
router.delete("/:id", writeLimiter, async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const customer = await assertOwnership("customers", id, req.ownerId);

    if (Number(customer.pending_amount) > 0) {
      return res.status(409).json({
        error: "pending_balance",
        message: "Cannot delete a customer with a pending balance.",
      });
    }

    await query(`DELETE FROM customers WHERE id = $1 AND owner_id = $2`, [id, req.ownerId]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/customers/:id/share-link
 * ----------------------------------------------------------------------
 * Generates (or returns the existing) public share token for this
 * customer, and hands back the full shareable URL the owner can send via
 * WhatsApp. This is intentionally NOT behind requireSubscription - sharing
 * a customer's already-recorded ledger is read-only from the customer's
 * side and doesn't grow the owner's usage, so it's treated the same as
 * Edit/Delete/WhatsApp reminder: always available regardless of
 * subscription status.
 *
 * The token is a random 32-byte hex string - NOT derived from the
 * customer's database id - specifically so a customer (or anyone) can't
 * guess another customer's share link just by trying nearby UUIDs. It's
 * idempotent: calling this again for a customer that already has a token
 * just returns the same link instead of rotating it, so a previously
 * shared link keeps working.
 * ----------------------------------------------------------------------
 */
router.post("/:id/share-link", writeLimiter, async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const customer = await assertOwnership("customers", id, req.ownerId);

    let token = customer.share_token;
    if (!token) {
      token = crypto.randomBytes(24).toString("hex");
      await query(`UPDATE customers SET share_token = $1 WHERE id = $2`, [token, id]);
    }

    const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
    res.json({ shareToken: token, shareUrl: `${frontendOrigin}/share/${token}` });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/customers/:id/share-link
 * Revokes an existing share link (e.g. if the owner suspects it leaked, or
 * just wants to stop sharing). The customer keeps their data - this only
 * invalidates the public link, same "never touches the underlying ledger
 * data" principle as everything else in this app.
 */
router.delete("/:id/share-link", writeLimiter, async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    await assertOwnership("customers", id, req.ownerId);
    await query(`UPDATE customers SET share_token = NULL WHERE id = $1`, [id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;