import { z } from "zod";
import { roleSchema, userStatusSchema } from "./common.js";

/**
 * Password policy per the PRD: at least 10 characters, checked against a
 * common-password list server-side (`apps/api/src/modules/auth/common-passwords.ts`).
 * Length is all we can check on the client; the server is the authority.
 */
export const passwordSchema = z
  .string()
  .min(10, "password must be at least 10 characters")
  .max(200, "password must be at most 200 characters");

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .regex(/^[A-Za-z0-9_]+$/, "letters, numbers and underscore only");

export const signupSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
  /** Play-money still means 18+. The server stores that this was affirmed. */
  confirmAdult: z.literal(true, {
    errorMap: () => ({ message: "you must confirm you are 18 or over" }),
  }),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  /** Required when the account has TOTP enabled. */
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  /** A backup code may be sent instead of a TOTP code. */
  backupCode: z.string().min(8).max(32).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const requestPasswordResetSchema = z.object({ email: emailSchema });

export const confirmPasswordResetSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });

export const enableTotpSchema = z.object({
  /** Proves the user stored the secret before we switch 2FA on. */
  totp: z.string().regex(/^\d{6}$/),
});

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  emailVerified: z.boolean(),
  totpEnabled: z.boolean(),
  createdAt: z.string(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

/**
 * Login/refresh response. The access token is held in memory by the client only;
 * the refresh token travels in an httpOnly cookie and never appears here.
 */
export interface AuthSession {
  user: PublicUser;
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}
