/**
 * Hand evaluation, wrapping `pokersolver`.
 *
 * The PRD asks for a tested evaluator library rather than a hand-rolled one, and rightly:
 * a seven-card evaluator has a long tail of edge cases (wheel straights, counterfeited
 * two pair, split pots with different kickers) and getting one wrong means paying the
 * wrong player.
 *
 * This file is the only place the library is touched, so it can be swapped without
 * reaching into the state machine. `tests/poker-evaluator.test.ts` covers the edge cases
 * against this wrapper, not against the library directly - so the tests keep holding if
 * the library changes.
 */
import pokersolver from "pokersolver";
import type { SolvedHand } from "pokersolver";
import type { Card } from "@luck-cays/shared";

// Destructured at module load: pokersolver is CommonJS, so `import { Hand } from
// "pokersolver"` typechecks and then fails at runtime - Node's ESM loader cannot see a
// CommonJS module's named exports statically.
const { Hand } = pokersolver;

export interface HandRanking {
  /** Category name, e.g. "Full House". */
  name: string;
  /** Longer description, e.g. "Full House, A's over K's". */
  description: string;
  /** The five cards that make the hand. */
  bestFive: Card[];
}

export interface RankedSeat {
  seatNo: number;
  holeCards: Card[];
  ranking: HandRanking;
}

function toRanking(hand: SolvedHand): HandRanking {
  return {
    name: hand.name,
    description: hand.descr,
    bestFive: hand.cards.map((card) => card.toString() as Card),
  };
}

/** Best five-card hand from hole cards plus the board. */
export function rankHand(holeCards: Card[], board: Card[]): HandRanking {
  const cards = [...holeCards, ...board];
  if (cards.length < 5) {
    throw new Error(`need at least 5 cards to rank a hand, got ${cards.length}`);
  }
  return toRanking(Hand.solve(cards));
}

export interface ShowdownResult {
  /** Seats that tie for best hand. More than one means the pot is split. */
  winners: RankedSeat[];
  /** Every contesting seat, ranked, for the hand history. */
  ranked: RankedSeat[];
}

/**
 * Decide a showdown between the seats still in the hand.
 *
 * Returns every tied seat, because split pots are normal and picking one arbitrarily would
 * quietly rob the others.
 */
export function showdown(
  contenders: Array<{ seatNo: number; holeCards: Card[] }>,
  board: Card[],
): ShowdownResult {
  if (contenders.length === 0) throw new Error("showdown with no contenders");

  const solved = contenders.map((contender) => ({
    seatNo: contender.seatNo,
    holeCards: contender.holeCards,
    hand: Hand.solve([...contender.holeCards, ...board]),
  }));

  const winningHands = Hand.winners(solved.map((entry) => entry.hand));

  // `winners` returns hand objects; match them back to seats by identity so two seats
  // holding an identically-ranked hand are both found.
  const winners = solved
    .filter((entry) => winningHands.includes(entry.hand))
    .map((entry) => ({
      seatNo: entry.seatNo,
      holeCards: entry.holeCards,
      ranking: toRanking(entry.hand),
    }));

  return {
    winners,
    ranked: solved.map((entry) => ({
      seatNo: entry.seatNo,
      holeCards: entry.holeCards,
      ranking: toRanking(entry.hand),
    })),
  };
}

/**
 * Compare two hands. Negative when `a` loses, positive when `a` wins, zero on a tie.
 * Exposed for tests; the state machine uses `showdown`.
 */
export function compareHands(a: Card[], b: Card[], board: Card[]): number {
  const handA = Hand.solve([...a, ...board]);
  const handB = Hand.solve([...b, ...board]);
  const winners = Hand.winners([handA, handB]);

  const aWins = winners.includes(handA);
  const bWins = winners.includes(handB);
  if (aWins && bWins) return 0;
  return aWins ? 1 : -1;
}
