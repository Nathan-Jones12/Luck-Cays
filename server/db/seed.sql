-- Starting data. Safe to re-run: existing rows are updated in place, never duplicated.
-- Run with: npm run db:sql -- db/seed.sql

-- VIP tiers. Players climb by lifetime VIP points (1 point per 100 LC wagered).
-- lossback_bp is basis points: 150 = 1.5%. Lossback is the only tier perk for now, so
-- levelup_bonus is 0 and daily_multiplier_bp is 100 (1.00x - no change).
INSERT INTO `vip_tiers` (`id`, `name`, `min_points`, `daily_multiplier_bp`, `levelup_bonus`, `lossback_bp`)
VALUES
  (1, 'Grunt',          0, 100, 0,  150),
  (2, 'Snapper',     1000, 100, 0,  300),
  (3, 'Bonefish',    5000, 100, 0,  450),
  (4, 'Grouper',    15000, 100, 0,  600),
  (5, 'Jack',       50000, 100, 0,  750),
  (6, 'Mahi',      150000, 100, 0,  900),
  (7, 'Marlin',    500000, 100, 0, 1050),
  (8, 'Shark',    1500000, 100, 0, 1200)
AS new
ON DUPLICATE KEY UPDATE
  `name` = new.`name`,
  `min_points` = new.`min_points`,
  `daily_multiplier_bp` = new.`daily_multiplier_bp`,
  `levelup_bonus` = new.`levelup_bonus`,
  `lossback_bp` = new.`lossback_bp`;

-- VIP rules the backend reads at runtime, so they can change without a code change.
INSERT INTO `config_values` (`key`, `value`, `description`)
VALUES
  ('vip.lc_per_point', '100',
   'LC wagered per VIP point. Points are lifetime and decide the tier.'),
  ('vip.lossback_time', '14:00',
   'Daily lossback payout time (24h clock) in vip.lossback_timezone.'),
  ('vip.lossback_timezone', 'America/Nassau',
   'IANA timezone for the payout time. Nassau follows US Eastern daylight saving.'),
  ('vip.lossback_games', 'slots,sports',
   'Games whose bets count toward lossback. Poker is excluded (player vs player).')
AS new
ON DUPLICATE KEY UPDATE `value` = new.`value`, `description` = new.`description`;

-- Cash tables. IDs are stable so clients may link directly to a table.
INSERT INTO `poker_tables`
  (`id`, `name`, `max_seats`, `small_blind`, `big_blind`, `min_buyin`, `max_buyin`, `is_active`)
VALUES
  ('coral-reef', 'Coral Reef', 6, 25, 50, 1000, 5000, TRUE),
  ('blue-lagoon', 'Blue Lagoon', 6, 100, 200, 5000, 20000, TRUE)
ON DUPLICATE KEY UPDATE
  `name` = new.`name`,
  `max_seats` = new.`max_seats`,
  `small_blind` = new.`small_blind`,
  `big_blind` = new.`big_blind`,
  `min_buyin` = new.`min_buyin`,
  `max_buyin` = new.`max_buyin`,
  `is_active` = new.`is_active`;
