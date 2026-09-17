import { Router } from "express";
import { query } from "../db.js";
import { writeLimiter } from "../middleware/rateLimiters.js";
import { itemCreateSchema, itemUpdateSchema, idParamSchema } from "../validation/schemas.js";

const router = Router();

/**
 * Items (the price catalog) are intentionally NOT gated by
 * requireSubscription. Managing your own list of "milk - Rs. 150" entries
 * doesn't grow the owner's usage the way adding a customer or recording a
 * sale does - it's housekeeping, the same category as Edit Profile or
 * Delete Customer, which also stay open regardless of subscription status.
 * The paid gate lives on POST /api/sales instead (see routes/sales.js).
 */

// GET /api/items - active items only, for the "add to cart" picker.
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM items WHERE owner_id = $1 AND is_active = TRUE ORDER BY name ASC`,
      [req.ownerId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/items - add a new catalog item.
router.post("/", writeLimiter, async (req, res, next) => {
  try {
    const data = itemCreateSchema.parse(req.body);

    const { rows } = await query(
      `INSERT INTO items (owner_id, name, price, client_uuid)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, client_uuid) WHERE client_uuid IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, updated_at = now()
       RETURNING *`,
      [req.ownerId, data.name, data.price, data.clientUuid ?? null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/items/:id - edit name/price, or reactivate an archived item.
router.patch("/:id", writeLimiter, async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const data = itemUpdateSchema.parse(req.body);

    const { rows } = await query(
      `UPDATE items
       SET name = COALESCE($1, name),
           price = COALESCE($2, price),
           is_active = COALESCE($3, is_active),
           updated_at = now()
       WHERE id = $4 AND owner_id = $5
       RETURNING *`,
      [data.name ?? null, data.price ?? null, data.isActive ?? null, id, req.ownerId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/items/:id
 * Soft-delete only (is_active = FALSE) - never a hard row removal. Past
 * sale_items rows reference item_id, and while that FK is ON DELETE SET
 * NULL (so a hard delete wouldn't corrupt anything), soft-deleting means
 * an accidentally-removed item can simply be reactivated later, and it
 * disappears from new-sale pickers immediately without any history impact.
 */
router.delete("/:id", writeLimiter, async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse(req.params);

    const { rows } = await query(
      `UPDATE items SET is_active = FALSE, updated_at = now()
       WHERE id = $1 AND owner_id = $2
       RETURNING id`,
      [id, req.ownerId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
