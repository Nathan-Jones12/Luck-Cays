/**
 * The one error type routes and services throw. The error middleware turns it into
 * a status and a safe message; anything that is not an `AppError` becomes a 500 with
 * no detail, because an unexpected error's message may contain internals.
 */

export class AppError extends Error {
  readonly status: number;
  /** Stable, machine-readable. The client branches on this, never on the message. */
  readonly code: string;
  /** Safe to show a user. Never a stack trace, a SQL string or a secret. */
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = "Authentication required", code = "UNAUTHORIZED") =>
  new AppError(401, code, message);

export const forbidden = (message = "Not permitted", code = "FORBIDDEN") =>
  new AppError(403, code, message);

export const notFound = (message = "Not found", code = "NOT_FOUND") =>
  new AppError(404, code, message);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export const tooManyRequests = (message = "Too many requests", code = "RATE_LIMITED") =>
  new AppError(429, code, message);

/* -------------------------------------------------------------------------- */
/* Domain errors worth naming, because callers and the client react to them.  */
/* -------------------------------------------------------------------------- */

/** A debit was rejected because the balance would have gone below zero. */
export const insufficientFunds = (required: bigint, available: bigint) =>
  new AppError(422, "INSUFFICIENT_FUNDS", "Not enough chips for this bet", {
    required: required.toString(10),
    available: available.toString(10),
  });

/**
 * The same idempotency key was reused for a materially different request. Replaying
 * a key with identical parameters is fine and returns the original result; changing
 * the amount under a key that has already moved chips is a client bug worth
 * surfacing rather than silently honouring.
 */
export const idempotencyConflict = (key: string) =>
  new AppError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "This idempotency key was already used for a different request",
    { idempotencyKey: key },
  );

/** Odds moved between the player seeing them and the bet arriving. */
export const oddsChanged = (previous: string, current: string) =>
  new AppError(409, "ODDS_CHANGED", "The odds for this selection have changed", {
    previousOdds: previous,
    currentOdds: current,
  });

export const accountLocked = (until: Date) =>
  new AppError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.", {
    retryAfter: until.toISOString(),
  });
