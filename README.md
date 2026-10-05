# Luck-Cays

Luck-Cays is a demo-only game lobby and content-admin shell. Island Credits have no cash value. Deposits, withdrawals, wagers, and cash prizes are disabled and are not implemented.

## Run locally

Requirements: Node.js 20.9 or newer.

```powershell
cd apps/web
npm install
npm run dev
```

Open `http://localhost:3000`. If the port is busy, use the alternate port printed by Next.js.

## Secrets and configuration

Keep Aiven credentials, Firebase configuration, encryption keys, CA certificates, and MFA setup QR/text files local. Never commit `.env.local`, `.pem` files, or `.admin-mfa-*` files. Start from [apps/web/.env.example](apps/web/.env.example) and configure values in `apps/web/.env.local`.

Admin and database setup instructions are in [apps/web/README.md](apps/web/README.md). The existing Aiven MySQL database is used; the additive Luck-Cays migration is under `database/migrations`.

All real-money feature flags default to `false`. See [LUCK-CAYS.txt](LUCK-CAYS.txt) for the product/security specification.
