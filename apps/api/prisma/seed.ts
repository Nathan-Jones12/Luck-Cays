/**
 * Seed the database with everything the prototype needs to be playable:
 * config values, VIP tiers, the three slot games, poker tables, demo fixtures, and two
 * demo accounts.
 *
 * Idempotent throughout - re-running it updates rather than duplicating, so it is safe to
 * run against a database that already has data.
 *
 *   npm run db:seed --workspace @luck-cays/api
 */
import { slotGames } from "@luck-cays/shared";
import { prisma } from "../src/lib/prisma.js";
import { logger } from "../src/lib/logger.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { seedDefaults } from "../src/modules/config/config.service.js";
import { DEFAULT_TIERS, ensureProgress } from "../src/modules/vip/vip.service.js";
import { grantSignupBonus } from "../src/modules/wallet/bonus.service.js";
import {
  encryptTotpSecret,
  generateTotpSecret,
  regenerateBackupCodes,
} from "../src/modules/auth/totp.js";
import { syncDemoFixtures } from "../src/modules/sports/sports.sync.js";

async function seedVipTiers(): Promise<void> {
  for (const tier of DEFAULT_TIERS) {
    await prisma.vipTier.upsert({
      where: { id: tier.id },
      create: { ...tier },
      update: {
        name: tier.name,
        minPoints: tier.minPoints,
        dailyMultiplierBp: tier.dailyMultiplierBp,
        levelupBonus: tier.levelupBonus,
        cashbackPct: tier.cashbackPct,
      },
    });
  }
  logger.info({ count: DEFAULT_TIERS.length }, "VIP tiers seeded");
}

/**
 * Seed the slot games from the registry in `packages/shared`.
 *
 * All three are set active: each has a closed-form RTP within 0.5% of its target, recorded
 * in `docs/rtp/`. A new game added later must stay inactive until its own figure is signed
 * off - see CLAUDE.md.
 */
async function seedSlotGames(): Promise<void> {
  for (const config of slotGames.values()) {
    await prisma.slotGame.upsert({
      where: { slug: config.slug },
      create: {
        slug: config.slug,
        name: config.name,
        configJson: JSON.stringify(config),
        rtpTargetBp: Math.round(config.rtpTarget * 10_000),
        isActive: true,
      },
      update: {
        name: config.name,
        configJson: JSON.stringify(config),
        rtpTargetBp: Math.round(config.rtpTarget * 10_000),
      },
    });
  }
  logger.info({ count: slotGames.size }, "slot games seeded");
}

const POKER_TABLES = [
  {
    name: "Shallow Reef",
    maxSeats: 6,
    smallBlind: 10n,
    bigBlind: 20n,
    minBuyin: 400n,
    maxBuyin: 4_000n,
  },
  {
    name: "Coral Garden",
    maxSeats: 6,
    smallBlind: 50n,
    bigBlind: 100n,
    minBuyin: 2_000n,
    maxBuyin: 20_000n,
  },
  {
    name: "The Drop-Off",
    maxSeats: 6,
    smallBlind: 250n,
    bigBlind: 500n,
    minBuyin: 10_000n,
    maxBuyin: 100_000n,
  },
  {
    name: "Heads-Up Cove",
    maxSeats: 2,
    smallBlind: 25n,
    bigBlind: 50n,
    minBuyin: 1_000n,
    maxBuyin: 10_000n,
  },
];

async function seedPokerTables(): Promise<void> {
  for (const table of POKER_TABLES) {
    const existing = await prisma.pokerTable.findFirst({
      where: { name: table.name },
      select: { id: true },
    });

    if (existing) {
      await prisma.pokerTable.update({
        where: { id: existing.id },
        data: { ...table, isActive: true },
      });
    } else {
      await prisma.pokerTable.create({ data: { ...table, isActive: true } });
    }
  }
  logger.info({ count: POKER_TABLES.length }, "poker tables seeded");
}

/**
 * Two demo accounts so the prototype can be clicked through immediately. Created only
 * outside production.
 *
 * The admin is seeded with TOTP already enrolled, and the secret is printed at the end.
 * That is not a shortcut around the rule - the PRD makes 2FA mandatory for admins and
 * `auth.service` refuses an admin login without it, so an admin seeded without a secret
 * would be an account nobody could ever use. Enrolling it here keeps the rule intact and
 * the account usable, at the cost of a secret on your terminal, which is an acceptable
 * trade for a development fixture and for nothing else.
 */
const DEMO_PASSWORD = "luckcays-demo-2026";

interface SeededAdmin {
  totpSecret: string;
  totpUri: string;
  backupCodes: string[];
}

async function seedDemoAccounts(): Promise<SeededAdmin | null> {
  if (process.env.NODE_ENV === "production") {
    logger.warn("skipping demo accounts in production");
    return null;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const accounts = [
    { email: "player@luck-cays.test", username: "demoplayer", role: "player" },
    { email: "admin@luck-cays.test", username: "demoadmin", role: "admin" },
  ];

  let admin: SeededAdmin | null = null;

  for (const account of accounts) {
    const isAdmin = account.role === "admin";

    // A fresh secret per seed run, so a leaked one from an earlier run stops working.
    const enrolment = isAdmin ? generateTotpSecret(account.email) : null;

    const user = await prisma.user.upsert({
      where: { email: account.email },
      create: {
        email: account.email,
        username: account.username,
        passwordHash,
        role: account.role,
        status: "active",
        emailVerifiedAt: new Date(),
        adultConfirmedAt: new Date(),
        ...(enrolment
          ? { totpSecretEnc: encryptTotpSecret(enrolment.secret), totpEnabled: true }
          : {}),
        wallet: { create: { balance: 0n } },
      },
      update: {
        role: account.role,
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        ...(enrolment
          ? { totpSecretEnc: encryptTotpSecret(enrolment.secret), totpEnabled: true }
          : {}),
      },
      select: { id: true, email: true },
    });

    // Make sure an account created by an earlier run still has a wallet.
    const wallet = await prisma.wallet.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!wallet) await prisma.wallet.create({ data: { userId: user.id, balance: 0n } });

    await ensureProgress(user.id);
    // Idempotent: the signup bonus is keyed on the user, so re-seeding grants nothing extra.
    await grantSignupBonus(user.id);

    if (enrolment) {
      admin = {
        totpSecret: enrolment.secret,
        totpUri: enrolment.uri,
        backupCodes: await regenerateBackupCodes(user.id),
      };
    }
  }

  logger.info({ count: accounts.length }, "demo accounts seeded");
  return admin;
}

async function main(): Promise<void> {
  await seedDefaults();
  await seedVipTiers();
  await seedSlotGames();
  await seedPokerTables();
  await syncDemoFixtures();
  const admin = await seedDemoAccounts();

  const [users, games, tables, events] = await Promise.all([
    prisma.user.count(),
    prisma.slotGame.count(),
    prisma.pokerTable.count(),
    prisma.sportsEvent.count(),
  ]);

  console.log(`
Seed complete.

  users          ${users}
  slot games     ${games}
  poker tables   ${tables}
  sports events  ${events}

Demo player   player@luck-cays.test   ${DEMO_PASSWORD}
Demo admin    admin@luck-cays.test    ${DEMO_PASSWORD}
`);

  if (admin) {
    console.log(`The admin has 2FA enrolled, because the PRD makes it mandatory for admins and the
login route enforces that. Add this secret to an authenticator app to sign in:

  secret        ${admin.totpSecret}
  otpauth URI   ${admin.totpUri}

  backup codes  ${admin.backupCodes.join("  ")}

These are development fixtures on a local database. A fresh secret is generated every time
you seed, so anything printed by an earlier run has already stopped working.
`);
  }
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "seed failed");
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
