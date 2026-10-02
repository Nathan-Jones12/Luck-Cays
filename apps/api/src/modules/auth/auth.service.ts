/**
 * Signup, login and the account lifecycle.
 *
 * Two themes run through this file:
 *
 *  - ENUMERATION. Nothing here reveals whether an email is registered. Signup conflicts
 *    report the same thing for email and username, login reports one message for both a
 *    missing account and a wrong password, and a reset request always reports success.
 *  - LOCKOUT WITH BACKOFF. Failed logins are counted per account and the lock grows with
 *    each additional failure, so a password-spray attack slows down without a few typos
 *    locking a real user out for long.
 */
import type { AuthSession, LoginInput, PublicUser, Role, SignupInput } from "@luck-cays/shared";
import {
  accountLocked,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "../../lib/errors.js";
import { hashToken, secureToken } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { AUDIT_ACTIONS, record as audit } from "../admin/audit.service.js";
import { grantSignupBonus } from "../wallet/bonus.service.js";
import { ensureProgress } from "../vip/vip.service.js";
import { assertPasswordAllowed, hashPassword, verifyPassword } from "./password.js";
import {
  accessTokenTtlSeconds,
  issueRefreshToken,
  revokeAllForUser,
  signAccessToken,
  type IssuedRefreshToken,
} from "./tokens.js";
import {
  assertSecondFactor,
  countUnusedBackupCodes,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  regenerateBackupCodes,
  verifyTotpCode,
} from "./totp.js";

/* -------------------------------------------------------------------------- */
/* Shaping                                                                    */
/* -------------------------------------------------------------------------- */

interface UserRow {
  id: string;
  email: string;
  username: string;
  role: string;
  status: string;
  emailVerifiedAt: Date | null;
  totpEnabled: boolean;
  createdAt: Date;
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role as Role,
    status: user.status as PublicUser["status"],
    emailVerified: user.emailVerifiedAt !== null,
    totpEnabled: user.totpEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}

const PUBLIC_SELECT = {
  id: true,
  email: true,
  username: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  totpEnabled: true,
  createdAt: true,
} as const;

export interface SessionBundle {
  session: AuthSession;
  refresh: IssuedRefreshToken;
}

async function buildSession(user: UserRow): Promise<SessionBundle> {
  const [accessToken, refresh] = await Promise.all([
    signAccessToken(user.id, user.role as Role),
    issueRefreshToken(user.id),
  ]);

  return {
    session: { user: toPublicUser(user), accessToken, expiresIn: accessTokenTtlSeconds() },
    refresh,
  };
}

/* -------------------------------------------------------------------------- */
/* Signup                                                                     */
/* -------------------------------------------------------------------------- */

export interface SignupOutcome extends SessionBundle {
  signupBonus: bigint;
  /**
   * The email verification token. In a real deployment this is emailed and never
   * returned; the prototype has no mail transport, so it comes back here and the
   * route only includes it outside production.
   */
  verificationToken: string;
}

export async function signup(input: SignupInput, ip?: string): Promise<SignupOutcome> {
  assertPasswordAllowed(input.password, { email: input.email, username: input.username });

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: input.email }, { username: input.username }] },
    select: { id: true },
  });
  // One message for both, so this cannot be used to test which emails are registered.
  if (existing) {
    throw conflict("ACCOUNT_EXISTS", "An account with those details already exists");
  }

  const passwordHash = await hashPassword(input.password);
  const verificationToken = secureToken(32);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      username: input.username,
      passwordHash,
      role: "player",
      status: "active",
      adultConfirmedAt: new Date(),
      wallet: { create: { balance: 0n } },
      authTokens: {
        create: {
          kind: "verify_email",
          tokenHash: hashToken(verificationToken),
          expiresAt: new Date(Date.now() + 24 * 3_600_000),
        },
      },
    },
    select: PUBLIC_SELECT,
  });

  await ensureProgress(user.id);
  const bonus = await grantSignupBonus(user.id);

  await audit({
    actorId: user.id,
    action: AUDIT_ACTIONS.signup,
    targetType: "user",
    targetId: user.id,
    ip,
  });
  logger.info({ userId: user.id }, "signup");

  return { ...(await buildSession(user)), signupBonus: bonus.amount, verificationToken };
}

/* -------------------------------------------------------------------------- */
/* Login                                                                      */
/* -------------------------------------------------------------------------- */

/** Lock duration grows with consecutive failures: 1, 2, 4, 8... up to an hour. */
const LOCK_THRESHOLD = 5;
const LOCK_BASE_MS = 60_000;
const LOCK_MAX_MS = 3_600_000;

function lockDuration(failureCount: number): number {
  const overBy = Math.max(0, failureCount - LOCK_THRESHOLD);
  return Math.min(LOCK_BASE_MS * 2 ** overBy, LOCK_MAX_MS);
}

async function registerFailure(userId: string, ip?: string): Promise<void> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });

  if (user.failedLoginCount >= LOCK_THRESHOLD) {
    const lockedUntil = new Date(Date.now() + lockDuration(user.failedLoginCount));
    await prisma.user.update({ where: { id: userId }, data: { lockedUntil } });
    await audit({
      actorId: userId,
      action: AUDIT_ACTIONS.loginLocked,
      targetType: "user",
      targetId: userId,
      details: { failedLoginCount: user.failedLoginCount, lockedUntil: lockedUntil.toISOString() },
      ip,
    });
  }
}

export async function login(input: LoginInput, ip?: string): Promise<SessionBundle> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      ...PUBLIC_SELECT,
      passwordHash: true,
      totpSecretEnc: true,
      failedLoginCount: true,
      lockedUntil: true,
    },
  });

  if (!user) {
    // Still do the audit write, and report the same error as a bad password.
    await audit({ action: AUDIT_ACTIONS.loginFailed, details: { reason: "no_such_account" }, ip });
    throw unauthorized("Email or password is incorrect", "INVALID_CREDENTIALS");
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw accountLocked(user.lockedUntil);
  }

  if (!(await verifyPassword(user.passwordHash, input.password))) {
    await registerFailure(user.id, ip);
    await audit({
      actorId: user.id,
      action: AUDIT_ACTIONS.loginFailed,
      targetType: "user",
      targetId: user.id,
      details: { reason: "bad_password" },
      ip,
    });
    throw unauthorized("Email or password is incorrect", "INVALID_CREDENTIALS");
  }

  // Admins must have 2FA, per the PRD. Enforced at login so a privileged account
  // cannot sit unprotected even if the role was granted after signup.
  if (user.role === "admin" && !user.totpEnabled) {
    throw forbidden(
      "Administrators must enable two-factor authentication before signing in",
      "TOTP_REQUIRED_FOR_ADMIN",
    );
  }

  const secondFactor: { totp?: string; backupCode?: string } = {};
  if (input.totp !== undefined) secondFactor.totp = input.totp;
  if (input.backupCode !== undefined) secondFactor.backupCode = input.backupCode;
  await assertSecondFactor(user, secondFactor);

  if (user.status === "banned") throw forbidden("This account is suspended", "ACCOUNT_BANNED");
  if (user.status === "self_excluded") {
    throw forbidden("This account is self-excluded", "ACCOUNT_SELF_EXCLUDED");
  }

  // Successful login clears the failure counter and any expired lock.
  if (user.failedLoginCount > 0 || user.lockedUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }

  await audit({
    actorId: user.id,
    action: AUDIT_ACTIONS.login,
    targetType: "user",
    targetId: user.id,
    ip,
  });

  return buildSession(user);
}

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: PUBLIC_SELECT });
  if (!user) throw notFound("Account not found", "USER_NOT_FOUND");
  return toPublicUser(user);
}

/** Mint a fresh access token after a refresh rotation. */
export async function sessionForUser(userId: string): Promise<AuthSession> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: PUBLIC_SELECT });
  if (!user) throw notFound("Account not found", "USER_NOT_FOUND");

  return {
    user: toPublicUser(user),
    accessToken: await signAccessToken(user.id, user.role as Role),
    expiresIn: accessTokenTtlSeconds(),
  };
}

/* -------------------------------------------------------------------------- */
/* Email verification and password reset                                      */
/* -------------------------------------------------------------------------- */

async function consumeAuthToken(token: string, kind: string): Promise<string> {
  const row = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, kind: true, expiresAt: true, usedAt: true },
  });

  if (!row || row.kind !== kind || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    throw badRequest("TOKEN_INVALID", "This link is invalid or has expired");
  }

  // Guard on usedAt so two concurrent clicks cannot both consume it.
  const { count } = await prisma.authToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count !== 1) throw badRequest("TOKEN_INVALID", "This link is invalid or has expired");

  return row.userId;
}

export async function verifyEmail(token: string, ip?: string): Promise<void> {
  const userId = await consumeAuthToken(token, "verify_email");
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await audit({
    actorId: userId,
    action: AUDIT_ACTIONS.emailVerified,
    targetType: "user",
    targetId: userId,
    ip,
  });
}

/**
 * Begin a password reset.
 *
 * Returns the token so the prototype can show it (there is no mail transport). The
 * caller must not leak it in production, and must report success either way - whether
 * the address exists is not something an unauthenticated caller gets to learn.
 */
export async function requestPasswordReset(
  email: string,
  ip?: string,
): Promise<{ token: string | null }> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return { token: null };

  const token = secureToken(32);
  await prisma.authToken.create({
    data: {
      userId: user.id,
      kind: "password_reset",
      tokenHash: hashToken(token),
      // 30 minutes, per the PRD.
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });

  await audit({
    actorId: user.id,
    action: AUDIT_ACTIONS.passwordResetRequested,
    targetType: "user",
    targetId: user.id,
    ip,
  });

  return { token };
}

export async function confirmPasswordReset(
  token: string,
  newPassword: string,
  ip?: string,
): Promise<void> {
  const userId = await consumeAuthToken(token, "password_reset");

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, username: true },
  });
  assertPasswordAllowed(newPassword, user);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword), failedLoginCount: 0, lockedUntil: null },
  });

  // A reset is a credential change: end every existing session.
  await revokeAllForUser(userId);

  await audit({
    actorId: userId,
    action: AUDIT_ACTIONS.passwordReset,
    targetType: "user",
    targetId: userId,
    ip,
  });
}

/* -------------------------------------------------------------------------- */
/* Two-factor                                                                 */
/* -------------------------------------------------------------------------- */

export interface TotpSetup {
  secret: string;
  uri: string;
}

/**
 * Begin enrolment. The secret is stored encrypted but 2FA is NOT switched on until the
 * user proves they can generate a code - otherwise a mistyped QR scan would lock them
 * out of their own account.
 */
export async function beginTotpEnrolment(userId: string): Promise<TotpSetup> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, totpEnabled: true },
  });
  if (user.totpEnabled) {
    throw conflict("TOTP_ALREADY_ENABLED", "Two-factor authentication is already enabled");
  }

  const enrolment = generateTotpSecret(user.email);
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecretEnc: encryptTotpSecret(enrolment.secret) },
  });

  return enrolment;
}

export interface TotpActivation {
  backupCodes: string[];
}

export async function confirmTotpEnrolment(
  userId: string,
  code: string,
  ip?: string,
): Promise<TotpActivation> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { totpSecretEnc: true, totpEnabled: true },
  });

  if (user.totpEnabled) {
    throw conflict("TOTP_ALREADY_ENABLED", "Two-factor authentication is already enabled");
  }
  if (!user.totpSecretEnc) {
    throw badRequest("TOTP_NOT_STARTED", "Start two-factor setup before confirming it");
  }
  if (!verifyTotpCode(decryptTotpSecret(user.totpSecretEnc), code)) {
    throw unauthorized("That code is not valid", "TOTP_INVALID");
  }

  await prisma.user.update({ where: { id: userId }, data: { totpEnabled: true } });
  const backupCodes = await regenerateBackupCodes(userId);

  await audit({
    actorId: userId,
    action: AUDIT_ACTIONS.totpEnabled,
    targetType: "user",
    targetId: userId,
    ip,
  });

  return { backupCodes };
}

export async function disableTotp(userId: string, code: string, ip?: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true, totpEnabled: true, totpSecretEnc: true },
  });

  if (!user.totpEnabled || !user.totpSecretEnc) {
    throw conflict("TOTP_NOT_ENABLED", "Two-factor authentication is not enabled");
  }
  // Admins may not turn it off: the PRD makes it mandatory for them.
  if (user.role === "admin") {
    throw forbidden(
      "Administrators cannot disable two-factor authentication",
      "TOTP_REQUIRED_FOR_ADMIN",
    );
  }
  if (!verifyTotpCode(decryptTotpSecret(user.totpSecretEnc), code)) {
    throw unauthorized("That code is not valid", "TOTP_INVALID");
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecretEnc: null },
    }),
    prisma.backupCode.deleteMany({ where: { userId } }),
  ]);

  await audit({
    actorId: userId,
    action: AUDIT_ACTIONS.totpDisabled,
    targetType: "user",
    targetId: userId,
    ip,
  });
}

export async function regenerateCodes(
  userId: string,
  code: string,
  ip?: string,
): Promise<string[]> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { totpEnabled: true, totpSecretEnc: true },
  });

  if (!user.totpEnabled || !user.totpSecretEnc) {
    throw conflict("TOTP_NOT_ENABLED", "Two-factor authentication is not enabled");
  }
  if (!verifyTotpCode(decryptTotpSecret(user.totpSecretEnc), code)) {
    throw unauthorized("That code is not valid", "TOTP_INVALID");
  }

  const codes = await regenerateBackupCodes(userId);
  await audit({
    actorId: userId,
    action: AUDIT_ACTIONS.backupCodesRegenerated,
    targetType: "user",
    targetId: userId,
    ip,
  });
  return codes;
}

export async function backupCodesRemaining(userId: string): Promise<number> {
  return countUnusedBackupCodes(userId);
}
