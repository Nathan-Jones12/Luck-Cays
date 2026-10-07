import { z } from "zod";
import { chipStringSchema } from "./common.js";

/**
 * Poker runs over Socket.IO. Every inbound message is parsed with one of these
 * schemas before the state machine sees it.
 *
 * Card notation is rank + suit, e.g. "As", "Td", "7c", "2h".
 */
export const cardSchema = z.string().regex(/^(?:[2-9TJQKA])[cdhs]$/);
export type Card = z.infer<typeof cardSchema>;

export const streetSchema = z.enum(["preflop", "flop", "turn", "river", "showdown"]);
export type Street = z.infer<typeof streetSchema>;

export const actionTypeSchema = z.enum(["fold", "check", "call", "bet", "raise", "allin"]);
export type ActionType = z.infer<typeof actionTypeSchema>;

export const pokerTableSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  maxSeats: z.number().int().min(2).max(6),
  smallBlind: chipStringSchema,
  bigBlind: chipStringSchema,
  minBuyin: chipStringSchema,
  maxBuyin: chipStringSchema,
  seatedCount: z.number().int().nonnegative(),
  isActive: z.boolean(),
});
export type PokerTableSummary = z.infer<typeof pokerTableSummarySchema>;

/* ----------------------------- client -> server ---------------------------- */

export const joinTableSchema = z.object({
  tableId: z.string().min(1),
  seatNo: z.number().int().min(0).max(5).optional(),
  buyin: chipStringSchema,
});

export const leaveTableSchema = z.object({ tableId: z.string().min(1) });

export const sitOutSchema = z.object({
  tableId: z.string().min(1),
  sitOut: z.boolean(),
});

export const pokerActionSchema = z.object({
  tableId: z.string().min(1),
  /** Guards against an action arriving for a hand that has already moved on. */
  handId: z.string().min(1),
  action: actionTypeSchema,
  /** Required for bet/raise. The total the player is putting in on this street. */
  amount: chipStringSchema.optional(),
});
export type PokerActionInput = z.infer<typeof pokerActionSchema>;

/* ----------------------------- server -> client ---------------------------- */

/**
 * A seat as broadcast to the table. `holeCards` is only ever populated for the
 * socket that owns the seat, or for everyone at showdown once cards are turned
 * over - the server builds a per-viewer view, it never ships the full state.
 */
export interface PokerSeatView {
  seatNo: number;
  userId: string | null;
  username: string | null;
  stack: string;
  /** Chips committed on the current street. */
  committed: string;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  isDealer: boolean;
  isTurn: boolean;
  /** Present for the owning viewer, and at showdown for players still in. */
  holeCards: Card[] | null;
  /** Milliseconds left on this seat's action timer, when it is their turn. */
  timeLeftMs: number | null;
}

export interface PokerPotView {
  amount: string;
  /** Seat numbers eligible for this pot (side pots have fewer). */
  eligibleSeats: number[];
}

export interface PokerLegalAction {
  action: ActionType;
  /** Minimum total for bet/raise. */
  min?: string;
  /** Maximum total for bet/raise (the player's whole stack). */
  max?: string;
  /** Chips needed to call. */
  callAmount?: string;
}

export interface PokerTableView {
  tableId: string;
  handId: string | null;
  street: Street | null;
  board: Card[];
  pots: PokerPotView[];
  seats: PokerSeatView[];
  smallBlind: string;
  bigBlind: string;
  /** Legal actions for the viewing player, empty when it is not their turn. */
  legalActions: PokerLegalAction[];
  /** Seat the viewer occupies, or null if they are only watching. */
  yourSeat: number | null;
}

export interface PokerHandResultView {
  handId: string;
  board: Card[];
  winners: Array<{
    seatNo: number;
    username: string | null;
    amount: string;
    /** Absent when everyone else folded - no cards are shown in that case. */
    handName?: string;
    bestFive?: Card[];
  }>;
  /** Hole cards revealed at showdown, by seat. */
  revealed: Record<number, Card[]>;
}

/** Socket event names, shared so client and server cannot drift. */
export const POKER_EVENTS = {
  join: "poker:join",
  leave: "poker:leave",
  sitOut: "poker:sitOut",
  action: "poker:action",
  state: "poker:state",
  handResult: "poker:handResult",
  error: "poker:error",
} as const;

/** Wallet balance pushed over the socket so every tab stays in sync. */
export const WALLET_EVENTS = {
  balance: "wallet:balance",
} as const;
