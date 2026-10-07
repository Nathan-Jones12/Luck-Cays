# Luck-Cays frontend

The Vue 3 + Vite + Pinia + PixiJS frontend from the Luck-Cays monorepo (`apps/web`),
extracted to run on its own against a backend of your choice.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # vue-tsc typecheck + production build into dist/
```

## Wiring up a backend

The dev server proxies `/api` and `/socket.io` to `http://localhost:4000`
(`vite.config.ts` → `server.proxy`). Point that at your backend. Keeping the API
same-origin through the proxy matters: the refresh token is a `SameSite=Strict`
cookie, which the browser will not send cross-origin.

All HTTP calls go through `src/api/client.ts` (base path `/api`, JSON, bearer
access token, automatic `/auth/refresh` on 401). Real-time poker and balance
updates go through `src/api/socket.ts` (Socket.IO).

## The API contract: `src/shared`

`src/shared` is a copy of the monorepo's `packages/shared/src`. It is imported as
`@luck-cays/shared` (aliased in `vite.config.ts` and `tsconfig.json`) and holds:

- `schemas/` — zod schemas and TypeScript types for every request and response
  (auth, wallet, slots, sports, poker, vip, admin, embed). This is the contract
  your backend needs to satisfy.
- `money.ts` — chip amounts are whole numbers sent as decimal **strings** in JSON
  and handled as `bigint`.
- `slots/` — the slot engine and game configs. The frontend only needs their
  types and symbol data for rendering; outcomes must come from the server.

Endpoints the frontend calls (all under `/api`):

| Area   | Endpoints |
| ------ | --------- |
| Auth   | `POST /auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/totp/begin`, `/auth/totp/confirm`, `/auth/totp/disable`; `GET /auth/me` |
| Wallet | `GET /wallet`, `/wallet/bonuses`; `POST /wallet/bonuses/claim` |
| Slots  | `GET /slots`, `/slots/history/rounds`; `POST /slots/spin` |
| Sports | `GET /sports/events`, `/sports/bets`; `POST /sports/bets` |
| Poker  | `GET /poker/tables` (play is over Socket.IO) |
| VIP    | `GET /vip/me`, `/vip/tiers` |
| Admin  | `GET /admin/slots`, `/admin/audit`; `PATCH /admin/slots/...`; `POST /admin/players/chips`, `/admin/players/status` |
| Embed  | `POST /launch` (launch tickets for `game.html`) |
