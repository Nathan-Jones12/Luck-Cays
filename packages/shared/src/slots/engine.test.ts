/**
 * The slot engine's payout rules.
 *
 * Grids are constructed by hand here rather than spun, so each test pins one rule: left-to-right
 * only, wilds substituting, the best-of candidate choice, scatters paying from anywhere, and the
 * free-spin multiplier. These are the rules a player would dispute, so they are the ones worth
 * nailing down.
 */
import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGrid,
  evaluate,
  lineOutcome,
  pickStops,
  reelModel,
  scatterTier,
  spinGrid,
  type RandomInt,
} from "./engine.js";
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
    const strip = (reef.reelStrips as string[][])[0] as string[];
    const stop = strip.length - 1;
    const built = buildGrid(reef, [stop, 0, 0, 0, 0]);

    expect(built[0]).toEqual([strip[stop], strip[0], strip[1]]);
  });

  it("picks one stop per reel, each inside its own strip", () => {
    const stops = pickStops(reef, (max) => max - 1);
    expect(stops).toHaveLength(reef.reels);
    stops.forEach((stop, reel) => {
      expect(stop).toBe(((reef.reelStrips as string[][])[reel] as string[]).length - 1);
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

/* -------------------------------------------------------------------------- */
/* Weighted reels and the coin feature                                        */
/* -------------------------------------------------------------------------- */

const harbour = getSlotConfig("wild-harbour");

/** Deterministic RNG for the shape tests: always the lowest value in range. */
const alwaysFirst: RandomInt = () => 0;

/** A grid filled with one symbol, for building a case by hand. */
function gridOf(config: SlotConfig, filler: string): string[][] {
  return Array.from({ length: config.reels }, () =>
    Array.from({ length: config.rows }, () => filler),
  );
}

/** A coin-value matrix with no coins on it. */
function emptyValues(config: SlotConfig): Array<Array<number | null>> {
  return Array.from({ length: config.reels }, () =>
    Array.from({ length: config.rows }, () => null),
  );
}

describe("the weighted reel model", () => {
  it("is the model this game declares", () => {
    expect(reelModel(harbour)).toBe("weighted");
    expect(harbour.reelWeights).toBeDefined();
    expect(harbour.reelStrips).toBeUndefined();
  });

  it("has no stops to report, and says so rather than inventing them", () => {
    expect(() => pickStops(harbour, alwaysFirst)).toThrow(/weighted/i);
    expect(() => buildGrid(harbour, [0, 0, 0, 0, 0])).toThrow(/weighted/i);
  });

  it("spins a full grid of the declared shape", () => {
    const spun = spinGrid(harbour, randomInt);
    expect(spun.grid).toHaveLength(harbour.reels);
    for (const column of spun.grid) expect(column).toHaveLength(harbour.rows);
    // No strip, so no stop indices.
    expect(spun.stops).toEqual([]);
  });

  it("never lands a zero-weight symbol on the reel that excludes it", () => {
    // Reel 1 carries no wild, which is how the original keeps five-wild lines rare. One wild
    // appearing there would change the top-line probability materially.
    for (let i = 0; i < 3_000; i++) {
      const { grid } = spinGrid(harbour, randomInt);
      expect(grid[0]).not.toContain(harbour.wild.symbol);
    }
  });

  it("draws every cell independently, so one reel can repeat a symbol", () => {
    // The defining difference from strips. Over this many spins a repeat is near certain.
    let sawRepeat = false;
    for (let i = 0; i < 2_000 && !sawRepeat; i++) {
      for (const column of spinGrid(harbour, randomInt).grid) {
        if (new Set(column).size < column.length) sawRepeat = true;
      }
    }
    expect(sawRepeat).toBe(true);
  });

  it("lands symbols in roughly their declared proportions", () => {
    // A sanity check on the weighting, not a test of the CSPRNG, so the bounds are loose.
    const counts = new Map<string, number>();
    const spins = 4_000;

    for (let i = 0; i < spins; i++) {
      // Reel 1 only, so there is a single weight table to compare against.
      const column = spinGrid(harbour, randomInt).grid[1] as string[];
      for (const symbol of column) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }

    const weights = (harbour.reelWeights as Array<Record<string, number>>)[1] as Record<
      string,
      number
    >;
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    const cells = spins * harbour.rows;

    for (const [symbol, weight] of Object.entries(weights)) {
      if (weight === 0) continue;
      const expected = (weight / totalWeight) * cells;
      const seen = counts.get(symbol) ?? 0;
      expect(
        seen,
        `${symbol} seen ${seen}, expected around ${expected.toFixed(0)}`,
      ).toBeGreaterThan(expected * 0.7);
      expect(seen).toBeLessThan(expected * 1.3);
    }
  });
});

describe("the coin feature", () => {
  const coin = harbour.coin as NonNullable<SlotConfig["coin"]>;

  it("gives a value to every coin and to nothing else", () => {
    for (let i = 0; i < 400; i++) {
      const { grid, coinValues } = spinGrid(harbour, randomInt);
      expect(coinValues).not.toBeNull();
      const values = coinValues as Array<Array<number | null>>;

      for (const [reel, column] of grid.entries()) {
        for (const [row, symbol] of column.entries()) {
          const value = values[reel]?.[row];
          if (symbol === coin.symbol) {
            expect(typeof value, `coin at ${reel},${row} needs a value`).toBe("number");
            expect(coin.values.some((entry) => entry.value === value)).toBe(true);
          } else {
            expect(value, `non-coin at ${reel},${row} must have no value`).toBeNull();
          }
        }
      }
    }
  });

  it("pays nothing below the threshold, however valuable the coins are", () => {
    // Four coins at the maximum value. One short, so they are decoration.
    const grid = gridOf(harbour, "H");
    const values = emptyValues(harbour);
    for (const reel of [0, 1, 2, 3]) {
      (grid[reel] as string[])[0] = coin.symbol;
      (values[reel] as Array<number | null>)[0] = 100;
    }

    const result = evaluate(harbour, grid, { totalBet: 100n, coinValues: values });
    expect(result.coinWin).toBeNull();
  });

  it("pays the summed value times the total bet once the threshold is met", () => {
    const grid = gridOf(harbour, "H");
    const values = emptyValues(harbour);
    const placed: Array<[number, number]> = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 5],
      [4, 10],
    ];
    for (const [reel, value] of placed) {
      (grid[reel] as string[])[0] = coin.symbol;
      (values[reel] as Array<number | null>)[0] = value;
    }

    const result = evaluate(harbour, grid, { totalBet: 100n, coinValues: values });
    // 1+2+3+5+10 = 21, times the TOTAL bet of 100. Coins pay on total bet, not line bet.
    expect(result.coinWin?.amount).toBe("2100");
    expect(result.coinWin?.count).toBe(5);
    expect(result.coinWin?.coins).toHaveLength(5);
  });

  it("multiplies coin wins during free spins, like every other win", () => {
    const grid = gridOf(harbour, "H");
    const values = emptyValues(harbour);
    for (let reel = 0; reel < 5; reel++) {
      (grid[reel] as string[])[0] = coin.symbol;
      (values[reel] as Array<number | null>)[0] = 2;
    }

    const base = evaluate(harbour, grid, { totalBet: 100n, coinValues: values });
    const free = evaluate(harbour, grid, {
      totalBet: 100n,
      coinValues: values,
      winMultiplier: harbour.scatter.freeSpinMultiplier,
    });

    expect(BigInt(free.coinWin?.amount ?? "0")).toBe(
      BigInt(base.coinWin?.amount ?? "0") * BigInt(harbour.scatter.freeSpinMultiplier),
    );
  });

  it("refuses to grade a coin with no value, rather than paying zero for it", () => {
    // A grid and value matrix that disagree is a bug. Silently paying nothing for a coin the
    // player can see on screen would hide it.
    const grid = gridOf(harbour, "H");
    const values = emptyValues(harbour);
    for (let reel = 0; reel < 5; reel++) (grid[reel] as string[])[0] = coin.symbol;

    expect(() => evaluate(harbour, grid, { totalBet: 100n, coinValues: values })).toThrow(
      /has no value/,
    );
  });

  it("is never also a paying line symbol", () => {
    // Both would pay for the same cell twice. The schema refuses it; this pins the intent.
    expect(harbour.paytable[coin.symbol]).toBeUndefined();
  });
});

describe("scatter counts above the top tier", () => {
  it("pay the top tier rather than nothing", () => {
    // A weighted grid can show six scatters. A raw table lookup would find no "6" entry and
    // pay zero - less than five scatters pay, which would be plainly wrong.
    const grid = gridOf(harbour, "H");
    const cells: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [0, 1],
    ];
    for (const [reel, row] of cells) (grid[reel] as string[])[row] = harbour.scatter.symbol;

    const result = evaluate(harbour, grid, { totalBet: 100n, coinValues: emptyValues(harbour) });

    expect(result.scatterWin?.count).toBe(6);
    // Clamped to the "5" tier: 50 x the total bet.
    expect(result.scatterWin?.amount).toBe("5000");
    expect(result.freeSpinsAwarded).toBe(harbour.scatter.freeSpins["5"]);
  });

  it("resolve to the right tier", () => {
    expect(scatterTier(harbour.scatter.pays, 4)).toBe("4");
    expect(scatterTier(harbour.scatter.pays, 7)).toBe("5");
    expect(scatterTier(harbour.scatter.pays, 2)).toBeNull();
    expect(scatterTier(harbour.scatter.pays, 0)).toBeNull();
  });
});

describe("the reel model is exclusive", () => {
  it("refuses a config with both strips and weights", () => {
    const base = structuredClone(harbour) as Record<string, unknown>;
    base["reelStrips"] = Array.from({ length: 5 }, () => Array.from({ length: 12 }, () => "H"));
    expect(() => slotConfigSchema.parse(base)).toThrow(/OR/i);
  });

  it("refuses a config with neither", () => {
    const base = structuredClone(harbour) as Record<string, unknown>;
    delete base["reelWeights"];
    expect(() => slotConfigSchema.parse(base)).toThrow(/either/i);
  });

  it("refuses a reel whose weights are all zero", () => {
    const base = structuredClone(harbour) as Record<string, unknown>;
    (base["reelWeights"] as Array<Record<string, number>>)[2] = { H: 0, P: 0 };
    expect(() => slotConfigSchema.parse(base)).toThrow(/weight above 0/);
  });
});
