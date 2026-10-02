/**
 * Exact RTP, in closed form. No sampling, no confidence interval.
 *
 * Monte Carlo cannot certify a 0.5% tolerance on a high-volatility game at any
 * sane round count - the estimate is dominated by rare, enormous wins, so a 1.5M
 * round run still swings most of a point between seeds. The expectation, though,
 * is computable, and these games are simple enough to compute it:
 *
 * 1. LINE WINS. A stop is uniform over its strip, so the symbol at any single
 *    (reel, row) cell is distributed exactly as that strip's composition - the row
 *    does not matter. A payline touches one cell per reel, and reels are
 *    independent, so a line's five symbols are independent draws from the five
 *    strip compositions. Enumerating every symbol tuple (10^5 for these games)
 *    with its exact probability gives the exact expected line multiplier. Because
 *    the per-cell distribution is row-independent, every payline has the same
 *    expectation, so one enumeration covers all 20.
 *
 * 2. SCATTER WINS. Scatters pay on a count across the whole window, so composition
 *    alone is not enough - how many scatters a 3-row window shows depends on strip
 *    ordering. We get that exactly by walking all L stops of each reel and counting
 *    the scatters each window shows, which gives a per-reel distribution; then we
 *    convolve the five reels for the exact distribution of the total.
 *
 * 3. FREE SPINS. Free spins are fresh, independent spins, so their contribution is
 *    E[spins awarded] x E[win per spin] x the free-spin multiplier. Expectation is
 *    linear, so we may add line and scatter expectations even though both depend on
 *    the same stops.
 *
 * Retriggering is handled as a geometric series. The one thing this does not model
 * is a retrigger cap, so a config with `retrigger: true` and a trigger chance above
 * 1 would diverge; that is asserted against.
 *
 * Everything is in units of total bet, so the result is RTP directly.
 */
import { lineOutcome } from "./engine.js";
import type { SlotConfig } from "./types.js";

export interface ExactRtp {
  /** Expected line win per spin, as a fraction of total bet. */
  lineRtp: number;
  /** Expected scatter win per spin, as a fraction of total bet. */
  scatterRtp: number;
  /** Expected free spins awarded per base spin. */
  freeSpinsPerSpin: number;
  /** Everything the free-spin rounds return, as a fraction of total bet. */
  freeRtp: number;
  /** The total. This is the number that must sit within tolerance of rtpTarget. */
  rtp: number;
  /**
   * Probability a base spin triggers free spins. Exact: it depends only on the
   * scatter count distribution, which is computed exactly.
   *
   * Note there is deliberately no `hitRate` here. Hit frequency is the chance that
   * *at least one* of 20 paylines pays, and paylines share cells, so they are not
   * independent - there is no product formula for it, and treating them as
   * independent overstates it by about ten points. Expected value is immune to that
   * dependence (expectation is linear), which is why RTP is exactly computable and
   * hit rate is not. Take hit rate from the simulator, where it is measured
   * directly and converges quickly.
   */
  triggerRate: number;
}

/** Per-symbol probability for one cell on a given reel: count / strip length. */
function reelComposition(strip: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of strip) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);

  const probabilities = new Map<string, number>();
  for (const [symbol, count] of counts) probabilities.set(symbol, count / strip.length);
  return probabilities;
}

/**
 * Exact expected line multiplier, by enumerating every symbol tuple with its exact
 * probability. Nothing is pruned or sampled - for a 5-reel, 10-symbol game that is
 * 100,000 tuples, which is cheap enough to do in full.
 */
function expectedLineMultiplier(config: SlotConfig): number {
  const alphabets = config.reelStrips.map((strip) => [...reelComposition(strip).entries()]);

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

/**
 * Exact distribution of scatters in the visible window, by reel. Index is the
 * number of scatters that reel can show; value is its probability.
 */
function scatterDistributionPerReel(config: SlotConfig): number[][] {
  const scatter = config.scatter.symbol;

  return config.reelStrips.map((strip) => {
    const counts: number[] = [];
    for (let stop = 0; stop < strip.length; stop++) {
      let inWindow = 0;
      for (let row = 0; row < config.rows; row++) {
        if (strip[(stop + row) % strip.length] === scatter) inWindow++;
      }
      counts[inWindow] = (counts[inWindow] ?? 0) + 1;
    }
    return counts.map((n) => (n ?? 0) / strip.length);
  });
}

/** Convolve the per-reel distributions into the distribution of the total. */
function totalScatterDistribution(config: SlotConfig): number[] {
  let distribution = [1];

  for (const reel of scatterDistributionPerReel(config)) {
    const next: number[] = new Array(distribution.length + reel.length - 1).fill(0);
    for (const [i, pi] of distribution.entries()) {
      if (pi === 0) continue;
      for (const [j, pj] of reel.entries()) {
        if (pj === undefined || pj === 0) continue;
        next[i + j] = (next[i + j] ?? 0) + pi * pj;
      }
    }
    distribution = next;
  }

  return distribution;
}

export function exactRtp(config: SlotConfig): ExactRtp {
  // A line pays `multiplier x lineBet` and lineBet is totalBet / lineCount, so in
  // units of total bet one line contributes multiplier / lineCount - and there are
  // lineCount identically distributed lines, which cancels to E[multiplier].
  //
  // The lines are NOT independent (they share cells), but expectation is linear, so
  // summing them is exact regardless.
  const lineRtp = expectedLineMultiplier(config);

  const scatterDistribution = totalScatterDistribution(config);

  let scatterRtp = 0;
  let freeSpinsPerSpin = 0;
  let triggerRate = 0;

  for (const [count, probability] of scatterDistribution.entries()) {
    if (probability === 0) continue;
    const key = String(count);

    const pays = config.scatter.pays[key];
    if (pays !== undefined) scatterRtp += probability * pays;

    const spins = config.scatter.freeSpins[key];
    if (spins !== undefined && spins > 0) {
      freeSpinsPerSpin += probability * spins;
      triggerRate += probability;
    }
  }

  // Per free spin, the same line and scatter expectation, times the multiplier.
  const perFreeSpin = (lineRtp + scatterRtp) * config.scatter.freeSpinMultiplier;

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
    freeSpinsPerSpin: freeSpinsTotal,
    freeRtp,
    rtp: lineRtp + scatterRtp + freeRtp,
    triggerRate,
  };
}
