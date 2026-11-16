/**
 * The game's API client.
 *
 * Separate from `src/api/client.ts` on purpose. That one holds a player session, refreshes it
 * against an httpOnly cookie and knows about the whole site. This one holds a single
 * game-scoped token, has no refresh path and can reach exactly two endpoints. Sharing the
 * site's client here would drag the cookie-refresh machinery into the iframe, which is the
 * opposite of what the scoping is for.
 *
 * When this token expires the game cannot renew it by itself - by design. It tells the host,
 * and the host mints a fresh launch ticket.
 */
import type { GameSession } from "@luck-cays/shared";

/** Same-origin in development via the Vite proxy; an absolute API origin in production. */
const BASE = import.meta.env["VITE_API_BASE"] ?? "/api";

let gameToken: string | null = null;

export function setGameToken(token: string): void {
  gameToken = token;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(gameToken ? { Authorization: `Bearer ${gameToken}` } : {}),
      ...(init.headers ?? {}),
    },
    // No credentials: the game has no cookie and must not be able to ride the player's.
    credentials: "omit",
  });

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new Error(error?.message ?? `Request failed with status ${response.status}`);
  }

  return payload as T;
}

/**
 * Redeem the launch ticket. One shot - a second call with the same token fails, which is the
 * point of the single-use design.
 */
export async function exchangeTicket(token: string): Promise<GameSession> {
  return call<GameSession>("/launch/exchange", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function gameGet<T>(path: string): Promise<T> {
  return call<T>(path, { method: "GET" });
}

export async function gamePost<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: "POST", body: JSON.stringify(body) });
}
