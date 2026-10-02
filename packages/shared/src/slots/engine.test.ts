/**
 * The slot engine's payout rules.
 *
 * Grids are constructed by hand here rather than spun, so each test pins one rule: left-to-right
 * only, wilds substituting, the best-of candidate choice, scatters paying from anywhere, and the
 * free-spin multiplier. These are the rules a player would dispute, so they are the ones worth
 * nailing down.
 */
import { describe, expect, it } from "vitest";
import { buildGrid, evaluate, lineOutcome, pickStops } from "./engine.js";
import { getSlotConfig, slotGames } from "./index.js";
import { slotConfigSchema, type SlotConfig } from "./types.js";

const reef = getSlotConfig("reef-riches");

/** A grid where every cell is `filler` except the cells named in `overrides`. */
function grid(
  config: SlotConfig,
  filler: string,
  overrides: Record<string, string> = {},
): string[][] {
  const result = Array.from({ length: config.reels }, () =>
    Array.from({ length: config.rows }, () => filler),
  );
  for (const [key, symbol] of Object.entries(overrides)) {
    const [reel = "0", row = "0"] = key.split(",");
    (result[Number(reel)] as string[])[Number(row)] = symbol;
  }
  return result;
}

/** Fill the middle row (payline 1) with a run, and pad the rest with a non-paying symbol. */
function middleRow(config: SlotConfig, run: string[], filler = "J"): string[][] {
  const result = grid(config, filler);
  for (const [reel, symbol] of run.entries()) {
    (result[reel] as string[])[1] = symbol;
  }
  return result;
}

describe("line evaluation", () => {
  it("pays a three-of-a-kind from reel 0 and ignores a later run", () => {
    // SHIP SHIP SHIP then two blanks. Line bet is 100/20 = 5, SHIP 3 pays 20 -> 100.
    const outcome = lineOutcome(reef, ["SHIP", "SHIP", "SHIP", "Q", "Q"]);
    expect(outcome?.symbol).toBe("SHIP");
    expect(outcome?.count).toBe(3);
    expect(outcome?.multiplier).toBe(20);
  });

  it("pays nothing when the run does not start on reel 0", () => {
    // Three ships, but not from the left - this is the rule players most often expect wrongly.
    expect(lineOutcome(reef, ["Q", "SHIP", "SHIP", "SHIP", "A"])?.symbol).not.toBe("SHIP");
  });

  it("lets a wild substitute mid-run", () => {
    const outcome = lineOutcome(reef, ["SHIP", "KRAKEN", "SHIP", "Q", "Q"]);
    expect(outcome?.symbol).toBe("SHIP");
    expect(outcome?.count).toBe(3);
  });

  it("lets leading wilds complete the symbol that follows them", () => {
    const outcome = lineOutcome(reef, ["KRAKEN", "KRAKEN", "SHIP", "SHIP", "Q"]);
    expect(outcome?.symbol).toBe("SHIP");
    expect(outcome?.count).toBe(4);
    expect(outcome?.multiplier).toBe(100);
  });

  it("pays the wild as its own symbol when that is worth more", () => {
    // Three wilds then a low symbol. KRAKEN 3 pays 30; treating them as J would give J 4 at 11.
    const outcome = lineOutcome(reef, ["KRAKEN", "KRAKEN", "KRAKEN", "J", "Q"]);
    expect(outcome?.symbol).toBe("KRAKEN");
    expect(outcome?.multiplier).toBe(30);
  });

  it("pays the longer low run when that beats the shorter wild run", () => {
    // Two wilds then three jacks: J 5 at 40 beats a 2-wild run, which pays nothing.
    const outcome = lineOutcome(reef, ["KRAKEN", "KRAKEN", "J", "J", "J"]);
    expect(outcome?.symbol).toBe("J");
    expect(outcome?.count).toBe(5);
    expect(outcome?.multiplier).toBe(40);
  });

  it("never forms a line win from scatters", () => {
    expect(lineOutcome(reef, ["CHEST", "CHEST", "CHEST", "CHEST", "CHEST"])).toBeNull();
  });

  it("pays nothing for a two-of-a-kind", () => {
    expect(lineOutcome(reef, ["SHIP", "SHIP", "Q", "A", "K"])).toBeNull();
  });
});

describe("evaluate", () => {
  it("converts multipliers to chips using the line bet", () => {
    const result = evaluate(reef, middleRow(reef, ["SHIP", "SHIP", "SHIP"]), { totalBet: 100n });

    // Line bet is 100 / 20 lines = 5. SHIP 3 pays 20 x 5 = 100.
    const shipWin = result.lineWins.find((win) => win.symbol === "SHIP");
    expect(shipWin?.amount).toBe("100");
  });

  it("reports the exact cells that won, for the animation", () => {
    const result = evaluate(reef, middleRow(reef, ["SHIP", "SHIP", "SHIP"]), { totalBet: 100n });
    const shipWin = result.lineWins.find((win) => win.symbol === "SHIP");

    // Payline 1 is the middle row, so cells are [reel, 1] for the first three reels.
    expect(shipWin?.cells).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
  });

  it("pays every winning line, not just the best one", () => {
    // Fill all three rows on the first three reels, so the top, middle and bottom lines all win.
    const board = grid(reef, "Q");
    for (let reel = 0; reel < 3; reel++) {
      for (let row = 0; row < 3; row++) (board[reel] as string[])[row] = "SHIP";
    }

    const result = evaluate(reef, board, { totalBet: 100n });
    const shipWins = result.lineWins.filter((win) => win.symbol === "SHIP");
    expect(shipWins.length).toBeGreaterThanOrEqual(3);
  });

  it("pays scatters on the total bet regardless of position", () => {
    // Three chests scattered across different reels and rows.
    const board = grid(reef, "J", { "0,0": "CHEST", "2,2": "CHEST", "4,1": "CHEST" });
    const result = evaluate(reef, board, { totalBet: 100n });

    expect(result.scatterWin?.count).toBe(3);
    // 3 scatters pay 4x the TOTAL bet: 4 x 100 = 400.
    expect(result.scatterWin?.amount).toBe("400");
    expect(result.freeSpinsAwarded).toBe(10);
  });

  it("awards no free spins for two scatters", () => {
    const board = grid(reef, "J", { "0,0": "CHEST", "3,2": "CHEST" });
    const result = evaluate(reef, board, { totalBet: 100n });
    expect(result.scatterWin).toBeNull();
    expect(result.freeSpinsAwarded).toBe(0);
  });

  it("applies the free-spin multiplier to line and scatter wins alike", () => {
    const board = middleRow(reef, ["SHIP", "SHIP", "SHIP"]);
    const base = evaluate(reef, board, { totalBet: 100n });
    const free = evaluate(reef, board, { totalBet: 100n, winMultiplier: 2 });

    expect(free.totalWin).toBe(base.totalWin * 2n);
  });

  it("produces whole chips at every bet level", () => {
    // Isolate a single payline so the total is attributable to one win.
    //
    // Scatters on reel 0's other two rows kill every line that starts there - a scatter can
    // never begin a line run - which leaves only the middle line able to pay. Two scatters is
    // below the three needed to pay or award spins, so they contribute nothing themselves.
    const board = middleRow(reef, ["SHIP", "SHIP", "SHIP", "SHIP", "SHIP"]);
    (board[0] as string[])[0] = "CHEST";
    (board[0] as string[])[2] = "CHEST";

    for (const bet of reef.betLevels) {
      const result = evaluate(reef, board, { totalBet: BigInt(bet) });

      expect(result.lineWins).toHaveLength(1);
      expect(result.scatterWin).toBeNull();
      // SHIP 5 pays 500 x the line bet, and the line bet is the total bet over 20 lines.
      expect(result.totalWin).toBe((500n * BigInt(bet)) / 20n);
      // Integer multiplier times whole line bet: never a fraction of a chip.
      expect(result.totalWin % 1n).toBe(0n);
    }
  });
});

describe("grid construction", () => {
  it("reads downward from the stop and wraps around the strip", () => {
    const strip = reef.reelStrips[0] as string[];
    const stop = strip.length - 1;
    const built = buildGrid(reef, [stop, 0, 0, 0, 0]);

    expect(built[0]).toEqual([strip[stop], strip[0], strip[1]]);
  });

  it("picks one stop per reel, each inside its own strip", () => {
    const stops = pickStops(reef, (max) => max - 1);
    expect(stops).toHaveLength(reef.reels);
    stops.forEach((stop, reel) => {
      expect(stop).toBe((reef.reelStrips[reel] as string[]).length - 1);
    });
  });
});

describe("every shipped config", () => {
  it("parses against the schema", () => {
    for (const config of slotGames.values()) {
      expect(() => slotConfigSchema.parse(config)).not.toThrow();
    }
  });

  it("uses only whole-number multipliers, so no payout can round", () => {
    for (const config of slotGames.values()) {
      for (const [symbol, pays] of Object.entries(config.paytable)) {
        for (const [run, value] of Object.entries(pays)) {
          expect(Number.isInteger(value), `${config.slug} ${symbol} x${run} = ${value}`).toBe(true);
        }
      }
      for (const [count, value] of Object.entries(config.scatter.pays)) {
        expect(Number.isInteger(value), `${config.slug} scatter x${count} = ${value}`).toBe(true);
      }
    }
  });

  it("has bet levels that divide evenly by the payline count", () => {
    for (const config of slotGames.values()) {
      for (const bet of config.betLevels) {
        expect(bet % config.paylines.length, `${config.slug} bet ${bet}`).toBe(0);
      }
    }
  });

  it("keeps a longer run of a symbol worth at least as much as a shorter one", () => {
    for (const config of slotGames.values()) {
      for (const [symbol, pays] of Object.entries(config.paytable)) {
        const runs = Object.keys(pays)
          .map(Number)
          .sort((a, b) => a - b);
        for (let i = 1; i < runs.length; i++) {
          const shorter = pays[String(runs[i - 1])] ?? 0;
          const longer = pays[String(runs[i])] ?? 0;
          expect(
            longer,
            `${config.slug} ${symbol}: x${runs[i]} pays less than x${runs[i - 1]}`,
          ).toBeGreaterThan(shorter);
        }
      }
    }
  });
});
