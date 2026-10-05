# Luck-Cays

The current application is a demo-only game lobby and administrator game catalog. Island Credits have no cash value; payments, withdrawals, cash prizes, and real-money play are not implemented.

## Requirements

- Node.js 20.9 or newer
- Aiven MySQL with a database account for the application
- A Firebase Authentication project with Email/Password sign-in enabled
- The Aiven CA certificate

The existing Firebase project can be reused. Luck-Cays permissions are stored in its own MySQL tables; this app does not write Firebase custom claims or modify the other website's tables.

## Step-by-step: Enable Admin Sign-in

Do these steps on your machine. Do not paste passwords, database URLs, TOTP setup URIs, or encryption keys into chat.

1. Open the Firebase project you want to use in Firebase Console. Reusing the existing project's Authentication does not change its users, claims, or settings from this app, but it does use the same Firebase user directory. Luck-Cays admin roles remain in the separate `luck_cays_admins` MySQL table.
2. In **Authentication → Sign-in method**, ensure **Email/Password** is enabled. In **Authentication → Settings → Authorized domains**, ensure `localhost` is allowed for local development.
3. In **Project settings → General**, register a Web app if this project does not already have one. Copy its `apiKey`, `authDomain`, `projectId`, and `appId` locally. The Firebase Web API key is browser configuration, not an admin credential.
4. Create an admin Firebase Auth user, verify its email, and copy its Firebase **UID** from the Users page. Use the exact verified email address for bootstrap.
5. Open `apps/web/.env.local` and add these values from the Firebase project and user. The project IDs must match:

   ```dotenv
   FIREBASE_PROJECT_ID=your-firebase-project-id
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-firebase-project-id
   NEXT_PUBLIC_FIREBASE_API_KEY=your-firebase-web-api-key
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   NEXT_PUBLIC_FIREBASE_APP_ID=your-firebase-web-app-id
   BOOTSTRAP_ADMIN_FIREBASE_UID=the-admin-user-uid
   BOOTSTRAP_ADMIN_EMAIL=the-verified-admin-email
   ```

6. Generate a unique 32-byte TOTP encryption key from `apps/web` and put the printed value in `ADMIN_TOTP_ENCRYPTION_KEY` in `.env.local`:

   ```powershell
   cd apps/web
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Keep this key backed up in a private secrets manager. Losing it prevents decryption of existing admin MFA secrets. Never commit `.env.local`.
7. Restart the Next.js dev server so it reads the new environment settings:

   ```powershell
   npm run dev
   ```

8. From `apps/web`, run the one-time admin bootstrap:

   ```powershell
   npm run admin:bootstrap
   ```

9. Open `apps/web/.admin-mfa-setup.txt`, scan its URI with an authenticator app, then securely delete the setup file. It is Git-ignored but contains the MFA enrollment secret.
10. Open `http://localhost:3000/admin`, sign in with the verified Firebase email/password, and enter the current six-digit authenticator code. Add a demo game and choose Draft or Publish to lobby.
11. Confirm the published title appears on the home page. Sign out and confirm admin APIs no longer accept the session.

The migration is already applied to the configured Aiven MySQL database. It can be safely rechecked with `npm run db:migrate` from `apps/web`; it reports the existing migration as already applied. Runtime credentials are in `.env.local`, and the optional `MIGRATION_DATABASE_URL` can be used for a separately scoped account for the migration/bootstrap operations.

All `ENABLE_*` flags stay `false`. The sign-in, MFA, session, game catalog, filtering, search, favorites, and admin game-create flows are implemented. Real Firebase sign-in and successful game creation cannot be verified until the Firebase values above and first admin bootstrap are completed.

Player registration/login, game launching/playing, favorites persistence, account/security pages, support ticket submission, promotions, and payment flows are not implemented yet. Game cards are catalog-only, and deposits, withdrawals, wagers, and cash prizes remain unavailable.

## Database

The existing schema was inspected read-only before migration. It contains 34 existing InnoDB tables, including `users`, `admins`, and `payments`; Luck-Cays does not alter or reuse them. Migration `database/migrations/001_luck_cays_admin_catalog.sql` adds only `luck_cays_*` tables for the admin allowlist, sessions, demo game catalog, audit log, and security events. `real_money_enabled` is constrained to zero.

That migration has been applied to the configured Aiven database and verified by the public catalog API. The explicit migration command is idempotent and records applied migration names:

```powershell
cd apps/web
npm run db:migrate
```

Never drop/reset the database or delete audit records. A migration that partially fails can be rerun because its table creation statements use `IF NOT EXISTS`.

## First admin setup

1. Create or choose an Email/Password Firebase Auth user and verify its email. Use its Firebase UID and verified email in `.env.local`.
2. Set `ADMIN_TOTP_ENCRYPTION_KEY` and the Firebase client/server configuration.
3. Run the one-time bootstrap:

   ```powershell
   cd apps/web
   npm run admin:bootstrap
   ```

4. Scan the private URI in `.admin-mfa-setup.txt` with an authenticator app, then delete that file.
5. Open `/admin`, sign in with the Firebase account, and enter the current six-digit TOTP code.

## Add another content administrator

The bootstrap SUPER_ADMIN is tied to the Firebase UID and email that were present when it was created. Do not edit that row or rerun the one-time bootstrap to change users. To provision another account:

1. In Firebase Console → Authentication → Users, find the intended verified account and copy its UID.
2. Add `CONTENT_ADMIN_FIREBASE_UID` and `CONTENT_ADMIN_EMAIL` for that exact account to `apps/web/.env.local`. Keep the Firebase server/client project settings pointed to the same project.
3. From `apps/web`, run `npm run admin:provision-content`. This adds a separate `CONTENT_ADMIN` row and an audit event without modifying existing administrators.
4. Scan the generated `.admin-mfa-<id>.png` with Microsoft Authenticator using **+ → Other account → Scan QR code**. Then securely delete both matching `.txt` and `.png` MFA setup files.
5. Sign in at `/admin` using that verified Firebase email/password and its newly enrolled authenticator code.

Bootstrap is one-time. Admin sessions are opaque, stored hashed in MySQL, HttpOnly, SameSite Strict, and expire after 15 minutes. Admin create actions require a same-origin request, a valid session, an active role, server-side validation, and an audit transaction.

## Run locally

```powershell
cd apps/web
npm run dev
```

Open `http://localhost:3000`. If that port is occupied, Next.js will choose another port and print it.

## Catalog behavior

- `GET /api/games` returns only published, demo-only games.
- `GET /api/admin/games` requires an active admin session.
- `POST /api/admin/games` requires an active `SUPER_ADMIN` or `CONTENT_ADMIN` session.
- Game inserts and their audit records share a MySQL transaction.
- Public cards are not launchable yet; the games are catalog entries only.
- Deposits, withdrawals, wagers, cash prizes, and real-money provider integrations are not available.
