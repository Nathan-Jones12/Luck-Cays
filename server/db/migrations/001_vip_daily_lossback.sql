-- 001: VIP lossback - daily at 2pm instead of weekly cashback, and fractional percentages.
--
-- For databases created from the original schema.sql. (schema.sql itself now already has
-- this structure, so a fresh database does not need this file.)
-- Run with: npm run db:sql -- db/migrations/001_vip_daily_lossback.sql

-- Rates like 1.5% do not fit a whole-number percentage, so store basis points:
-- 1 bp = 0.01%, so 150 = 1.5% and 1200 = 12%.
ALTER TABLE `vip_tiers` RENAME COLUMN `cashback_pct` TO `lossback_bp`;
ALTER TABLE `vip_tiers`
  ADD CONSTRAINT `vip_tiers_lossback_bp_range` CHECK (`lossback_bp` BETWEEN 0 AND 10000);

-- Track the current lossback period (since the last 2pm payout) instead of a week.
ALTER TABLE `vip_progress`
  DROP COLUMN `week_net_loss`,
  DROP COLUMN `week_started_at`,
  ADD COLUMN `period_wagered` BIGINT NOT NULL DEFAULT 0 AFTER `tier_id`,
  ADD COLUMN `period_won` BIGINT NOT NULL DEFAULT 0 AFTER `period_wagered`,
  ADD COLUMN `period_started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER `period_won`,
  ADD COLUMN `last_lossback_at` DATETIME(3) NULL AFTER `period_started_at`;
