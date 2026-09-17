-- ============================================================================
-- Migration: Point of Sale feature - items, sales, sale_items, and the
-- transactions.sale_id link.
-- Run this if your database was created BEFORE these tables existed in
-- schema.sql. Safe to run multiple times (idempotent).
--
--   psql "$DATABASE_URL" -f backend/migrations/003_add_pos_tables.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id          TEXT NOT NULL REFERENCES tenant_profiles(owner_id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    price             NUMERIC(14,2) NOT NULL CHECK (price >= 0),
    stock_quantity    NUMERIC(14,2),
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    client_uuid       TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_items_owner_id ON items(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_items_client_uuid ON items(owner_id, client_uuid) WHERE client_uuid IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id          TEXT NOT NULL REFERENCES tenant_profiles(owner_id) ON DELETE CASCADE,
    customer_id       UUID REFERENCES customers(id) ON DELETE SET NULL,
    total_amount      NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
    amount_paid       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    amount_pending    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_pending >= 0),
    client_uuid       TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_owner_id ON sales(owner_id);
CREATE INDEX IF NOT EXISTS idx_sales_customer_id ON sales(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_client_uuid ON sales(owner_id, client_uuid) WHERE client_uuid IS NOT NULL;

CREATE TABLE IF NOT EXISTS sale_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id           UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    item_id           UUID REFERENCES items(id) ON DELETE SET NULL,
    item_name         TEXT NOT NULL,
    unit_price        NUMERIC(14,2) NOT NULL,
    quantity          NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
    line_total        NUMERIC(14,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;
