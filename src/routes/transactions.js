import { Router } from "express";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { pool, query } from "../db.js";
import { requireSubscription } from "../middleware/requireSubscription.js";
import { uploadLimiter } from "../middleware/rateLimiters.js";
import { transactionCreateSchema, idParamSchema } from "../validation/schemas.js";
import { uploadReceiptBuffer } from "../utils/cloudinary.js";

const router = Router();

// Receipts are held in memory only, capped at 5MB. The mimetype filter here
// only checks the CLAIMED Content-Type header, which a client can lie about
// - e.g. naming a script "receipt.jpg" and setting the mimetype manually.
// It's a cheap first-pass rejection; the real check is fileTypeFromBuffer()
// below, which sniffs the actual file bytes after upload.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image uploads are allowed"));
    }
    cb(null, true);
  },
});

// Only these actual image formats are accepted once we've sniffed the real
// file content - deliberately narrower than "any image/*" the browser
// might claim, since these are the formats Cloudinary needs and the only
// ones a receipt photo would realistically be.
const ALLOWED_IMAGE_TYPES = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);

/**
 * POST /api/transactions
 * Records an "add" (new credit) or "deduct" (cash settlement) entry and
 * atomically updates the customer's running pending/cleared balances.
 * Accepts an optional multipart `receipt` file which is pushed to
 * Cloudinary before the DB row is written.
 *
 * Gated behind an active subscription - same paywall boundary as adding a
 * new customer. `requireSubscription` runs BEFORE the multer upload step so
 * an unsubscribed request is rejected immediately without wastefully
 * parsing/buffering a receipt image first. Note this only gates *writing* a
 * transaction: GET /api/transactions and GET /api/customers/:id/transactions
 * (the read/history routes) stay completely open regardless of subscription
 * status - a shop owner can always see what they've already recorded.
 *
 * Uses uploadLimiter (tighter than the standard writeLimiter used on other
 * routes) since this is the one endpoint in the app that accepts a file
 * upload and makes an outbound Cloudinary call - the most expensive request
 * type here, and worth throttling harder if something abuses it.
 */
router.post("/", uploadLimiter, requireSubscription, upload.single("receipt"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const data = transactionCreateSchema.parse(req.body);

    // Confirm the customer belongs to this tenant before touching balances.
    const customerRes = await client.query(
      "SELECT * FROM customers WHERE id = $1",
      [data.customerId]
    );
    if (customerRes.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    if (customerRes.rows[0].owner_id !== req.ownerId) {
      return res.status(403).json({ error: "forbidden" });
    }

    let receiptUrl = data.receiptUrl ?? null;
    if (req.file) {
      // Sniff the ACTUAL file content rather than trusting the client-supplied
      // mimetype - this is what stops someone renaming an executable/script
      // to "receipt.jpg" and having it accepted just because multer's
      // fileFilter only checked the (spoofable) declared Content-Type.
      const detected = await fileTypeFromBuffer(req.file.buffer);
      if (!detected || !ALLOWED_IMAGE_TYPES.has(detected.ext)) {
        return res.status(400).json({
          error: "invalid_file_content",
          message: "The uploaded file doesn't look like a supported image.",
        });
      }

      const uploaded = await uploadReceiptBuffer(req.file.buffer, req.ownerId);
      receiptUrl = uploaded.secure_url;
    }

    await client.query("BEGIN");

    const status = data.type === "add" ? "pending" : "cleared";

    const txnRes = await client.query(
      `INSERT INTO transactions
         (owner_id, customer_id, type, amount, payment_method, receipt_url, reference, status, client_uuid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (owner_id, client_uuid) WHERE client_uuid IS NOT NULL
       DO UPDATE SET reference = EXCLUDED.reference
       RETURNING *`,
      [
        req.ownerId,
        data.customerId,
        data.type,
        data.amount,
        "cash",
        receiptUrl,
        data.reference ?? null,
        status,
        data.clientUuid ?? null,
      ]
    );

    // "add" increases what the customer owes; "deduct" settles part of it
    // and moves that amount into cleared_amount.
    const balanceUpdate =
      data.type === "add"
        ? `UPDATE customers SET pending_amount = pending_amount + $1, updated_at = now() WHERE id = $2`
        : `UPDATE customers
           SET pending_amount = GREATEST(pending_amount - $1, 0),
               cleared_amount = cleared_amount + $1,
               updated_at = now()
           WHERE id = $2`;

    await client.query(balanceUpdate, [data.amount, data.customerId]);

    const updatedCustomer = await client.query(
      "SELECT * FROM customers WHERE id = $1",
      [data.customerId]
    );

    await client.query("COMMIT");

    res.status(201).json({
      transaction: txnRes.rows[0],
      customer: updatedCustomer.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {}); // no-op if BEGIN was never reached
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/transactions - flat recent-activity feed for the dashboard, tenant-scoped.
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.*, c.name AS customer_name
       FROM transactions t
       JOIN customers c ON c.id = t.customer_id
       WHERE t.owner_id = $1
       ORDER BY t.created_at DESC
       LIMIT 100`,
      [req.ownerId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
