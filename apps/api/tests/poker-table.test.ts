/**
 * The poker state machine.
 *
 * `table.ts` is pure - no database, no wallet, no sockets - so it can be driven directly here.
 * That is the point of keeping the wallet boundary in `poker.service.ts`: the rules of the game
 * are testable without standing anything up.
 *
 * The invariant every test checks is chip conservation: stacks plus committed chips plus the pot
 * must equal what was brought to the table. A state machine that creates or loses a chip is
 * broken no matter how right the betting looks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Street } from "@luck-cays/shared";
import {
  PokerTable,
  type CompletedHand,
  type TableConfig,
  type TableEvents,
} from "../src/modules/poker/table.js";

const CONFIG: TableConfig = {
  id: "table-under-test",
  name: "Test Table",
  maxSeats: 6,
  smallBlind: 10n,
  bigBlind: 20n,
  minBuyin: 400n,
  maxBuyin: 4_000n,
};

interface Recorded {
  actions: Array<{ userId: string; street: Street; action: string; amount: bigint }>;
  hands: CompletedHand[];
  stateChanges: number;
}

let recorded: Recorded;
let table: PokerTable;

function makeEvents(): TableEvents {
  return {
    onStateChanged: () => {
      recorded.stateChanges += 1;
    },
    onHandStarted: () => undefined,
    onAction: (_table, action) => {
      recorded.actions.push({
        userId: action.userId,
        street: action.street,
        action: action.action,
        amount: action.amount,
      });
    },
    onHandComplete: (_table, hand) => {
      recorded.hands.push(hand);
    },
  };
}

/** Total chips in play: every stack, plus everything committed, plus what the pot view reports. */
function chipsInPlay(t: PokerTable): bigint {
  const view = t.viewFor(null);
  const seated = t.seats.reduce((sum, seat) => sum + seat.stack, 0n);
  // The pot view already includes chips committed on the current street.
  return seated + BigInt(view.pots[0]?.amount ?? "0");
}

function seatThree(): void {
  table.sit(0, "alice", "alice", 1_000n);
  table.sit(1, "bob", "bob", 1_000n);
  table.sit(2, "carol", "carol", 1_000n);
}

/** Whose turn it is, as a user id. */
function turn(): string | null {
  const view = table.viewFor(null);
  const seat = view.seats.find((s) => s.isTurn);
  return seat?.userId ?? null;
}

function handId(): string {
  const id = table.viewFor(null).handId;
  if (!id) throw new Error("no hand in progress");
  return id;
}

function act(userId: string, action: Parameters<PokerTable["act"]>[2], amount?: bigint): void {
  table.act(userId, handId(), action, amount);
}

beforeEach(() => {
  recorded = { actions: [], hands: [], stateChanges: 0 };
  table = new PokerTable(CONFIG, makeEvents());
});

afterEach(() => {
  // Action timers are unref'd, but leaving them running across tests is still untidy.
  table.dispose();
});

describe("seating", () => {
  it("seats a player with the chips they brought", () => {
    const seat = table.sit(0, "alice", "alice", 1_000n);
    expect(seat.stack).toBe(1_000n);
    expect(table.occupiedSeats()).toHaveLength(1);
    expect(chipsInPlay(table)).toBe(1_000n);
  });

  it("refuses a taken seat", () => {
    table.sit(0, "alice", "alice", 1_000n);
    expect(() => table.sit(0, "bob", "bob", 1_000n)).toThrow(/taken/i);
  });

  it("refuses to seat the same player twice", () => {
    table.sit(0, "alice", "alice", 1_000n);
    expect(() => table.sit(1, "alice", "alice", 1_000n)).toThrow(/already/i);
  });

  it("returns the whole stack when a player stands up outside a hand", () => {
    table.sit(0, "alice", "alice", 1_000n);
    expect(table.stand("alice")).toEqual({ seatNo: 0, chips: 1_000n });
    expect(table.occupiedSeats()).toHaveLength(0);
  });

  it("will not start a hand with fewer than two funded players", () => {
    table.sit(0, "alice", "alice", 1_000n);
    expect(table.canStartHand()).toBe(false);
    expect(() => table.startHand("h1")).toThrow(/two funded/i);
  });

  it("ignores a player who is sitting out when deciding whether to deal", () => {
    table.sit(0, "alice", "alice", 1_000n);
    table.sit(1, "bob", "bob", 1_000n);
    table.setSittingOut("bob", true);
    expect(table.canStartHand()).toBe(false);
  });
});

describe("blinds", () => {
  it("posts the small blind on the button heads-up", () => {
    table.sit(0, "alice", "alice", 1_000n);
    table.sit(1, "bob", "bob", 1_000n);
    table.startHand("h1");

    const blinds = recorded.actions.filter((a) => a.action === "post_blind");
    expect(blinds).toHaveLength(2);
    expect(blinds.map((b) => b.amount).sort()).toEqual([10n, 20n]);

    // Heads-up, the button is the small blind and acts first preflop.
    const view = table.viewFor(null);
    const dealer = view.seats.find((s) => s.isDealer);
    expect(dealer?.isTurn).toBe(true);
  });

  it("posts blinds to the left of the button with three players", () => {
    seatThree();
    table.startHand("h1");

    const blinds = recorded.actions.filter((a) => a.action === "post_blind");
    expect(blinds).toHaveLength(2);

    // With three players, the button is not a blind and acts last preflop, so the player to
    // act first is neither blind.
    const view = table.viewFor(null);
    const dealerSeat = view.seats.find((s) => s.isDealer)?.seatNo;
    expect(view.seats.find((s) => s.isTurn)?.seatNo).toBe(dealerSeat);
  });

  it("puts the blinds in the pot", () => {
    seatThree();
    table.startHand("h1");
    expect(table.viewFor(null).pots[0]?.amount).toBe("30");
    expect(chipsInPlay(table)).toBe(3_000n);
  });

  it("deals two hole cards to each eligible player, visible only to their owner", () => {
    seatThree();
    table.startHand("h1");

    const alicesView = table.viewFor("alice");
    const alicesSeat = alicesView.seats.find((s) => s.userId === "alice");
    expect(alicesSeat?.holeCards).toHaveLength(2);

    // Everyone else's cards are withheld - this is the security boundary.
    for (const seat of alicesView.seats) {
      if (seat.userId !== "alice") expect(seat.holeCards).toBeNull();
    }

    // And an observer sees nobody's.
    for (const seat of table.viewFor(null).seats) {
      expect(seat.holeCards).toBeNull();
    }
  });
});

describe("legal actions", () => {
  beforeEach(() => {
    seatThree();
    table.startHand("h1");
  });

  it("offers fold, call and raise to a player facing the big blind", () => {
    const actor = turn() as string;
    const actions = table
      .viewFor(actor)
      .legalActions.map((a) => a.action)
      .sort();
    expect(actions).toContain("fold");
    expect(actions).toContain("call");
    expect(actions).toContain("raise");
    expect(actions).not.toContain("check");
  });

  it("offers nobody actions when it is not their turn", () => {
    const actor = turn() as string;
    const other = ["alice", "bob", "carol"].find((id) => id !== actor) as string;
    // `other` may be a blind who still has a turn coming, but not right now.
    expect(table.viewFor(other).legalActions).toHaveLength(0);
  });

  it("rejects an action from the wrong player", () => {
    const actor = turn() as string;
    const other = ["alice", "bob", "carol"].find((id) => id !== actor) as string;
    expect(() => act(other, "fold")).toThrow(/not your turn/i);
  });

  it("rejects an action for a hand that has already finished", () => {
    const actor = turn() as string;
    expect(() => table.act(actor, "some-other-hand", "fold")).toThrow(/already finished/i);
  });

  it("rejects a raise below the minimum", () => {
    const actor = turn() as string;
    const raise = table.viewFor(actor).legalActions.find((a) => a.action === "raise");
    const belowMinimum = BigInt(raise?.min ?? "0") - 1n;
    expect(() => act(actor, "raise", belowMinimum)).toThrow(/between/i);
  });

  it("rejects a raise above the stack", () => {
    const actor = turn() as string;
    const raise = table.viewFor(actor).legalActions.find((a) => a.action === "raise");
    const aboveStack = BigInt(raise?.max ?? "0") + 1n;
    expect(() => act(actor, "raise", aboveStack)).toThrow(/between/i);
  });

  it("rejects a check when there is a bet to call", () => {
    const actor = turn() as string;
    expect(() => act(actor, "check")).toThrow(/cannot check/i);
  });
});

describe("a hand won on folds", () => {
  it("awards the whole pot without revealing any cards", () => {
    table.sit(0, "alice", "alice", 1_000n);
    table.sit(1, "bob", "bob", 1_000n);
    table.startHand("h1");

    const actor = turn() as string;
    act(actor, "fold");

    expect(recorded.hands).toHaveLength(1);
    const hand = recorded.hands[0] as CompletedHand;

    // 30 in blinds, all of it to the player who did not fold.
    expect(hand.pot).toBe(30n);
    expect(hand.winners).toHaveLength(1);
    expect(hand.winners[0]?.amount).toBe(30n);
    // No showdown, so no cards are shown - revealing them would leak information for free.
    expect(hand.revealed).toEqual({});
    expect(hand.winners[0]?.ranking).toBeUndefined();

    // 2,000 brought to the table, 2,000 still there.
    expect(chipsInPlay(table)).toBe(2_000n);
  });

  it("gives the pot to the last player standing when everyone else folds", () => {
    seatThree();
    table.startHand("h1");

    act(turn() as string, "fold");
    act(turn() as string, "fold");

    expect(recorded.hands).toHaveLength(1);
    expect(recorded.hands[0]?.winners).toHaveLength(1);
    expect(chipsInPlay(table)).toBe(3_000n);
  });
});

describe("betting rounds", () => {
  it("runs the hand through every street to a showdown", () => {
    table.sit(0, "alice", "alice", 1_000n);
    table.sit(1, "bob", "bob", 1_000n);
    table.startHand("h1");

    const streets: Array<Street | null> = [];
    let guard = 0;

    // Everyone calls or checks, so the hand runs the whole way out.
    while (table.handInProgress && guard++ < 40) {
      const actor = turn();
      if (!actor) break;

      streets.push(table.viewFor(null).street);
      const actions = table.viewFor(actor).legalActions.map((a) => a.action);
      act(actor, actions.includes("check") ? "check" : "call");
    }

    expect(recorded.hands).toHaveLength(1);
    expect(streets).toContain("preflop");
    expect(streets).toContain("flop");
    expect(streets).toContain("turn");
    expect(streets).toContain("river");

    const hand = recorded.hands[0] as CompletedHand;
    expect(hand.board).toHaveLength(5);
    // A showdown means cards are revealed and the winner's hand is named.
    expect(Object.keys(hand.revealed).length).toBeGreaterThanOrEqual(2);
    expect(hand.winners[0]?.ranking?.name).toBeTruthy();

    expect(chipsInPlay(table)).toBe(2_000n);
  });

  it("deals three cards on the flop and one on each later street", () => {
    table.sit(0, "alice", "alice", 1_000n);
    table.sit(1, "bob", "bob", 1_000n);
    table.startHand("h1");

    const boardSizes = new Set<number>();
    let guard = 0;

    while (table.handInProgress && guard++ < 40) {
      const actor = turn();
      if (!actor) break;
      const actions = table.viewFor(actor).legalActions.map((a) => a.action);
      act(actor, actions.includes("check") ? "check" : "call");
      boardSizes.add(table.viewFor(null).board.length);
    }

    // 0 preflop, then 3, 4 and 5.
    expect([...boardSizes].sort((a, b) => a - b)).toEqual(expect.arrayContaining([3, 4, 5]));
  });

  it("reopens the action when someone raises", () => {
    seatThree();
    table.startHand("h1");

    const first = turn() as string;
    const raise = table.viewFor(first).legalActions.find((a) => a.action === "raise");
    act(first, "raise", BigInt(raise?.min ?? "40"));

    // The raiser does not act again until someone re-raises, but both others must respond.
    const responders = new Set<string>();
    let guard = 0;
    while (table.handInProgress && table.viewFor(null).street === "preflop" && guard++ < 10) {
      const actor = turn();
      if (!actor) break;
      responders.add(actor);
      act(actor, "call");
    }

    expect(responders.size).toBe(2);
    expect(responders.has(first)).toBe(false);
  });
});

describe("all-in and side pots", () => {
  it("builds a side pot the short stack cannot win from", () => {
    // Alice is short, so she can only win what she matched.
    table.sit(0, "alice", "alice", 100n);
    table.sit(1, "bob", "bob", 1_000n);
    table.sit(2, "carol", "carol", 1_000n);
    table.startHand("h1");

    const brought = 2_100n;
    let guard = 0;

    // Everyone commits everything they can.
    while (table.handInProgress && guard++ < 40) {
      const actor = turn();
      if (!actor) break;
      const actions = table.viewFor(actor).legalActions.map((a) => a.action);
      if (actions.includes("allin")) act(actor, "allin");
      else if (actions.includes("call")) act(actor, "call");
      else if (actions.includes("check")) act(actor, "check");
      else break;
    }

    expect(recorded.hands).toHaveLength(1);
    const hand = recorded.hands[0] as CompletedHand;

    // Alice's share of any pot is capped at 3 x 100, so she can never win all 2,100.
    const aliceWin = hand.winners.find((w) => w.seatNo === 0)?.amount ?? 0n;
    expect(aliceWin).toBeLessThanOrEqual(300n);

    // Nothing created, nothing lost.
    expect(chipsInPlay(table)).toBe(brought);
    const paid = hand.winners.reduce((sum, w) => sum + w.amount, 0n);
    expect(paid).toBe(hand.pot);
  });

  it("conserves chips exactly across a long sequence of hands", () => {
    seatThree();
    const brought = 3_000n;

    for (let round = 0; round < 15 && table.canStartHand(); round++) {
      table.startHand(`h${round}`);

      let guard = 0;
      while (table.handInProgress && guard++ < 60) {
        const actor = turn();
        if (!actor) break;

        const actions = table.viewFor(actor).legalActions.map((a) => a.action);
        // A mix of lines, so the sequence exercises folds, calls and raises.
        if (guard % 7 === 0 && actions.includes("raise")) {
          const raise = table.viewFor(actor).legalActions.find((a) => a.action === "raise");
          act(actor, "raise", BigInt(raise?.min ?? "40"));
        } else if (guard % 11 === 0 && actions.includes("fold")) {
          act(actor, "fold");
        } else if (actions.includes("check")) {
          act(actor, "check");
        } else if (actions.includes("call")) {
          act(actor, "call");
        } else {
          act(actor, "fold");
        }
      }

      expect(chipsInPlay(table), `after hand ${round}`).toBe(brought);
    }

    expect(recorded.hands.length).toBeGreaterThan(5);
    expect(chipsInPlay(table)).toBe(brought);
  });
});

describe("leaving mid-hand", () => {
  it("folds the seat and leaves committed chips in the pot", () => {
    seatThree();
    table.startHand("h1");

    const potBefore = BigInt(table.viewFor(null).pots[0]?.amount ?? "0");
    const actor = turn() as string;

    // The actor has committed nothing yet beyond a blind, if they are a blind.
    const committed = BigInt(
      table.viewFor(null).seats.find((s) => s.userId === actor)?.committed ?? "0",
    );

    const result = table.stand(actor);
    expect(result).not.toBeNull();

    // Whatever they had already put in stays with the pot.
    const potAfter = BigInt(table.viewFor(null).pots[0]?.amount ?? "0");
    expect(potAfter + (result?.chips ?? 0n)).toBe(potBefore + (result?.chips ?? 0n));
    expect(committed).toBeGreaterThanOrEqual(0n);
  });
});

describe("disconnects", () => {
  it("marks a seat dropped without vacating it", () => {
    seatThree();
    table.startHand("h1");

    table.markDisconnected("alice");
    // The seat is still theirs - vacating it would forfeit chips in a live pot.
    expect(table.seatOf("alice")).not.toBeNull();
    expect(table.expiredDisconnects(Date.now() + 60_000).map((s) => s.userId)).toContain("alice");

    table.markReconnected("alice");
    expect(table.expiredDisconnects(Date.now() + 60_000)).toHaveLength(0);
  });
});
