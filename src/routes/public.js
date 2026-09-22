import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { fileTypeFromBuffer } from "file-type";
import { pool, query } from "../db.js";
import { paymentSubmissionCreateSchema } from "../validation/schemas.js";
import { uploadReceiptBuffer } from "../utils/cloudinary.js";

const router = Router();

// A share token is always a 48-char lowercase hex string (24 random bytes).
// Reject anything else before it ever touches the database - this also
// means malformed/garbage tokens can't be used to probe for timing
// differences between "valid format, no match" and "invalid format".
const TOKEN_PATTERN = /^[a-f0-9]{48}$/;

// Extra-tight limiter just for the payment-submission upload route, layered
// on top of the general publicShareLimiter applied to all of /api/public in
// server.js. This is the single most exposed endpoint in the whole API:
// public (no login at all) AND accepts a file upload AND writes to the
// database - worth throttling harder than plain ledger reads.
const submissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many attempts. Please wait a while and try again." },
});

// Same defense-in-depth pattern as transactions.js: multer's fileFilter
// only checks the claimed Content-Type (spoofable); fileTypeFromBuffer
// below sniffs the actual bytes after upload. This route is even more
// exposed than transactions.js's upload endpoint since it's PUBLIC - no
// login at all - so the same protections matter just as much here.
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
const ALLOWED_IMAGE_TYPES = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);

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
 * - their most recent payment submission, if any, so the frontend can show
 *   "waiting for review" / "rejected: <reason>, resubmit" / a plain
 *   "I've Paid" button, depending on where things stand.
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
              t.shop_name, t.bank_name, t.account_holder_name, t.account_number,
              t.currency_code, t.country_code
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

    const submissionRes = await query(
      `SELECT status, claimed_amount, rejection_reason, submitted_at
       FROM payment_submissions
       WHERE customer_id = $1
       ORDER BY submitted_at DESC
       LIMIT 1`,
      [customer.id]
    );

    const latestSubmission = submissionRes.rows[0]
      ? {
          status: submissionRes.rows[0].status,
          claimedAmount: submissionRes.rows[0].claimed_amount,
          rejectionReason: submissionRes.rows[0].rejection_reason,
          submittedAt: submissionRes.rows[0].submitted_at,
        }
      : null;

    res.json({
      customerName: customer.name,
      pendingAmount: customer.pending_amount,
      clearedAmount: customer.cleared_amount,
      shopName: customer.shop_name,
      bankName: customer.bank_name,
      accountHolderName: customer.account_holder_name,
      accountNumber: customer.account_number,
      currencyCode: customer.currency_code,
      countryCode: customer.country_code,
      latestSubmission,
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

/**
 * POST /api/public/ledger/:token/payment-submission
 * ----------------------------------------------------------------------
 * A customer, from their own Share Record page, claims "I've paid X" and
 * attaches a receipt screenshot. This does NOT touch the real ledger -
 * it only creates a pending record for the shop owner to review (see
 * routes/paymentSubmissions.js for the approve/reject side). Nothing here
 * is trusted until a human approves it, the same way a cash register
 * doesn't just take a customer's word for a payment.
 *
 * Blocked if this customer already has a submission sitting in "pending"
 * status - enforced both here (a friendly 409) and at the database level
 * (a partial unique index), so a double-tap or two browser tabs can't both
 * succeed and create two pending claims for the same customer.
 * ----------------------------------------------------------------------
 */
router.post("/ledger/:token/payment-submission", submissionLimiter, upload.single("receipt"), async (req, res, next) => {
  try {
    const { token } = req.params;

    if (!TOKEN_PATTERN.test(token)) {
      return res.status(404).json({ error: "not_found" });
    }

    const customerRes = await query(
      `SELECT id, owner_id FROM customers WHERE share_token = $1`,
      [token]
    );
    if (customerRes.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    const customer = customerRes.rows[0];

    const data = paymentSubmissionCreateSchema.parse(req.body);

    if (!req.file) {
      return res.status(400).json({ error: "receipt_required", message: "Attach a receipt image." });
    }

    // Sniff the actual file content, not just the claimed mimetype - see
    // the identical pattern (and reasoning) in routes/transactions.js.
    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !ALLOWED_IMAGE_TYPES.has(detected.ext)) {
      return res.status(400).json({
        error: "invalid_file_content",
        message: "The uploaded file doesn't look like a supported image.",
      });
    }

    const existingPending = await query(
      `SELECT id FROM payment_submissions WHERE customer_id = $1 AND status = 'pending'`,
      [customer.id]
    );
    if (existingPending.rows.length > 0) {
      return res.status(409).json({
        error: "submission_already_pending",
        message: "You already have a payment waiting for review.",
      });
    }

    const uploaded = await uploadReceiptBuffer(req.file.buffer, customer.owner_id);

    await query(
      `INSERT INTO payment_submissions (owner_id, customer_id, claimed_amount, receipt_url)
       VALUES ($1, $2, $3, $4)`,
      [customer.owner_id, customer.id, data.amount, uploaded.secure_url]
    );

    res.status(201).json({ submitted: true });
  } catch (err) {
    // The partial unique index is the last line of defense against a race
    // condition (e.g. two tabs submitting within milliseconds of each
    // other) - translate that specific DB error into the same friendly
    // 409 rather than a generic 500.
    if (err?.code === "23505") {
      return res.status(409).json({
        error: "submission_already_pending",
        message: "You already have a payment waiting for review.",
      });
    }
    next(err);
  }
});

export default router;