import { Router } from "express";
import { pool, query } from "../db.js";
import { requireSubscription } from "../middleware/requireSubscription.js";
import { writeLimiter } from "../middleware/rateLimiters.js";
import {
  paymentSubmissionApproveSchema,
  paymentSubmissionRejectSchema,
  idParamSchema,
} from "../validation/schemas.js";

const router = Router();

/**
 * GET /api/payment-submissions
 * All of this tenant's submissions (pending, approved, and rejected),
 * newest first, joined with the customer's name/phone so the frontend can
 * render the notification list and build the "Notify Customer" WhatsApp
 * link without a second round trip. Always open for reading - same
 * "reading is always free" principle as the rest of the app.
 */
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ps.*, c.name AS customer_name, c.phone AS customer_phone, c.share_token,
              t.amount AS approved_amount
       FROM payment_submissions ps
       JOIN customers c ON c.id = ps.customer_id
       LEFT JOIN transactions t ON t.id = ps.transaction_id
       WHERE ps.owner_id = $1
       ORDER BY ps.submitted_at DESC
       LIMIT 200`,
      [req.ownerId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payment-submissions/:id/approve
 * ----------------------------------------------------------------------
 * Turns a customer's claim into a real, trusted ledger entry: creates a
 * 'deduct' transaction (same trusted logic as recording a settlement
 * manually or via a POS sale), tags it with the submission's receipt image
 * as permanent proof, and updates the customer's balance - all atomically.
 *
 * Gated behind an active subscription - approving a submission performs
 * the exact same ledger action as manually recording a settlement, so it
 * follows the same paywall rule as POST /api/transactions. Without this,
 * an unsubscribed owner could use customer-submitted receipts as a
 * loophole around the subscription requirement.
 *
 * The owner can override the amount here (e.g. the customer claimed 5000
 * but the receipt actually shows 4800) rather than being forced into a
 * full reject-and-resubmit cycle for a simple mismatch.
 * ----------------------------------------------------------------------
 */
router.post("/:id/approve", writeLimiter, requireSubscription, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = idParamSchema.parse(req.params);
    const data = paymentSubmissionApproveSchema.parse(req.body);

    const submissionRes = await client.query(
      `SELECT * FROM payment_submissions WHERE id = $1`,
      [id]
    );
    if (submissionRes.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    const submission = submissionRes.rows[0];

    if (submission.owner_id !== req.ownerId) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (submission.status !== "pending") {
      return res.status(409).json({
        error: "already_reviewed",
        message: "This submission has already been reviewed.",
      });
    }

    const amount = data.amount ?? Number(submission.claimed_amount);
    const reference = data.reference || "Paid via bank transfer - receipt approved";

    await client.query("BEGIN");

    const txnRes = await client.query(
      `INSERT INTO transactions (owner_id, customer_id, type, amount, payment_method, status, receipt_url, reference)
       VALUES ($1, $2, 'deduct', $3, 'cash', 'cleared', $4, $5)
       RETURNING *`,
      [req.ownerId, submission.customer_id, amount, submission.receipt_url, reference]
    );

    await client.query(
      `UPDATE customers
       SET pending_amount = GREATEST(pending_amount - $1, 0),
           cleared_amount = cleared_amount + $1,
           updated_at = now()
       WHERE id = $2`,
      [amount, submission.customer_id]
    );

    await client.query(
      `UPDATE payment_submissions
       SET status = 'approved', transaction_id = $1, reviewed_at = now()
       WHERE id = $2`,
      [txnRes.rows[0].id, id]
    );

    const updatedCustomerRes = await client.query(
      `SELECT * FROM customers WHERE id = $1`,
      [submission.customer_id]
    );

    await client.query("COMMIT");

    res.json({
      transaction: txnRes.rows[0],
      customer: updatedCustomerRes.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/payment-submissions/:id/reject
 * Never touches the ledger - just marks the submission rejected with an
 * optional reason, which the customer will see on their Share Record page
 * (and in the WhatsApp notification the owner can send afterward). Not
 * gated by subscription, since nothing here creates or changes debt.
 */
router.post("/:id/reject", writeLimiter, async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const data = paymentSubmissionRejectSchema.parse(req.body);

    const submissionRes = await query(`SELECT owner_id, status FROM payment_submissions WHERE id = $1`, [id]);
    if (submissionRes.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    if (submissionRes.rows[0].owner_id !== req.ownerId) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (submissionRes.rows[0].status !== "pending") {
      return res.status(409).json({
        error: "already_reviewed",
        message: "This submission has already been reviewed.",
      });
    }

    const { rows } = await query(
      `UPDATE payment_submissions
       SET status = 'rejected', rejection_reason = $1, reviewed_at = now()
       WHERE id = $2
       RETURNING *`,
      [data.reason ?? null, id]
    );

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;