-- ============================================================================
-- Migration: add customers.share_token (powers the "Share Record" feature)
-- Run this if your database was created BEFORE this column existed in
-- schema.sql. Safe to run multiple times (idempotent).
--
--   psql "$DATABASE_URL" -f backend/migrations/002_add_customer_share_token.sql
-- ============================================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS share_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_share_token
    ON customers(share_token) WHERE share_token IS NOT NULL;
