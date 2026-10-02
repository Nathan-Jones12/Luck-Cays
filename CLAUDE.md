# Luck-Cays — rules for every agent and developer

Read this before touching code. The full specification is `docs/PRD.md`.

Luck-Cays is a **play-money** casino. Luck-Cays Chips (LC) have no cash value and
can never be cashed out. There is no deposit, withdrawal or purchase path, and
nothing in this repo may add one.

## The three rules that must never be broken

1. **Only the wallet changes balances.** `apps/api/src/modules/wallet` is the
   single writer of `wallets.balance`. No other module may `UPDATE wallets` or
   insert into `ledger_entries`. Call `wallet.debit()` / `wallet.credit()`.
2. **The server decides every outcome.** Reel stops, shuffles, hand winners and
   bet settlement are computed server-side. The client is given the result and
   animates to it. Never send a deck, an unrevealed card or an RNG seed to a
   browser.
3. **Randomness comes from `node:crypto`.** `crypto.randomInt` /
   `crypto.randomBytes` only. `Math.random` is banned in `apps/api` and is
   enforced by lint and by `apps/api/tests/no-math-random.test.ts`.

## Money invariants

- Chips are whole integers. Columns are `BIGINT`, carried in TypeScript as
  `bigint`, serialised to JSON as a decimal **string**. Never `number`, never
  floats — `number` silently loses precision past 2^53.
- `ledger_entries` is append-only. Never `UPDATE` or `DELETE` a ledger row. A
  mistake is corrected by writing a compensating entry.
- Balance is derived and verifiable: the latest `balance_after` must equal
  `wallets.balance`, and the sum of all `amount` for a wallet must equal it too.
  `npm run test --workspace @luck-cays/api` asserts this.
- Every debit runs inside a transaction that locks the wallet row
  (`SELECT ... FOR UPDATE` on MySQL) and is rejected if the balance would go
  below zero.
- Every bet carries an `idempotency_key`. Replaying a key returns the original
  result and never moves chips twice.

## Layout and ownership

```
packages/shared/   zod schemas, shared types, the slot engine, exact RTP maths,
                   generated slot configs                        (both lanes)
apps/api/          Express + Prisma + Socket.IO
  src/lib/         env, errors, logger, prisma, redis, crypto
  src/modules/     auth wallet slots vip sports poker admin config
  src/middleware/  auth, roles, rate limits, validation, errors
  src/sockets/     Socket.IO handlers
  src/jobs/        sports sync, settlement, cashback, token pruning
apps/web/          Vue 3 + Vite + Pinia + PixiJS
tools/slot-gen/    slot spec -> config generator, paytable tuner, the RTP gate
tools/rtp-sim/     slot simulator: corroboration, hit frequency, volatility
docs/rtp/          generated RTP reports, one per game
```

Per the PRD team split: **Dev A (platform)** owns auth, wallet, VIP, sports and
admin. **Dev B (games)** owns the slots engine, RTP sim and poker. The lanes meet
only at the wallet API — if you need to change the wallet's public signature,
that is a cross-lane change: say so, don't do it quietly.

## Conventions

- TypeScript strict everywhere. No `any` without a comment saying why.
- Validate **every** request body, query and socket message with a zod schema
  from `packages/shared`. Parse at the boundary; trust the parsed type inward.
- Routes stay thin: validate, call a service, shape the response. Business logic
  and all database access live in the service.
- Errors: throw `AppError` (`src/lib/errors.ts`); the error middleware maps it to
  a status and a safe message. Never leak a stack trace or a SQL string.
- Logging is `pino` with secrets redacted. Never log a password, token, TOTP
  secret or full card/hole-card state.
- Prisma only — no string-concatenated SQL. Raw SQL needs a parameterised
  `$queryRaw` tagged template and a comment explaining why Prisma can't do it.

## Database

The canonical schema is `apps/api/prisma/schema.prisma` and targets **MySQL 8**,
as the PRD specifies. The prototype runs on SQLite so it needs no Docker:
`npm run db:push` generates a SQLite variant when `DATABASE_PROVIDER=sqlite`.
Edit only the MySQL schema — the SQLite one is generated and gitignored.

SQLite has no `SELECT ... FOR UPDATE`. The wallet therefore serialises debits
through an in-process mutex on SQLite and uses a real row lock on MySQL; both
paths are in `wallet/wallet.service.ts` and marked `LOCKING:`. Only the MySQL
path is safe across multiple API instances.

## Slot maths

RTP is **calculated in closed form**, not sampled — `packages/shared/src/slots/exact.ts`.
That is the figure the gate uses and the one a game is signed off against.

Why: Monte Carlo cannot certify the PRD's 0.5% tolerance. On a high-volatility game a
million rounds still swings close to a full percentage point between seeds, so the
measurement is wider than the thing being measured. Expected value, though, is exactly
computable — line expectation by enumerating all symbol tuples, scatters by walking every
stop and convolving the reels.

`tools/rtp-sim` still matters. It corroborates the exact model against the live engine (if
they disagree beyond the simulation's CI, they have drifted and that is a bug), and it
measures hit frequency and volatility, which genuinely cannot be computed in closed form
because paylines share cells.

To change a game: edit `tools/slot-gen/src/specs.ts`, then

```bash
npm run slots:tune        # solves the paytable for the target, prints the numbers
npm run slots:generate    # rewrites the configs
npm run rtp -- --all --spins 1000000 --write-docs
```

Never hand-edit a file in `packages/shared/src/slots/configs` — the reel strips there are
derived from the symbol counts, so editing them makes the documented composition a lie.

A new slot game may not be marked `is_active` until its exact RTP is within 0.5% of
`rtp_target`. `tools/slot-gen/src/rtp.test.ts` enforces this in milliseconds.

## Before you call something done

```bash
npm run verify        # format, lint, typecheck, test - exactly what CI runs
```

Lint is not cosmetic here: it is what stops a module other than the wallet writing a
balance, and what bans `Math.random` in the API. The same two rules are also tests, because
lint is easy to skip.
