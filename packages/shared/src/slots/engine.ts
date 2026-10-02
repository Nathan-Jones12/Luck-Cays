import type { SlotConfig, SlotGrid, SlotLineWin, SlotScatterWin } from "./types.js";

/**
 * The slot engine. Pure, synchronous, no I/O: given a config and a source of
 * randomness it produces reel stops and grades the resulting grid.
 *
 * The API's spin service and `tools/rtp-sim` both call this, so the simulator
 * measures the same code that pays real players. Keep it that way - an engine
 * the simulator does not exercise is an unmeasured RTP.
 */

/** Returns a uniform integer in `[0, maxExclusive)`. */
export type RandomInt = (maxExclusive: number) => number;

/** Multipliers are scaled to integers so no payout touches floating point. */
const MULT_SCALE = 1_000n;

function scaleMultiplier(multiplier: number): bigint {
  return BigInt(Math.round(multiplier * Number(MULT_SCALE)));
}

/** `multiplier x stake`, floored, done entirely in bigint. */
function payout(stake: bigint, multiplier: number): bigint {
  return (stake * scaleMultiplier(multiplier)) / MULT_SCALE;
}

/** Pick one uniform stop index per reel. */
export function pickStops(config: SlotConfig, randomInt: RandomInt): number[] {
  return config.reelStrips.map((strip) => randomInt(strip.length));
}

/**
 * Build the visible window from the stops. The stop is the symbol shown in the
 * top row; the window reads downward and wraps around the end of the strip.
 */
export function buildGrid(config: SlotConfig, stops: number[]): SlotGrid {
  return config.reelStrips.map((strip, reel) => {
    const stop = stops[reel] ?? 0;
    const column: string[] = [];
    for (let row = 0; row < config.rows; row++) {
      column.push(strip[(stop + row) % strip.length] as string);
    }
    return column;
  });
}

export interface LineOutcome {
  /** The symbol the line paid as. For an all-wild run this is the wild. */
  symbol: string;
  /** Run length from reel 0. */
  count: number;
  /** Multiplier of the line bet, straight from the paytable. */
  multiplier: number;
}

/**
 * Grade one payline from its symbols, left to right.
 *
 * Wins pay from reel 0 only, and a wild stands in for any symbol except the
 * scatter. We try the wild as its own symbol and we try the first non-wild symbol
 * on the line, then pay whichever is worth more - the conventional "best of" rule.
 * A scatter never forms a line win.
 *
 * This is the single source of the line rule: `evaluate` uses it for real spins and
 * `tools/slot-gen/src/exact.ts` uses it to compute RTP in closed form. Keep it that
 * way, or the exact figure stops describing the live game.
 */
export function lineOutcome(config: SlotConfig, symbols: string[]): LineOutcome | null {
  const wild = config.wild.symbol;
  const scatter = config.scatter.symbol;

  const candidates = new Set<string>();
  if (config.wild.substitutes) {
    candidates.add(wild);
    const firstNonWild = symbols.find((s) => s !== wild);
    if (firstNonWild !== undefined) candidates.add(firstNonWild);
  } else if (symbols[0] !== undefined) {
    candidates.add(symbols[0]);
  }

  let best: LineOutcome | null = null;

  for (const target of candidates) {
    if (target === scatter) continue;

    let run = 0;
    for (const symbol of symbols) {
      const matches =
        symbol === target || (config.wild.substitutes && symbol === wild && target !== scatter);
      if (!matches) break;
      run++;
    }

    const multiplier = config.paytable[target]?.[String(run)];
    if (multiplier === undefined || multiplier <= 0) continue;

    if (best === null || multiplier > best.multiplier) {
      best = { symbol: target, count: run, multiplier };
    }
  }

  return best;
}

export interface EvaluateOptions {
  /** Total bet for the spin, in chips. Line bet is this divided by payline count. */
  totalBet: bigint;
  /** Multiplier applied to line and scatter wins (free-spin rounds pass > 1). */
  winMultiplier?: number;
}

export interface Evaluation {
  lineWins: SlotLineWin[];
  scatterWin: SlotScatterWin | null;
  totalWin: bigint;
  freeSpinsAwarded: number;
}

/**
 * Grade a grid.
 *
 * Line rule: wins pay left to right from reel 0 only, and a wild stands in for
 * any symbol except the scatter. For each line we try the wild as its own symbol
 * and we try the first non-wild symbol on the line, then pay whichever is worth
 * more - the conventional "best of" rule. A scatter never forms a line win.
 */
export function evaluate(config: SlotConfig, grid: SlotGrid, options: EvaluateOptions): Evaluation {
  const { totalBet, winMultiplier = 1 } = options;
  const scatter = config.scatter.symbol;
  const lineCount = config.paylines.length;

  // Guaranteed whole by the config schema: every bet level divides by lineCount.
  const lineBet = totalBet / BigInt(lineCount);

  const lineWins: SlotLineWin[] = [];
  let totalWin = 0n;

  for (const [lineIndex, line] of config.paylines.entries()) {
    const symbols = line.map((row, reel) => (grid[reel] as string[])[row] as string);

    const outcome = lineOutcome(config, symbols);
    if (outcome === null) continue;

    const amount = payout(lineBet, outcome.multiplier * winMultiplier);
    if (amount <= 0n) continue;

    lineWins.push({
      line: lineIndex,
      symbol: outcome.symbol,
      count: outcome.count,
      amount: amount.toString(10),
      cells: line.slice(0, outcome.count).map((row, reel) => [reel, row] as [number, number]),
    });
    totalWin += amount;
  }

  // Scatters pay from anywhere, as a multiple of the total bet, and award spins.
  const scatterCells: Array<[number, number]> = [];
  for (const [reel, column] of grid.entries()) {
    for (const [row, symbol] of column.entries()) {
      if (symbol === scatter) scatterCells.push([reel, row]);
    }
  }

  let scatterWin: SlotScatterWin | null = null;
  let freeSpinsAwarded = 0;

  if (scatterCells.length > 0) {
    const key = String(scatterCells.length);
    const scatterMultiplier = config.scatter.pays[key];
    if (scatterMultiplier !== undefined && scatterMultiplier > 0) {
      const amount = payout(totalBet, scatterMultiplier * winMultiplier);
      scatterWin = {
        symbol: scatter,
        count: scatterCells.length,
        amount: amount.toString(10),
        cells: scatterCells,
      };
      totalWin += amount;
    }
    freeSpinsAwarded = config.scatter.freeSpins[key] ?? 0;
  }

  return { lineWins, scatterWin, totalWin, freeSpinsAwarded };
}

/** Convenience: one complete spin, stops included. Used by the sim and tests. */
export function spin(
  config: SlotConfig,
  randomInt: RandomInt,
  options: EvaluateOptions,
): Evaluation & { stops: number[]; grid: SlotGrid } {
  const stops = pickStops(config, randomInt);
  const grid = buildGrid(config, stops);
  return { stops, grid, ...evaluate(config, grid, options) };
}

/** Smallest scatter count that awards free spins, or null if none do. */
export function freeSpinTrigger(config: SlotConfig): number | null {
  const counts = Object.entries(config.scatter.freeSpins)
    .filter(([, spins]) => spins > 0)
    .map(([count]) => Number(count));
  return counts.length > 0 ? Math.min(...counts) : null;
}
