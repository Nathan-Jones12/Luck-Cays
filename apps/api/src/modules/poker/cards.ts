/**
 * Cards and the shuffle.
 *
 * Notation is rank + suit: "As", "Td", "7c", "2h". Ten is "T", so every card is exactly
 * two characters and the hand evaluator takes them unchanged.
 */
import { secureShuffle } from "../../lib/crypto.js";
import type { Card } from "@luck-cays/shared";

export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
export const SUITS = ["c", "d", "h", "s"] as const;

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) deck.push(`${rank}${suit}`);
  }
  return deck;
}

/**
 * A freshly shuffled deck.
 *
 * Fisher-Yates over `crypto.randomInt` - see `lib/crypto.ts`. Never `Math.random`: it is
 * seeded predictably, and a predictable deck is a solved game.
 *
 * The deck is only ever held server-side. Nothing sends an unrevealed card to a client.
 */
export function shuffledDeck(): Card[] {
  return secureShuffle(fullDeck());
}

/** A dealer that hands out cards from the top and cannot be rewound. */
export class Dealer {
  private index = 0;

  constructor(private readonly deck: Card[] = shuffledDeck()) {}

  deal(count: number): Card[] {
    if (this.index + count > this.deck.length) {
      throw new Error("deck exhausted - a hand dealt more cards than exist");
    }
    const cards = this.deck.slice(this.index, this.index + count);
    this.index += count;
    return cards;
  }

  /**
   * Burn a card, as a live dealer would before each street. It changes nothing
   * statistically with a shuffled deck, but it keeps the dealt sequence recognisable to
   * anyone auditing a hand against a real table's procedure.
   */
  burn(): void {
    this.deal(1);
  }

  get remaining(): number {
    return this.deck.length - this.index;
  }
}

export function cardsToString(cards: Card[]): string {
  return cards.join(" ");
}

export function cardsFromString(value: string): Card[] {
  return value.length === 0 ? [] : (value.split(" ") as Card[]);
}
