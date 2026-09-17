-- ============================================================================
-- Migration: add tenant_profiles.account_holder_name (used by the new
-- Settings screen and shown in WhatsApp payment reminders).
-- Run this if your database was created BEFORE this column existed.
-- Safe to run multiple times (idempotent).
--
--   psql "$DATABASE_URL" -f backend/migrations/004_add_account_holder_name.sql
-- ============================================================================

ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS account_holder_name TEXT;
