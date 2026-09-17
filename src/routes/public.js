import { Router } from "express";
import { query } from "../db.js";

const router = Router();

// A share token is always a 48-char lowercase hex string (24 random bytes).
// Reject anything else before it ever touches the database - this also
// means malformed/garbage tokens can't be used to probe for timing
// differences between "valid format, no match" and "invalid format".
const TOKEN_PATTERN = /^[a-f0-9]{48}$/;

/**
 * GET /api/public/ledger/:token
 * ----------------------------------------------------------------------
 * Deliberately mounted WITHOUT requireAuth in server.js - this is the one
 * route in the whole API a customer (who has no Clerk account at all) can
 * reach directly, via a link the shop owner sends them on WhatsApp.
 *
 * Returns ONLY what a customer needs to see their own record:
 * - the shop's display name and bank details (so they can pay directly)
 * - their own name, pending/cleared totals
 * - their own transaction history (date, reference, amount, status)
 *
 * Explicitly NEVER returned here: owner_id, the customer's national_id,
 * phone_verified status, any other customer's data, or anything about the
 * tenant beyond what's needed to make a payment (no email, no location).
 * The lookup is by share_token, not by customer id - a customer (or
 * anyone) cannot enumerate other customers' records from this endpoint.
 * ----------------------------------------------------------------------
 */
router.get("/ledger/:token", async (req, res, next) => {
  try {
    const { token } = req.params;

    if (!TOKEN_PATTERN.test(token)) {
      return res.status(404).json({ error: "not_found" });
    }

    const customerRes = await query(
      `SELECT c.id, c.name, c.pending_amount, c.cleared_amount,
              t.shop_name, t.bank_name, t.account_number, t.currency_code, t.country_code
       FROM customers c
       JOIN tenant_profiles t ON t.owner_id = c.owner_id
       WHERE c.share_token = $1`,
      [token]
    );

    if (customerRes.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    const customer = customerRes.rows[0];

    const transactionsRes = await query(
      `SELECT type, amount, reference, status, created_at
       FROM transactions
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customer.id]
    );

    res.json({
      customerName: customer.name,
      pendingAmount: customer.pending_amount,
      clearedAmount: customer.cleared_amount,
      shopName: customer.shop_name,
      bankName: customer.bank_name,
      accountNumber: customer.account_number,
      currencyCode: customer.currency_code,
      countryCode: customer.country_code,
      transactions: transactionsRes.rows.map((t) => ({
        type: t.type,
        amount: t.amount,
        reference: t.reference,
        status: t.status,
        date: t.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
