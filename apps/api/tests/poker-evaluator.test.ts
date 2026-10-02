/**
 * Hand evaluation edge cases.
 *
 * Tested against our wrapper rather than the library directly, so the guarantees survive a
 * library swap. These are the cases that actually go wrong in hand evaluators and that cost a
 * player a pot when they do: wheel straights, counterfeited two pair, board-only hands, split
 * pots, and kickers deciding between identical pairs.
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@luck-cays/shared";
import { compareHands, rankHand, showdown } from "../src/modules/poker/evaluator.js";
import { Dealer, fullDeck, shuffledDeck } from "../src/modules/poker/cards.js";

const cards = (value: string): Card[] => value.split(" ") as Card[];

describe("hand ranking", () => {
  it("finds a full house from seven cards", () => {
    const ranking = rankHand(cards("Ad As"), cards("Ah Kd Kc 2s 7h"));
    expect(ranking.name).toBe("Full House");
    expect(ranking.bestFive).toHaveLength(5);
  });

  it("recognises a wheel straight, where the ace plays low", () => {
    // A-2-3-4-5. An evaluator that only treats the ace as high misses this entirely.
    const ranking = rankHand(cards("Ad 2c"), cards("3h 4s 5d Kc Qh"));
    expect(ranking.name).toBe("Straight");
  });

  it("recognises a wheel straight flush", () => {
    const ranking = rankHand(cards("As 2s"), cards("3s 4s 5s Kc Qh"));
    expect(ranking.name).toBe("Straight Flush");
  });

  it("prefers a flush over a lower straight on the same board", () => {
    const flush = rankHand(cards("Ah 9h"), cards("2h 7h Kh 4s 5d"));
    expect(flush.name).toBe("Flush");
  });

  it("plays the board when the hole cards add nothing", () => {
    const ranking = rankHand(cards("2c 3d"), cards("As Ks Qs Js Ts"));
    // The board alone is the best five cards available.
    expect(ranking.name).toBe("Straight Flush");
  });
});

describe("comparing hands", () => {
  it("decides between two pairs on the kicker", () => {
    const board = cards("Kd 7c 4s 2h 9d");
    // Both make a pair of kings; the second card decides it.
    expect(compareHands(cards("Ks Ah"), cards("Kh Qc"), board)).toBeGreaterThan(0);
  });

  it("treats genuinely identical hands as a tie", () => {
    const board = cards("Kd Kh 7c 4s 2d");
    // Both play the board's trip-free two pair with the same kickers from the board.
    expect(compareHands(cards("9s 8h"), cards("9h 8s"), board)).toBe(0);
  });

  it("ranks a counterfeited two pair below the hand that improved", () => {
    // Board pairs the higher card, so holding 3-2 no longer plays two pair usefully.
    const board = cards("8d 8h 5c 5s Ah");
    expect(compareHands(cards("Ad Kc"), cards("3d 2c"), board)).toBeGreaterThan(0);
  });

  it("ranks four of a kind above a full house", () => {
    const board = cards("9d 9h 9c 4s 4d");
    expect(compareHands(cards("9s 2h"), cards("4h Ac"), board)).toBeGreaterThan(0);
  });
});

describe("showdown", () => {
  it("returns a single winner when one hand is best", () => {
    const result = showdown(
      [
        { seatNo: 0, holeCards: cards("Ad Ah") },
        { seatNo: 1, holeCards: cards("Kd Kh") },
      ],
      cards("2c 7d 9s Jh 3c"),
    );

    expect(result.winners).toHaveLength(1);
    expect(result.winners[0]?.seatNo).toBe(0);
    expect(result.ranked).toHaveLength(2);
  });

  it("returns every tied seat so a split pot is not silently awarded to one", () => {
    // Identical hands by rank: both play the same straight off the board.
    const result = showdown(
      [
        { seatNo: 0, holeCards: cards("Ad Kh") },
        { seatNo: 2, holeCards: cards("As Kc") },
      ],
      cards("Qd Jh Ts 3c 2d"),
    );

    expect(result.winners).toHaveLength(2);
    expect(result.winners.map((winner) => winner.seatNo).sort()).toEqual([0, 2]);
  });

  it("names the winning hand, for the hand history", () => {
    const result = showdown([{ seatNo: 1, holeCards: cards("Ad As") }], cards("Ah Kd Kc 2s 7h"));
    expect(result.winners[0]?.ranking.name).toBe("Full House");
    expect(result.winners[0]?.ranking.description).toContain("Full House");
  });
});

describe("the deck", () => {
  it("has 52 distinct cards", () => {
    const deck = fullDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
  });

  it("shuffles to a permutation, never losing or duplicating a card", () => {
    for (let round = 0; round < 50; round++) {
      const deck = shuffledDeck();
      expect(deck).toHaveLength(52);
      expect(new Set(deck).size).toBe(52);
    }
  });

  it("does not return the deck in order", () => {
    // One shuffle landing in order is astronomically unlikely; several is a broken shuffle.
    const ordered = fullDeck().join(" ");
    const shuffles = Array.from({ length: 5 }, () => shuffledDeck().join(" "));
    expect(shuffles.every((deck) => deck === ordered)).toBe(false);
  });

  it("produces a roughly uniform distribution of first cards", () => {
    // A biased Fisher-Yates (the common "swap with any index" bug) skews this noticeably.
    const counts = new Map<string, number>();
    const draws = 52 * 400;

    for (let i = 0; i < draws; i++) {
      const first = shuffledDeck()[0] as string;
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }

    expect(counts.size).toBe(52);

    const expected = draws / 52;
    for (const [card, count] of counts) {
      // Generous bounds: this is checking for gross bias, not testing the CSPRNG itself.
      expect(count, `${card} appeared ${count} times, expected around ${expected}`).toBeGreaterThan(
        expected * 0.6,
      );
      expect(count).toBeLessThan(expected * 1.4);
    }
  });

  it("deals without ever repeating a card, and burns between streets", () => {
    const dealer = new Dealer();

    const holes = [dealer.deal(2), dealer.deal(2), dealer.deal(2)];
    dealer.burn();
    const flop = dealer.deal(3);
    dealer.burn();
    const turn = dealer.deal(1);
    dealer.burn();
    const river = dealer.deal(1);

    const dealt = [...holes.flat(), ...flop, ...turn, ...river];
    expect(new Set(dealt).size).toBe(dealt.length);
    // 6 hole + 5 board + 3 burned = 14 gone from 52.
    expect(dealer.remaining).toBe(52 - 14);
  });

  it("throws rather than dealing past the end of the deck", () => {
    const dealer = new Dealer();
    dealer.deal(52);
    expect(() => dealer.deal(1)).toThrow(/exhausted/);
  });
});
