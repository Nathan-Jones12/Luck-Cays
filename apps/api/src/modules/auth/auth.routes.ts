/**
 * Auth routes. Thin: validate, call the service, shape the response.
 *
 * The refresh token only ever travels as an httpOnly cookie - it is never in a response
 * body, so a cross-site script cannot read it even if one gets injected. The access
 * token IS in the body, because the client holds it in memory rather than in storage.
 */
import { Router } from "express";
import {
  confirmPasswordResetSchema,
  enableTotpSchema,
  loginSchema,
  requestPasswordResetSchema,
  signupSchema,
  verifyEmailSchema,
} from "@luck-cays/shared";
import { isProduction } from "../../lib/env.js";
import { unauthorized } from "../../lib/errors.js";
import { authOf, requireAuth } from "../../middleware/auth.js";
import {
  authAccountLimiter,
  authIpLimiter,
  passwordResetLimiter,
} from "../../middleware/rate-limit.js";
import { body, validateBody } from "../../middleware/validate.js";
import { AUDIT_ACTIONS, record as audit } from "../admin/audit.service.js";
import * as auth from "./auth.service.js";
import {
  REFRESH_COOKIE,
  revokeRefreshToken,
  rotateRefreshToken,
  type IssuedRefreshToken,
} from "./tokens.js";

export const authRouter = Router();

/**
 * `SameSite=Strict` on the refresh cookie, per the PRD. It means a refresh cannot be
 * triggered by any cross-site navigation, which is exactly the point.
 */
function setRefreshCookie(
  response: Parameters<Parameters<typeof authRouter.post>[1]>[1] & {
    cookie: (name: string, value: string, options: Record<string, unknown>) => void;
  },
  refresh: IssuedRefreshToken,
): void {
  response.cookie(REFRESH_COOKIE, refresh.token, {
    httpOnly: true,
    // Secure cookies are dropped over plain http, which would break local development.
    secure: isProduction,
    sameSite: "strict",
    path: "/api/auth",
    expires: refresh.expiresAt,
  });
}

function clearRefreshCookie(response: {
  clearCookie: (name: string, options: Record<string, unknown>) => void;
}): void {
  response.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/api/auth",
  });
}

authRouter.post("/signup", authIpLimiter, validateBody(signupSchema), async (request, response) => {
  const input = body(request, signupSchema);
  const result = await auth.signup(input, request.ip);

  setRefreshCookie(response as never, result.refresh);
  response.status(201).json({
    ...result.session,
    signupBonus: result.signupBonus.toString(10),
    // No mail transport in the prototype, so the link is returned here instead. Never
    // in production, where it would let anyone verify anyone's address.
    ...(isProduction ? {} : { verificationToken: result.verificationToken }),
  });
});

authRouter.post(
  "/login",
  authIpLimiter,
  authAccountLimiter,
  validateBody(loginSchema),
  async (request, response) => {
    const input = body(request, loginSchema);
    const result = await auth.login(input, request.ip);

    setRefreshCookie(response as never, result.refresh);
    response.json(result.session);
  },
);

/**
 * Exchange the refresh cookie for a new access token, rotating the refresh token.
 *
 * On any failure the cookie is cleared: the client's session is dead either way, and
 * leaving a known-bad token in the browser only invites a retry loop.
 */
authRouter.post("/refresh", async (request, response) => {
  const token = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (!token) {
    clearRefreshCookie(response);
    throw unauthorized("No session", "NO_REFRESH_TOKEN");
  }

  try {
    const rotated = await rotateRefreshToken(token);
    setRefreshCookie(response as never, rotated.refresh);
    response.json(await auth.sessionForUser(rotated.userId));
  } catch (error) {
    clearRefreshCookie(response);
    throw error;
  }
});

authRouter.post("/logout", async (request, response) => {
  const token = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (token) await revokeRefreshToken(token);

  clearRefreshCookie(response);
  await audit({ action: AUDIT_ACTIONS.logout, ip: request.ip });
  response.status(204).end();
});

authRouter.get("/me", requireAuth, async (request, response) => {
  const { userId } = authOf(request);
  response.json({
    user: await auth.getMe(userId),
    backupCodesRemaining: await auth.backupCodesRemaining(userId),
  });
});

authRouter.post("/verify-email", validateBody(verifyEmailSchema), async (request, response) => {
  const { token } = body(request, verifyEmailSchema);
  await auth.verifyEmail(token, request.ip);
  response.status(204).end();
});

/** Always reports success, so this cannot be used to discover registered addresses. */
authRouter.post(
  "/password-reset",
  passwordResetLimiter,
  validateBody(requestPasswordResetSchema),
  async (request, response) => {
    const { email } = body(request, requestPasswordResetSchema);
    const result = await auth.requestPasswordReset(email, request.ip);

    response.json({
      message: "If that address has an account, a reset link is on its way.",
      ...(isProduction || result.token === null ? {} : { resetToken: result.token }),
    });
  },
);

authRouter.post(
  "/password-reset/confirm",
  authIpLimiter,
  validateBody(confirmPasswordResetSchema),
  async (request, response) => {
    const { token, password } = body(request, confirmPasswordResetSchema);
    await auth.confirmPasswordReset(token, password, request.ip);

    // Every session is gone, including this one.
    clearRefreshCookie(response);
    response.status(204).end();
  },
);

/* --------------------------------- two-factor ------------------------------- */

authRouter.post("/totp/begin", requireAuth, async (request, response) => {
  const { userId } = authOf(request);
  response.json(await auth.beginTotpEnrolment(userId));
});

authRouter.post(
  "/totp/confirm",
  requireAuth,
  validateBody(enableTotpSchema),
  async (request, response) => {
    const { userId } = authOf(request);
    const { totp } = body(request, enableTotpSchema);
    response.json(await auth.confirmTotpEnrolment(userId, totp, request.ip));
  },
);

authRouter.post(
  "/totp/disable",
  requireAuth,
  validateBody(enableTotpSchema),
  async (request, response) => {
    const { userId } = authOf(request);
    const { totp } = body(request, enableTotpSchema);
    await auth.disableTotp(userId, totp, request.ip);
    response.status(204).end();
  },
);

authRouter.post(
  "/totp/backup-codes",
  requireAuth,
  validateBody(enableTotpSchema),
  async (request, response) => {
    const { userId } = authOf(request);
    const { totp } = body(request, enableTotpSchema);
    response.json({ backupCodes: await auth.regenerateCodes(userId, totp, request.ip) });
  },
);
