import { z } from "zod";
import { chipStringSchema } from "./common.js";
import type { ChipString } from "../money.js";

/**
 * The embedding contract: how one of our front-ends launches a game, and how the host page
 * and the game talk to each other once it is running.
 *
 * The shape is the one game providers use, for the same reasons:
 *
 *  - The host page asks OUR api for a launch ticket, puts it in an iframe URL, and never
 *    touches a real access token. A page that cannot hold a credential cannot leak one.
 *  - The game runs on its own origin, so an XSS in a host page cannot read the game's
 *    session, and a bug in the game cannot read the host's cookies.
 *  - Everything after launch is `postMessage`, with the origin checked on both ends.
 */

/** Brands are our own front-ends. Each selects a palette in the game shell. */
export const brandSchema = z.enum(["luck-cays", "reef", "abyss", "temple"]);
export type Brand = z.infer<typeof brandSchema>;

/* -------------------------------------------------------------------------- */
/* Launch                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mint a launch ticket. Called by the host page's own backend-for-frontend, or by the host
 * page itself if it holds a normal player session.
 */
export const createLaunchSchema = z.object({
  gameSlug: z.string().min(1).max(60),
  brand: brandSchema.default("luck-cays"),
  /**
   * The origin that will embed the iframe. Checked when the ticket is redeemed, so a
   * stolen URL cannot be replayed from somewhere else.
   */
  origin: z.string().url().optional(),
  /** Where the game should send the player when they close it. */
  returnUrl: z.string().url().optional(),
});
export type CreateLaunchInput = z.infer<typeof createLaunchSchema>;

export interface LaunchTicket {
  /** The full iframe `src`, ticket included. Use this rather than assembling it yourself. */
  launchUrl: string;
  /** Seconds until the ticket expires. Deliberately short. */
  expiresIn: number;
  gameSlug: string;
  brand: Brand;
}

/** Redeem a ticket for a game session. Called once, by the game itself. */
export const exchangeLaunchSchema = z.object({
  token: z.string().min(20).max(200),
});

/**
 * What the game gets back. The session token is scoped to this one game and carries no
 * account powers - it cannot claim a bonus, change a password or read the ledger.
 */
export interface GameSession {
  sessionToken: string;
  expiresIn: number;
  gameSlug: string;
  brand: Brand;
  player: { username: string };
  balance: ChipString;
  returnUrl: string | null;
}

export const gameBalanceSchema = z.object({ balance: chipStringSchema });

/* -------------------------------------------------------------------------- */
/* postMessage protocol                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every message is namespaced, because a host page's `window` is shared with whatever else
 * that page runs - analytics, chat widgets, other embeds. An unprefixed `{type: "ready"}`
 * would collide eventually.
 */
export const EMBED_PROTOCOL = "lc-embed/1";

/** Game -> host. Informational: the host reacts, it never authorises anything. */
export const gameToHostSchema = z.discriminatedUnion("type", [
  /** The game has loaded and redeemed its ticket. */
  z.object({ protocol: z.literal(EMBED_PROTOCOL), type: z.literal("ready"), gameSlug: z.string() }),

  /** The balance changed. The host may mirror it in its own header. */
  z.object({
    protocol: z.literal(EMBED_PROTOCOL),
    type: z.literal("balance"),
    balance: chipStringSchema,
  }),

  /** A round settled. Useful for host-side celebration or analytics. */
  z.object({
    protocol: z.literal(EMBED_PROTOCOL),
    type: z.literal("round"),
    bet: chipStringSchema,
    win: chipStringSchema,
    freeSpinsAwarded: z.number().int().nonnegative(),
  }),

  /** The game wants to be this tall. Lets the host avoid a scrollbar inside the iframe. */
  z.object({
    protocol: z.literal(EMBED_PROTOCOL),
    type: z.literal("resize"),
    height: z.number().int().positive().max(4000),
  }),

  /** The player asked to leave. The host should navigate or close the modal. */
  z.object({ protocol: z.literal(EMBED_PROTOCOL), type: z.literal("exit") }),

  /**
   * Something went wrong, including an expired session. The host decides whether to mint a
   * fresh ticket and reload.
   */
  z.object({
    protocol: z.literal(EMBED_PROTOCOL),
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type GameToHostMessage = z.infer<typeof gameToHostSchema>;

/**
 * Host -> game. Deliberately tiny, and deliberately contains nothing that could influence an
 * outcome or a balance. The host is a frame around the game, not a participant in it: a
 * message that could set a balance or a bet would make every embedding page part of the
 * trust boundary.
 */
export const hostToGameSchema = z.discriminatedUnion("type", [
  z.object({ protocol: z.literal(EMBED_PROTOCOL), type: z.literal("mute"), muted: z.boolean() }),
  /** Hand the game a fresh session after its previous one expired. */
  z.object({
    protocol: z.literal(EMBED_PROTOCOL),
    type: z.literal("resume"),
    token: z.string().min(20).max(200),
  }),
]);
export type HostToGameMessage = z.infer<typeof hostToGameSchema>;
