import { Router } from "express";
import { pool, query } from "../db.js";
import { requireSubscription } from "../middleware/requireSubscription.js";
import { writeLimiter } from "../middleware/rateLimiters.js";
import { CUSTOMER_LIMIT } from "../config/plan.js";
import { saleCreateSchema, idParamSchema } from "../validation/schemas.js";

const router = Router();

// GET /api/sales - sales history / revenue view. Every sale ever rung up,
// walk-in or not, paid or pending. Always open for reading - same
// "reading is always free" principle as the rest of the app; only
// CREATING a new sale (below) is gated.
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.*, c.name AS customer_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.owner_id = $1
       ORDER BY s.created_at DESC
       LIMIT 200`,
      [req.ownerId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/sales/:id/items - line items for one sale (receipt detail view).
router.get("/:id/items", async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse(req.params);

    const saleRes = await query(`SELECT owner_id FROM sales WHERE id = $1`, [id]);
    if (saleRes.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    if (saleRes.rows[0].owner_id !== req.ownerId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const { rows } = await query(`SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id`, [id]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sales
 * ----------------------------------------------------------------------
 * The core checkout endpoint. Gated behind an active subscription - same
 * boundary as POST /api/transactions, since ringing up a sale that creates
 * a debt is the same category of action as manually recording one.
 *
 * The TOTAL is always computed server-side from `items` - never trusted
 * from the client, the same rule this app follows everywhere else (see
 * transactions.js). amountPaid is validated against that computed total,
 * not whatever the client happens to claim.
 *
 * Customer attachment rules (see README "Point of Sale" section):
 * - amountPending === 0 (fully paid): ALWAYS an anonymous walk-in. No
 *     customer is created or attached, even if the client sent one - this
 *     is a deliberate simplification, not an oversight, matching exactly
 *     what was asked for: "pays in full = no debt account created."
 * - amountPending > 0: a customer is REQUIRED - either an existing one
 *     (customerId) or a brand new one created inline (newCustomer), in the
 *     SAME database transaction as the sale, so a failure partway through
 *     (e.g. hitting the customer limit) rolls back the whole sale cleanly
 *     rather than leaving an orphaned half-created record.
 * ----------------------------------------------------------------------
 */
router.post("/", writeLimiter, requireSubscription, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const data = saleCreateSchema.parse(req.body);

    // Compute each line total and the grand total server-side - the only
    // numbers ever trusted are unitPrice/quantity per line, never a total.
    const lineTotals = data.items.map(
      (line) => Math.round(line.unitPrice * line.quantity * 100) / 100
    );
    const totalAmount = Math.round(lineTotals.reduce((sum, t) => sum + t, 0) * 100) / 100;

    if (data.amountPaid > totalAmount) {
      return res.status(400).json({
        error: "amount_paid_exceeds_total",
        message: "The amount paid can't be more than the sale total.",
      });
    }

    const amountPending = Math.round((totalAmount - data.amountPaid) * 100) / 100;
    const fullyPaid = amountPending <= 0;

    // Validate any referenced catalog item ids actually belong to this
    // tenant before trusting the linkage - doesn't block the sale if one
    // doesn't match, just drops that particular item_id reference (the
    // name/price snapshot on the line is unaffected either way).
    const referencedIds = data.items.map((l) => l.itemId).filter(Boolean);
    const validItemIds = new Set();
    if (referencedIds.length > 0) {
      const validRes = await client.query(
        `SELECT id FROM items WHERE owner_id = $1 AND id = ANY($2::uuid[])`,
        [req.ownerId, referencedIds]
      );
      validRes.rows.forEach((r) => validItemIds.add(r.id));
    }

    await client.query("BEGIN");

    let customerId = null;

    if (!fullyPaid) {
      if (data.customerId) {
        const customerRes = await client.query("SELECT * FROM customers WHERE id = $1", [
          data.customerId,
        ]);
        if (customerRes.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "not_found" });
        }
        if (customerRes.rows[0].owner_id !== req.ownerId) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "forbidden" });
        }
        customerId = data.customerId;
      } else if (data.newCustomer) {
        const countRes = await client.query(
          "SELECT COUNT(*)::int AS count FROM customers WHERE owner_id = $1",
          [req.ownerId]
        );
        if (countRes.rows[0].count >= CUSTOMER_LIMIT) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "customer_limit_reached",
            message: `You've reached your plan's limit of ${CUSTOMER_LIMIT} customers.`,
            limit: CUSTOMER_LIMIT,
          });
        }

        const newCustomerRes = await client.query(
          `INSERT INTO customers (owner_id, name, phone, national_id)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [
            req.ownerId,
            data.newCustomer.name,
            data.newCustomer.phone,
            data.newCustomer.nationalId ?? null,
          ]
        );
        customerId = newCustomerRes.rows[0].id;
      } else {
        // Defense in depth - the frontend should never allow this state,
        // but the backend must never assume the frontend was used.
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "customer_required",
          message: "A customer is required when a sale isn't fully paid.",
        });
      }
    }

    const saleRes = await client.query(
      `INSERT INTO sales (owner_id, customer_id, total_amount, amount_paid, amount_pending, client_uuid)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_id, client_uuid) WHERE client_uuid IS NOT NULL
       DO UPDATE SET total_amount = EXCLUDED.total_amount
       RETURNING *`,
      [req.ownerId, customerId, totalAmount, data.amountPaid, amountPending, data.clientUuid ?? null]
    );
    const sale = saleRes.rows[0];

    for (let i = 0; i < data.items.length; i++) {
      const line = data.items[i];
      const safeItemId = line.itemId && validItemIds.has(line.itemId) ? line.itemId : null;
      await client.query(
        `INSERT INTO sale_items (sale_id, item_id, item_name, unit_price, quantity, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sale.id, safeItemId, line.name, line.unitPrice, line.quantity, lineTotals[i]]
      );
    }

    let updatedCustomer = null;

    if (!fullyPaid) {
      // Mirrors the exact "add" + "deduct" transaction pattern already used
      // by POST /api/transactions, tagged with sale_id - so this customer's
      // profile shows a complete history, not a separate, inconsistent
      // code path just because the debt came from a sale instead of a
      // manually-typed amount.
      await client.query(
        `INSERT INTO transactions (owner_id, customer_id, type, amount, payment_method, status, sale_id, reference)
         VALUES ($1, $2, 'add', $3, 'cash', 'pending', $4, 'Added via Sale')`,
        [req.ownerId, customerId, totalAmount, sale.id]
      );

      if (data.amountPaid > 0) {
        await client.query(
          `INSERT INTO transactions (owner_id, customer_id, type, amount, payment_method, status, sale_id, reference)
           VALUES ($1, $2, 'deduct', $3, 'cash', 'cleared', $4, 'Paid via Sale')`,
          [req.ownerId, customerId, data.amountPaid, sale.id]
        );
      }

      await client.query(
        `UPDATE customers
         SET pending_amount = pending_amount + $1,
             cleared_amount = cleared_amount + $2,
             updated_at = now()
         WHERE id = $3`,
        [amountPending, data.amountPaid, customerId]
      );

      const updatedCustomerRes = await client.query("SELECT * FROM customers WHERE id = $1", [
        customerId,
      ]);
      updatedCustomer = updatedCustomerRes.rows[0];
    }

    const saleItemsRes = await client.query(`SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id`, [
      sale.id,
    ]);

    await client.query("COMMIT");

    res.status(201).json({
      sale,
      items: saleItemsRes.rows,
      customer: updatedCustomer,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export default router;