import type {
  SlotCoinValues,
  SlotCoinWin,
  SlotConfig,
  SlotGrid,
  SlotLineWin,
  SlotScatterWin,
} from "./types.js";

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

/** Which reel model a config uses. Exactly one is present; the schema enforces that. */
export function reelModel(config: SlotConfig): "strips" | "weighted" {
  return config.reelStrips ? "strips" : "weighted";
}

/**
 * Pick one uniform stop index per reel.
 *
 * Strip games only. A weighted game has no strip to land on, so it has no stops - use
 * `spinGrid` instead, which handles both models.
 */
export function pickStops(config: SlotConfig, randomInt: RandomInt): number[] {
  if (!config.reelStrips) {
    throw new Error(`${config.slug} is a weighted game and has no reel stops`);
  }
  return config.reelStrips.map((strip) => randomInt(strip.length));
}

/**
 * Draw one item from a weighted table.
 *
 * Walks a cumulative total rather than normalising to a float, so the only randomness is the
 * integer the caller supplies. `randomInt` is rejection-sampled by node, so this is unbiased -
 * scaling a float into a range, which is the usual shortcut, is not.
 */
function pickWeighted<T>(entries: Array<{ item: T; weight: number }>, randomInt: RandomInt): T {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) throw new Error("cannot draw from a table whose weights sum to zero");

  let roll = randomInt(total);
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0) return entry.item;
  }
  // Unreachable while the weights sum to `total`; kept so the function is total.
  return (entries[entries.length - 1] as { item: T; weight: number }).item;
}

/** The weighted symbol table for one reel, as entries, skipping zero-weight symbols. */
function reelEntries(config: SlotConfig, reel: number): Array<{ item: string; weight: number }> {
  const weights = config.reelWeights?.[reel];
  if (!weights) throw new Error(`${config.slug} has no weight table for reel ${reel}`);

  return Object.entries(weights)
    .filter(([, weight]) => weight > 0)
    .map(([item, weight]) => ({ item, weight }));
}

/**
 * Build the visible window from the stops. The stop is the symbol shown in the
 * top row; the window reads downward and wraps around the end of the strip.
 */
export function buildGrid(config: SlotConfig, stops: number[]): SlotGrid {
  if (!config.reelStrips) {
    throw new Error(`${config.slug} is a weighted game; buildGrid needs reel strips`);
  }
  return config.reelStrips.map((strip, reel) => {
    const stop = stops[reel] ?? 0;
    const column: string[] = [];
    for (let row = 0; row < config.rows; row++) {
      column.push(strip[(stop + row) % strip.length] as string);
    }
    return column;
  });
}

export interface SpunGrid {
  grid: SlotGrid;
  /** Empty for a weighted game, which has no strip position to report. */
  stops: number[];
  /** Per-cell coin values for a game with the coin feature; null otherwise. */
  coinValues: SlotCoinValues | null;
}

/**
 * Spin the reels, whichever model the game uses, and draw a value for every coin that landed.
 *
 * This is the one place a spin's randomness is consumed, so it is the one place to audit.
 * Everything downstream grades a grid it was handed.
 */
export function spinGrid(config: SlotConfig, randomInt: RandomInt): SpunGrid {
  let grid: SlotGrid;
  let stops: number[] = [];

  if (config.reelStrips) {
    stops = pickStops(config, randomInt);
    grid = buildGrid(config, stops);
  } else {
    grid = Array.from({ length: config.reels }, (_, reel) => {
      const entries = reelEntries(config, reel);
      // Every cell drawn independently - that is what the weighted model means.
      return Array.from({ length: config.rows }, () => pickWeighted(entries, randomInt));
    });
  }

  return { grid, stops, coinValues: drawCoinValues(config, grid, randomInt) };
}

/**
 * Give each coin on the grid its own value.
 *
 * Drawn per coin, not per spin: five coins showing five different figures is the whole visual
 * appeal of the feature.
 */
export function drawCoinValues(
  config: SlotConfig,
  grid: SlotGrid,
  randomInt: RandomInt,
): SlotCoinValues | null {
  const coin = config.coin;
  if (!coin) return null;

  const entries = coin.values.map((entry) => ({ item: entry.value, weight: entry.weight }));

  return grid.map((column) =>
    column.map((symbol) => (symbol === coin.symbol ? pickWeighted(entries, randomInt) : null)),
  );
}

/**
 * The paytable tier a scatter count falls into.
 *
 * Counts above the highest listed tier are clamped down to it. That matters more than it
 * looks: a weighted game draws every cell independently, so a grid can show six or more
 * scatters, and a raw lookup would find no entry and pay ZERO - less than five scatters pay.
 * Six scatters must never be worth less than five.
 *
 * Shared by `evaluate` and the exact RTP maths so the two cannot disagree about it.
 */
export function scatterTier(table: Record<string, number>, count: number): string | null {
  if (count <= 0) return null;
  if (table[String(count)] !== undefined) return String(count);

  const tiers = Object.keys(table)
    .map(Number)
    .filter((tier) => Number.isFinite(tier))
    .sort((a, b) => b - a);

  const highest = tiers[0];
  if (highest === undefined) return null;

  return count > highest ? String(highest) : null;
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
  /** Multiplier applied to line, scatter and coin wins (free-spin rounds pass > 1). */
  winMultiplier?: number;
  /** Per-cell coin values from the spin. Required for a game with the coin feature. */
  coinValues?: SlotCoinValues | null;
}

export interface Evaluation {
  lineWins: SlotLineWin[];
  scatterWin: SlotScatterWin | null;
  coinWin: SlotCoinWin | null;
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
    // Clamped, not raw: see `scatterTier`. A weighted game can show more scatters than the
    // table lists, and those must pay the top tier rather than nothing.
    const payKey = scatterTier(config.scatter.pays, scatterCells.length);
    const scatterMultiplier = payKey === null ? undefined : config.scatter.pays[payKey];

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

    const spinKey = scatterTier(config.scatter.freeSpins, scatterCells.length);
    freeSpinsAwarded = spinKey === null ? 0 : (config.scatter.freeSpins[spinKey] ?? 0);
  }

  /* --------------------------------- coins --------------------------------- */

  let coinWin: SlotCoinWin | null = null;

  if (config.coin && options.coinValues) {
    const coin = config.coin;
    const values = options.coinValues;

    const landed: Array<{ cell: [number, number]; value: number }> = [];
    for (const [reel, column] of grid.entries()) {
      for (const [row, symbol] of column.entries()) {
        if (symbol !== coin.symbol) continue;
        const value = values[reel]?.[row];
        // A coin with no value means the spin and the grid disagree, which is a bug worth
        // surfacing rather than quietly paying zero.
        if (value == null) {
          throw new Error(`${config.slug}: coin at ${reel},${row} has no value`);
        }
        landed.push({ cell: [reel, row], value });
      }
    }

    // All or nothing. Below the threshold the coins are decoration, which is the feature.
    if (landed.length >= coin.needed) {
      const summed = landed.reduce((total, entry) => total + entry.value, 0);
      // Coin values multiply the TOTAL bet, like scatters, not the line bet.
      const amount = payout(totalBet, summed * winMultiplier);

      if (amount > 0n) {
        coinWin = {
          symbol: coin.symbol,
          count: landed.length,
          amount: amount.toString(10),
          coins: landed,
        };
        totalWin += amount;
      }
    }
  }

  return { lineWins, scatterWin, coinWin, totalWin, freeSpinsAwarded };
}

/**
 * One complete spin, graded. Works for either reel model and draws coin values when the game
 * has the feature, so callers never have to know which kind of game they hold.
 */
export function spin(
  config: SlotConfig,
  randomInt: RandomInt,
  options: EvaluateOptions,
): Evaluation & SpunGrid {
  const spun = spinGrid(config, randomInt);
  return {
    ...spun,
    ...evaluate(config, spun.grid, { ...options, coinValues: spun.coinValues }),
  };
}

/** Smallest scatter count that awards free spins, or null if none do. */
export function freeSpinTrigger(config: SlotConfig): number | null {
  const counts = Object.entries(config.scatter.freeSpins)
    .filter(([, spins]) => spins > 0)
    .map(([count]) => Number(count));
  return counts.length > 0 ? Math.min(...counts) : null;
}
