# Luck-Cays

A play-money casino: slots, sports betting, Texas Hold'em and VIP rewards, all played with
Luck-Cays Chips (LC).

**Chips have no cash value.** They cannot be bought, sold or withdrawn, there is no payment
path anywhere in this repository, and nothing here may add one. Free chips arrive through a
signup bonus, a daily bonus and VIP rewards.

This is a prototype build of the specification in [`docs/PRD.md`](docs/PRD.md).

---

## Running it

You need Node 20 or newer. You do **not** need Docker.

```bash
git clone <this repo> && cd Luck-Cays
cp .env.example .env          # then generate real secrets - see below
npm install
npm run db:push               # creates the SQLite database
npm run db:seed               # games, tables, fixtures, two demo accounts
npm run dev                   # API on :4000, web on :5173
```

Open <http://localhost:5173>.

Generate the two secrets `.env` needs rather than using the committed placeholders:

```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log('FIELD_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

### Demo accounts

`npm run db:seed` creates two, both with the password `luckcays-demo-2026`:

| Account | Email                   | Notes                                 |
| ------- | ----------------------- | ------------------------------------- |
| Player  | `player@luck-cays.test` | 10,000 chips, ready to play           |
| Admin   | `admin@luck-cays.test`  | Needs the TOTP secret the seed prints |

The admin has two-factor authentication already enrolled, because the PRD makes it mandatory
for administrators and the login route enforces that — an admin seeded without a secret would
be an account nobody could ever sign in to. The seed prints the secret and ten backup codes;
add the secret to an authenticator app. A fresh one is generated every time you seed.

---

## What is actually built

| Feature               | State                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wallet and ledger** | Complete. Append-only ledger, idempotency, row-locked debits, 16 tests including a concurrency oversell test.                                                          |
| **Auth**              | Signup, login, JWT access tokens, refresh rotation with reuse detection, TOTP 2FA, backup codes, lockout with backoff, password reset, roles.                          |
| **Slots**             | Complete. Three games, server-side outcomes, free spins, PixiJS reels, autoplay with stop conditions, paytable, history. RTP calculated in closed form and signed off. |
| **VIP**               | Complete. Points on every wager, five tiers, level-up bonuses, daily-bonus multiplier, weekly cashback.                                                                |
| **Sports betting**    | Complete for the v1 scope. Moneyline, spreads, totals, pre-match. Odds locked at placement, automatic settlement, bet slip.                                            |
| **Poker**             | Playable. Full Hold'em state machine, side pots, action timers, reconnect grace, buy-in and cash-out through the wallet, live table UI.                                |
| **Admin**             | Player lookup, chip adjustments, bans, game activation, manual results, job triggers, audit log.                                                                       |
| **Embedding**         | Slots mount in an iframe on any of our front-ends, via a one-shot launch ticket and a game-scoped session. See [docs/embedding.md](docs/embedding.md).                 |

### Known gaps

Honest list, not a roadmap:

- **No email transport.** Verification and reset tokens are returned in the API response
  outside production so the flows can be exercised. In production they are withheld, which
  means those flows need a mail provider wiring in before they work.
- **No Google sign-in.** The PRD lists it as optional; it is not built.
- **Poker has no multi-client integration test.** The state machine is covered (26 tests,
  including chip conservation across 15 hands and side-pot capping) and so are the evaluator
  and deck (18 tests), but nothing drives two real sockets through a hand together. The
  reconnect and action-timer paths in particular have been exercised by hand, not by CI.
- **No audio.** The sound toggle in the slots UI is a placeholder.
- **SQLite by default.** See below.

---

## Architecture

```
Vue 3 (browser) ──── HTTPS ───→ Express REST API ──┐
       └─────────── WSS ──────→ Socket.IO gateway ─┤
                                                   ↓
                          Auth │ WALLET │ Slots │ VIP │ Sports │ Poker
                                   (only WALLET changes balances)
                                                   ↓
                                        MySQL 8  ·  Redis
```

```
packages/shared/     zod schemas, shared types, the slot engine, slot configs
apps/api/            Express + Prisma + Socket.IO
apps/web/            Vue 3 + Vite + Pinia + PixiJS
tools/slot-gen/      slot config generator, paytable tuner, RTP gate
tools/rtp-sim/       slot simulator (corroboration, hit frequency, volatility)
docs/rtp/            generated RTP reports, one per game
```

[`CLAUDE.md`](CLAUDE.md) holds the rules every contributor and AI agent reads first.

### The three rules

1. **Only the wallet changes balances.** Every other module calls `wallet.debit()`,
   `wallet.credit()` or `wallet.transact()`. Enforced by an ESLint rule that bans the Prisma
   calls which could do otherwise.
2. **The server decides every outcome.** Reel stops, shuffles and hand winners are computed
   server-side; the client is handed the result and animates to it. No browser ever holds a
   deck or an unrevealed card.
3. **Randomness is `node:crypto`.** `Math.random` is banned in the API, enforced by lint _and_
   by a test, because lint is easy to skip.

### Why SQLite, and what it costs

The PRD specifies MySQL 8, and [`apps/api/prisma/schema.prisma`](apps/api/prisma/schema.prisma)
targets it. The prototype runs on SQLite so it needs no Docker, and `prisma/sqlite.mjs` derives
the SQLite schema from the MySQL one.

The real cost is the wallet's debit lock. On MySQL, a debit takes `SELECT ... FOR UPDATE` and
the guarantee holds across any number of API instances. SQLite has no such statement, so the
wallet additionally serialises debits per wallet with an in-process mutex — **correct for
exactly one API process, and not more**. `lib/env.ts` refuses `DATABASE_PROVIDER=sqlite` in
production for that reason, and CI runs the wallet suite against real MySQL so the production
path is proven rather than assumed.

To run the PRD's data layer:

```bash
docker compose up -d mysql redis
# set DATABASE_PROVIDER=mysql, DATABASE_URL and REDIS_URL in .env
npm run db:push && npm run db:seed
```

---

## Slot maths

Every game's return-to-player is **calculated in closed form**, not sampled:
[`packages/shared/src/slots/exact.ts`](packages/shared/src/slots/exact.ts).

This is not gold-plating. The PRD asks for a million-round simulation inside a 0.5% tolerance,
and on a high-volatility game a million rounds still swings close to a full percentage point
between seeds — the measurement is wider than the thing it is measuring. Expected value,
though, is exactly computable: line expectation by enumerating all 100,000 symbol tuples, and
the scatter distribution by walking every stop and convolving the reels.

So the gate is the exact figure, it runs in milliseconds, and it is a unit test. The simulator
still exists and still matters — it corroborates the exact model against the live engine, and
measures hit frequency and volatility, which genuinely cannot be computed in closed form
because paylines share cells.

| Game            | Target | Exact RTP | Volatility       | Bonus       |
| --------------- | ------ | --------- | ---------------- | ----------- |
| Reef Riches     | 96.0%  | 95.99%    | Medium (SD 4.1x) | 1 in 37, ×2 |
| Kraken's Depths | 95.5%  | 95.48%    | High (SD 5.4x)   | 1 in 52, ×3 |
| Sunken Temple   | 96.5%  | 96.45%    | Low (SD 3.4x)    | 1 in 35, ×2 |

Full reports in [`docs/rtp/`](docs/rtp/). To change a game:

```bash
# edit tools/slot-gen/src/specs.ts, then
npm run slots:tune            # solves the paytable for the target, prints the numbers
npm run slots:generate        # rewrites the configs
npm run rtp -- --all --spins 1000000 --write-docs
# embed demo at      http://localhost:5173/embed-demo.html
```

A game must not be set `is_active` until its exact RTP is within 0.5% of target.

---

## Commands

```bash
npm run dev            # API + web together
npm run verify         # format, lint, typecheck, test - what CI runs
npm run test           # 119 tests across shared, slot-gen and api
npm run typecheck      # all five workspaces
npm run db:studio      # browse the database
npm run rtp -- --all   # simulate every game
```

---

## Security

Built to the PRD's requirements: Argon2id passwords with a common-password blocklist, 15-minute
JWTs held in memory only, refresh tokens in an `httpOnly` `SameSite=Strict` cookie and rotated
on every use with whole-family revocation on reuse, TOTP 2FA with Argon2id-hashed backup codes,
AES-256-GCM field encryption for TOTP secrets, helmet with a strict CSP, CORS pinned to one
origin, layered rate limits (per IP _and_ per account on login), zod validation on every
request body, query and socket message, and pino logging with secrets redacted by path.

Two things to know before this faces the internet: there is no email transport, and the TLS,
HSTS and secret-manager assumptions in the PRD are configuration this repository does not
provide.

If you find a security problem, please report it privately rather than opening an issue.
