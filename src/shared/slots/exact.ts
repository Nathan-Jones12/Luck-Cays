/**
 * Exact RTP, in closed form. No sampling, no confidence interval.
 *
 * Monte Carlo cannot certify a 0.5% tolerance on a high-volatility game at any sane round
 * count - the estimate is dominated by rare, enormous wins, so a 1.5M round run still swings
 * most of a point between seeds. The expectation, though, is computable, and these games are
 * simple enough to compute it.
 *
 * Everything rests on one fact: **a single cell's symbol distribution is independent across
 * reels**, under either reel model.
 *
 *  - Weighted reels: every cell is drawn independently by construction.
 *  - Reel strips: a stop is uniform over the strip, so the symbol at any ONE (reel, row) cell
 *    is distributed exactly as that strip's composition, and the row does not matter. Cells on
 *    the *same* reel are correlated - they are adjacent on the strip - but a payline touches
 *    only one cell per reel, so a line's five symbols are independent.
 *
 * From there:
 *
 * 1. LINE WINS. Enumerate every symbol tuple (10^5 for these games) with its exact
 *    probability. Because the per-cell distribution does not depend on the row, every payline
 *    has the same expectation, so one enumeration covers all 20.
 *
 * 2. SCATTER AND COIN WINS. These pay on a COUNT across the whole window, so per-cell
 *    independence is not enough on a strip game - how many land on one reel depends on the
 *    strip's ordering. We get each reel's count distribution exactly (by walking every stop on
 *    a strip game, or from the binomial on a weighted one) and convolve the reels.
 *
 * 3. COIN VALUES. Each coin's value is an independent draw, so the expected sum of k coins is
 *    k times the mean value. No enumeration of value combinations needed.
 *
 * 4. FREE SPINS. Free spins are fresh, independent spins, so their contribution is
 *    E[spins awarded] x E[win per spin] x the free-spin multiplier. Expectation is linear, so
 *    line, scatter and coin expectations may be added even though all three depend on the same
 *    stops.
 *
 * Retriggering is handled as a geometric series, and a config that would diverge is asserted
 * against.
 *
 * Everything is in units of total bet, so the result is RTP directly.
 */
import { lineOutcome, scatterTier } from "./engine.js";
import type { SlotConfig } from "./types.js";

export interface ExactRtp {
  /** Expected line win per spin, as a fraction of total bet. */
  lineRtp: number;
  /** Expected scatter win per spin, as a fraction of total bet. */
  scatterRtp: number;
  /** Expected coin-feature win per spin. Zero for a game without the feature. */
  coinRtp: number;
  /** Expected free spins awarded per base spin. */
  freeSpinsPerSpin: number;
  /** Everything the free-spin rounds return, as a fraction of total bet. */
  freeRtp: number;
  /** The total. This is the number that must sit within tolerance of rtpTarget. */
  rtp: number;
  /**
   * Probability a base spin triggers free spins. Exact: it depends only on the scatter count
   * distribution, which is computed exactly.
   *
   * Note there is deliberately no `hitRate` here. Hit frequency is the chance that *at least
   * one* of 20 paylines pays, and paylines share cells, so they are not independent - there is
   * no product formula for it, and treating them as independent overstates it by about ten
   * points. Expected value is immune to that dependence (expectation is linear), which is why
   * RTP is exactly computable and hit rate is not. Take hit rate from the simulator, where it
   * is measured directly and converges quickly.
   */
  triggerRate: number;
  /** Probability the coin feature pays at all. Zero without the feature. */
  coinHitRate: number;
}

/**
 * Per-symbol probability for one cell on a reel.
 *
 * Identical for every row, under either model - see the note at the top of the file.
 */
function cellProbabilities(config: SlotConfig, reel: number): Map<string, number> {
  const probabilities = new Map<string, number>();

  if (config.reelStrips) {
    const strip = config.reelStrips[reel];
    if (!strip) throw new Error(`${config.slug}: no strip for reel ${reel}`);

    const counts = new Map<string, number>();
    for (const symbol of strip) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    for (const [symbol, count] of counts) probabilities.set(symbol, count / strip.length);
    return probabilities;
  }

  const weights = config.reelWeights?.[reel];
  if (!weights) throw new Error(`${config.slug}: no weight table for reel ${reel}`);

  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const [symbol, weight] of Object.entries(weights)) {
    if (weight > 0) probabilities.set(symbol, weight / total);
  }
  return probabilities;
}

/**
 * Exact expected line multiplier, by enumerating every symbol tuple with its exact probability.
 * Nothing is pruned or sampled - for a 5-reel, 10-symbol game that is 100,000 tuples, which is
 * cheap enough to do in full.
 */
function expectedLineMultiplier(config: SlotConfig): number {
  const alphabets = Array.from({ length: config.reels }, (_, reel) => [
    ...cellProbabilities(config, reel).entries(),
  ]);

  let expected = 0;
  const tuple: string[] = new Array(config.reels).fill("");

  const walk = (reel: number, probability: number): void => {
    if (reel === config.reels) {
      const outcome = lineOutcome(config, tuple);
      if (outcome !== null) expected += probability * outcome.multiplier;
      return;
    }
    for (const [symbol, p] of alphabets[reel] as Array<[string, number]>) {
      tuple[reel] = symbol;
      walk(reel + 1, probability * p);
    }
  };

  walk(0, 1);
  return expected;
}

/** n choose k, for the binomial. Small n here, so the naive product is fine. */
function binomialCoefficient(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

/**
 * Exact distribution of how many times `symbol` appears in ONE reel's visible window.
 * Index is the count, value is the probability.
 *
 * Strip games walk every stop, because the answer depends on the strip's ordering - two
 * adjacent copies of a symbol can show together, spaced-out copies cannot. Weighted games draw
 * each cell independently, so the count is binomial.
 */
function countDistributionForReel(config: SlotConfig, reel: number, symbol: string): number[] {
  if (config.reelStrips) {
    const strip = config.reelStrips[reel];
    if (!strip) throw new Error(`${config.slug}: no strip for reel ${reel}`);

    const counts: number[] = [];
    for (let stop = 0; stop < strip.length; stop++) {
      let inWindow = 0;
      for (let row = 0; row < config.rows; row++) {
        if (strip[(stop + row) % strip.length] === symbol) inWindow++;
      }
      counts[inWindow] = (counts[inWindow] ?? 0) + 1;
    }
    return Array.from({ length: counts.length }, (_, i) => (counts[i] ?? 0) / strip.length);
  }

  const p = cellProbabilities(config, reel).get(symbol) ?? 0;
  const n = config.rows;

  return Array.from(
    { length: n + 1 },
    (_, k) => binomialCoefficient(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k),
  );
}

/** Convolve the per-reel distributions into the distribution of the total across the grid. */
function totalCountDistribution(config: SlotConfig, symbol: string): number[] {
  let distribution = [1];

  for (let reel = 0; reel < config.reels; reel++) {
    const perReel = countDistributionForReel(config, reel, symbol);
    const next: number[] = new Array(distribution.length + perReel.length - 1).fill(0);

    for (const [i, pi] of distribution.entries()) {
      if (pi === 0) continue;
      for (const [j, pj] of perReel.entries()) {
        if (pj === undefined || pj === 0) continue;
        next[i + j] = (next[i + j] ?? 0) + pi * pj;
      }
    }
    distribution = next;
  }

  return distribution;
}

/** Mean value of a single coin, in multiples of total bet. */
function meanCoinValue(config: SlotConfig): number {
  const coin = config.coin;
  if (!coin) return 0;

  const totalWeight = coin.values.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return 0;

  return coin.values.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalWeight;
}

export function exactRtp(config: SlotConfig): ExactRtp {
  // A line pays `multiplier x lineBet` and lineBet is totalBet / lineCount, so in units of
  // total bet one line contributes multiplier / lineCount - and there are lineCount
  // identically distributed lines, which cancels to E[multiplier].
  //
  // The lines are NOT independent of each other (they share cells), but expectation is linear,
  // so summing them is exact regardless.
  const lineRtp = expectedLineMultiplier(config);

  /* ------------------------------- scatters -------------------------------- */

  const scatterDistribution = totalCountDistribution(config, config.scatter.symbol);

  let scatterRtp = 0;
  let freeSpinsPerSpin = 0;
  let triggerRate = 0;

  for (const [count, probability] of scatterDistribution.entries()) {
    if (probability === 0) continue;

    // Clamped through the same helper the engine uses, so the exact figure cannot disagree
    // with what a player is actually paid for six or more scatters.
    const payKey = scatterTier(config.scatter.pays, count);
    const pays = payKey === null ? undefined : config.scatter.pays[payKey];
    if (pays !== undefined) scatterRtp += probability * pays;

    const spinKey = scatterTier(config.scatter.freeSpins, count);
    const spins = spinKey === null ? undefined : config.scatter.freeSpins[spinKey];
    if (spins !== undefined && spins > 0) {
      freeSpinsPerSpin += probability * spins;
      triggerRate += probability;
    }
  }

  /* --------------------------------- coins --------------------------------- */

  let coinRtp = 0;
  let coinHitRate = 0;

  if (config.coin) {
    const coinDistribution = totalCountDistribution(config, config.coin.symbol);
    const mean = meanCoinValue(config);

    for (const [count, probability] of coinDistribution.entries()) {
      if (probability === 0 || count < config.coin.needed) continue;

      // Coin values are independent draws, so the expected sum of `count` of them is
      // `count * mean`. No need to enumerate value combinations.
      coinRtp += probability * count * mean;
      coinHitRate += probability;
    }
  }

  /* ------------------------------- free spins ------------------------------ */

  // Per free spin, the same line, scatter and coin expectation, times the multiplier.
  const perFreeSpin = (lineRtp + scatterRtp + coinRtp) * config.scatter.freeSpinMultiplier;

  let freeSpinsTotal = freeSpinsPerSpin;
  if (config.scatter.retrigger) {
    // Each free spin can award more at the same rate: a geometric series.
    if (freeSpinsPerSpin >= 1) {
      throw new Error(
        `${config.slug}: retrigger with ${freeSpinsPerSpin.toFixed(3)} free spins awarded per spin never terminates`,
      );
    }
    freeSpinsTotal = freeSpinsPerSpin / (1 - freeSpinsPerSpin);
  }

  const freeRtp = freeSpinsTotal * perFreeSpin;

  return {
    lineRtp,
    scatterRtp,
    coinRtp,
    freeSpinsPerSpin: freeSpinsTotal,
    freeRtp,
    rtp: lineRtp + scatterRtp + coinRtp + freeRtp,
    triggerRate,
    coinHitRate,
  };
}
