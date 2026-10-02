# Luck-Cays PRD

## Overview

Luck-Cays is a play-money online casino web app with four launch features: slots, VIP rewards, sports betting and poker. All play uses Luck-Cays Chips (LC), a virtual currency with no cash value.

**Goals for v1**

- A working, demo-ready platform that players can sign up to and play all four features with chips.
- A shared wallet and ledger that every game debits and credits through one API, so it can later be swapped for a real-money wallet.
- A codebase structured so two developers and AI coding agents can work in parallel without stepping on each other.

**Non-goals for v1**

- No real-money deposits, withdrawals or chip purchases. Chips are granted free (signup bonus, daily bonus, VIP rewards) and can never be cashed out.
- No live sports odds feed with real-time trading. v1 uses a sports data API for fixtures and results, with house-set odds.
- No native mobile apps. The web app is responsive and mobile-first.

## Tech stack and architecture

One Vue 3 web app talks to one Express API over HTTPS and secure WebSockets. MySQL is the source of truth; Redis holds fast, temporary state.

```text
Vue 3 web app (browser)  -- shows results, never decides them
   |  HTTPS (REST)                      |  WSS (Socket.IO)
Express REST API                     Socket.IO gateway
(helmet, rate limits, zod, JWT)      (token checked on connect; poker, live balance)
   |                                    |
Service layer: Auth | WALLET | Slots | VIP | Sports | Poker
   (WALLET is the only module that changes balances)
   |               |                 |
MySQL 8         Redis           Sports data API (external)
```

### Stack

- **Frontend:** Vue 3, Vite, Vue Router, Pinia, TypeScript, PixiJS (reels, poker table), GSAP (UI motion), Socket.IO client.
- **Backend:** Node.js (current LTS), Express, TypeScript, Socket.IO, Prisma ORM on MySQL, node-cron or BullMQ for scheduled jobs.
- **Data:** MySQL 8 (InnoDB, utf8mb4), Redis.
- **Testing:** Vitest (unit), Supertest (API), Playwright (end-to-end).
- **Tooling:** Docker Compose for local dev, GitHub Actions for CI, ESLint and Prettier.

### Folder layout

```text
luck-cays/
  CLAUDE.md                 rules every AI agent reads first
  docker-compose.yml        MySQL + Redis + api + web
  docs/PRD.md               this file
  apps/
    web/                    Vue 3 frontend
      src/pages/            lobby, account, vip, sports, poker
      src/games/slots/      PixiJS reel renderer per game
      src/games/poker/      table view and animations
      src/stores/           Pinia stores
      src/api/              typed API + socket client
    api/                    Express backend
      src/modules/          auth, wallet, slots, vip, sports, poker, admin
      src/middleware/       auth, roles, rate limits, validation
      src/sockets/          Socket.IO handlers
      src/jobs/             sports sync, settlement, cashback
      prisma/               schema and migrations
  packages/
    shared/                 zod schemas, types, slot game configs
  tools/
    rtp-sim/                slot RTP simulator
```

## Feature requirements

Every feature moves chips only through the shared wallet service, and every game outcome is decided on the server.

### Chips and wallet (foundation)

- Signup bonus for new players; daily bonus claimable once every 24 hours. Amounts live in a config table.
- Balances stored as whole integers (BIGINT).
- Every change is a row in an append-only ledger (bet, win, bonus, VIP reward, refund). Balance is never edited directly.
- Debits run in a MySQL transaction with `SELECT ... FOR UPDATE` and are rejected if the balance would go below zero.
- Each bet request carries an idempotency key.

### Slots

- v1: one 5-reel, 3-row video slot with 20 paylines, then two more themes.
- Each game is a JSON config: reel strips, symbols, paytable, paylines, wild and scatter rules, free-spins bonus.
- Outcomes use `crypto.randomInt`, never `Math.random`.
- RTP simulator runs 1,000,000+ spins per config before a game goes live.
- Spin flow: client sends bet -> server debits, picks stops, calculates wins, credits, saves round -> client animates to the given stops.
- Player features: bet selector, autoplay with stop conditions, spin history, paytable, sound toggle.

### VIP rewards

- Points per chips wagered across all games (e.g. 1 point per 100 chips).
- Tiers: Bronze, Silver, Gold, Platinum, Diamond. Thresholds and perks in a config table.
- Perks: level-up chip bonus, daily bonus multiplier per tier, weekly cashback on net chip losses.
- VIP page: current tier, progress bar, perk list.

### Sports betting

- Fixtures and scores from a sports data API on a scheduled job. Odds from the API where available, otherwise admin-entered.
- v1 markets: moneyline, spread, totals, pre-match only.
- Odds locked at placement; player confirms if odds changed.
- Settlement job grades bets and credits winners through the wallet. Admins can void or manually settle.
- Player features: browse by sport/league, bet slip, open bets, history.

### Poker

- No-Limit Texas Hold'em cash tables, 2 to 6 players, fixed blinds per table.
- Socket.IO; server-side state machine (deal -> pre-flop -> flop -> turn -> river -> showdown). Players only receive their own hole cards.
- Secure Fisher-Yates shuffle on `crypto.randomInt`; tested hand evaluator library.
- Action timer, reconnect grace period, sit-out.
- Buy-in moves chips wallet -> table; leaving moves them back. Every hand and action logged.
- Tournaments and bots out of scope for v1.

### Admin back office

- Player lookup, chip adjustments with reason, ban/unban, game config edits, sports event management, manual settlement. Every admin action goes to the audit log.

## Authentication, encryption and security

### Authentication

- Email + password, Argon2id hashing, min 10 chars, common-password check, email verification.
- 15-minute JWT access token in memory; 7-day refresh token in `httpOnly`, `Secure`, `SameSite=Strict` cookie, stored hashed, rotated on every use, whole family revoked on reuse.
- Optional Google sign-in (OAuth 2.0 + PKCE).
- TOTP 2FA optional for players, mandatory for admins; hashed backup codes.
- Sockets authenticate with the access token on connect.
- Login rate limits per IP and account, lockout with backoff, 30-minute single-use reset links, 18+ confirmation.
- Roles: `player`, `support`, `admin`.

### Encryption

- HTTPS only (TLS 1.2+), HSTS, `wss://`, TLS between API and MySQL.
- MySQL tablespace encryption; 2FA secrets encrypted per field with AES-256-GCM (Node `crypto`).
- Secrets only in env vars / secret manager; separate keys per environment.
- `crypto.randomInt` / `crypto.randomBytes` for all outcomes, shuffles, tokens.

### Security dependencies

| Package                                   | Side      | Purpose                                       |
| ----------------------------------------- | --------- | --------------------------------------------- |
| `helmet`                                  | API       | Secure headers, CSP, HSTS                     |
| `cors`                                    | API       | Allow only the frontend origin                |
| `express-rate-limit` + `rate-limit-redis` | API       | Rate limits                                   |
| `argon2`                                  | API       | Password and backup-code hashing              |
| `jose`                                    | API       | JWT signing and verification                  |
| `cookie-parser`                           | API       | Refresh-token cookie                          |
| `csrf-csrf`                               | API       | CSRF protection on cookie routes              |
| `zod`                                     | API + web | Validate every body, query and socket message |
| Prisma (mysql)                            | API       | Parameterized queries only                    |
| `otplib`                                  | API       | TOTP 2FA                                      |
| `ioredis`                                 | API       | Rate limits, poker state, revocation lists    |
| `socket.io`                               | API + web | Real-time poker                               |
| `pino` + `pino-http`                      | API       | Logs with secrets redacted                    |
| `dompurify`                               | Web       | Sanitize user HTML                            |
| Dependabot, `npm audit`, Snyk             | Repo      | Vulnerable package alerts                     |

## Data model

All money columns are BIGINT chip counts; every table has `created_at` and `updated_at`.

| Table            | Key columns                                                                          | Notes                                 |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| `users`          | id, email, username, password_hash, role, email_verified_at, totp_secret_enc, status | status: active, banned, self-excluded |
| `refresh_tokens` | id, user_id, token_hash, family_id, expires_at, revoked_at                           | Rotation + reuse detection            |
| `wallets`        | id, user_id, balance                                                                 | One per user; locked during debits    |
| `ledger_entries` | id, wallet_id, amount, type, ref_type, ref_id, idempotency_key, balance_after        | Append-only; unique idempotency_key   |
| `bonus_claims`   | id, user_id, bonus_type, amount, claimed_at                                          | Signup, daily, level-up, cashback     |
| `slot_games`     | id, slug, name, config_json, rtp_target, is_active                                   | Game configs                          |
| `slot_rounds`    | id, user_id, game_id, bet, win, stops_json, free_spin_parent_id                      | One row per spin                      |
| `vip_tiers`      | id, name, min_points, daily_multiplier, levelup_bonus, cashback_pct                  | Config                                |
| `vip_progress`   | user_id, lifetime_points, tier_id, week_net_loss                                     | Updated on settled bets               |
| `sports_events`  | id, provider_id, sport, league, home, away, starts_at, status, result_json           | Synced from API                       |
| `sports_markets` | id, event_id, type, line, selections_json, status                                    | Moneyline, spread, totals             |
| `sports_bets`    | id, user_id, market_id, selection, odds, stake, potential_win, status, settled_at    | Odds locked                           |
| `poker_tables`   | id, name, max_seats, small_blind, big_blind, min_buyin, max_buyin, is_active         | Definitions                           |
| `poker_seats`    | table_id, seat_no, user_id, stack                                                    | Chips at a table                      |
| `poker_hands`    | id, table_id, board_cards, pot, winners_json, started_at, ended_at                   | One per hand                          |
| `poker_actions`  | id, hand_id, user_id, street, action, amount, seq                                    | Hand replay                           |
| `audit_log`      | id, actor_id, action, target_type, target_id, details_json, ip                       | Admin + security events               |

## Team split

- **Dev A (platform):** repo/CI/Docker, auth, wallet, VIP, sports betting, admin.
- **Dev B (games):** slots engine + RTP sim, slots frontend, poker server + frontend.
- **Shared:** lobby, layout, design system. Lanes meet only at the wallet API, which is agreed before any game code is written.

## Build order

Build in this order. Each step depends on the ones before it.

1. **Foundation:** monorepo, Docker Compose (MySQL + Redis), Prisma schema, auth (signup, login, JWT, refresh tokens, roles).
2. **Wallet and ledger:** wallet service, ledger entries, signup and daily bonuses. Every later feature uses this, so it comes before any game.
3. **Lobby and layout:** app shell, navigation, balance display, account pages.
4. **Slots:** game config format, spin service, RTP simulator, PixiJS reel renderer, first slot game.
5. **VIP rewards:** points on every settled bet, tiers, level-up bonus, daily bonus multiplier, weekly cashback, VIP page.
6. **Sports betting:** data API sync job, events and markets, bet slip, bet placement, settlement job.
7. **Poker:** table state machine, deck and hand evaluator, socket events, buy-in and cash-out through the wallet, table UI.
8. **Admin back office:** player lookup, chip adjustments, bans, game config edits, sports settlement, audit log.

Dev A (platform) takes steps 1, 2, 5, 6 and 8. Dev B (games) takes steps 4 and 7. Step 3 is shared.
