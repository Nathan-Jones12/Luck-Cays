/**
 * The measurement core, shared by the CLI (`index.ts`) and the paytable tuner
 * (`tune.ts`).
 *
 * It drives the same `evaluate()` the live spin service uses, so what it measures
 * is what players actually get. An engine the simulator does not exercise is an
 * unmeasured RTP.
 */
import { randomInt } from "node:crypto";
import { evaluate, spinGrid, type RandomInt, type SlotConfig } from "@luck-cays/shared";

export type RngMode = "crypto" | "fast";

/** Seeded xorshift32. Tuning only, never used for a real outcome. */
export function makeFastRng(seed: number): RandomInt {
  let state = seed >>> 0 || 0x9e3779b9;
  return (maxExclusive: number) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    // Modulo bias is negligible at these bounds (strip lengths of ~40 against
    // 2^32) and this generator never decides a real spin.
    return state % maxExclusive;
  };
}

export function makeRng(mode: RngMode, seed: number): RandomInt {
  return mode === "crypto" ? (max) => randomInt(max) : makeFastRng(seed);
}

export const BANDS: Array<[label: string, ceiling: number]> = [
  ["0x (no win)", 0],
  ["0-1x", 1],
  ["1-2x", 2],
  ["2-5x", 5],
  ["5-10x", 10],
  ["10-25x", 25],
  ["25-100x", 100],
  ["100x+", Number.POSITIVE_INFINITY],
];

function bandFor(ratio: number): string {
  if (ratio === 0) return "0x (no win)";
  for (let i = 1; i < BANDS.length; i++) {
    const band = BANDS[i];
    if (band && ratio < band[1]) return band[0];
  }
  return "100x+";
}

export interface SimOptions {
  rounds: number;
  bet: bigint;
  rng: RandomInt;
}

export interface SimResult {
  rounds: number;
  staked: bigint;
  returned: bigint;
  baseReturned: bigint;
  freeReturned: bigint;
  hits: number;
  freeSpinTriggers: number;
  freeSpinsPlayed: number;
  maxRoundWin: bigint;
  bands: Map<string, number>;
  /** Return as a fraction of stake. */
  rtp: number;
  /** Standard deviation of per-round return, in multiples of the bet. */
  stdDev: number;
  /** 95% confidence half-width on `rtp`. */
  ci95: number;
  elapsedMs: number;
}

/**
 * One complete round: a paid base spin plus any free spins it awards.
 *
 * RTP is measured per round, not per spin. Free spins cost nothing, so counting
 * them in the stake would understate the return the player actually sees.
 */
export function simulate(config: SlotConfig, options: SimOptions): SimResult {
  const { rounds, bet, rng } = options;
  const multiplier = config.scatter.freeSpinMultiplier;

  let staked = 0n;
  let returned = 0n;
  let baseReturned = 0n;
  let freeReturned = 0n;
  let hits = 0;
  let freeSpinTriggers = 0;
  let freeSpinsPlayed = 0;
  let maxRoundWin = 0n;
  let sumRatio = 0;
  let sumRatioSq = 0;
  const bands = new Map<string, number>();

  const betNumber = Number(bet);
  const started = Date.now();

  for (let i = 0; i < rounds; i++) {
    const paid = spinGrid(config, rng);
    const base = evaluate(config, paid.grid, {
      totalBet: bet,
      coinValues: paid.coinValues,
    });

    let roundWin = base.totalWin;
    baseReturned += base.totalWin;

    let freeSpins = base.freeSpinsAwarded;
    if (freeSpins > 0) freeSpinTriggers++;

    let retriggerGuard = 0;
    while (freeSpins > 0) {
      freeSpins--;
      freeSpinsPlayed++;

      const bonus = spinGrid(config, rng);
      const free = evaluate(config, bonus.grid, {
        totalBet: bet,
        winMultiplier: multiplier,
        coinValues: bonus.coinValues,
      });

      roundWin += free.totalWin;
      freeReturned += free.totalWin;

      if (config.scatter.retrigger && free.freeSpinsAwarded > 0 && retriggerGuard++ < 1000) {
        freeSpins += free.freeSpinsAwarded;
      }
    }

    staked += bet;
    returned += roundWin;
    if (roundWin > 0n) hits++;
    if (roundWin > maxRoundWin) maxRoundWin = roundWin;

    const ratio = Number(roundWin) / betNumber;
    sumRatio += ratio;
    sumRatioSq += ratio * ratio;
    const band = bandFor(ratio);
    bands.set(band, (bands.get(band) ?? 0) + 1);
  }

  const elapsedMs = Date.now() - started;
  const mean = sumRatio / rounds;
  const variance = sumRatioSq / rounds - mean * mean;
  const stdDev = Math.sqrt(Math.max(variance, 0));

  return {
    rounds,
    staked,
    returned,
    baseReturned,
    freeReturned,
    hits,
    freeSpinTriggers,
    freeSpinsPlayed,
    maxRoundWin,
    bands,
    rtp: Number(returned) / Number(staked),
    stdDev,
    ci95: (1.96 * stdDev) / Math.sqrt(rounds),
    elapsedMs,
  };
}

/** How far outside the PRD tolerance a measured RTP sits. */
export const RTP_TOLERANCE = 0.005;

export function withinTolerance(rtp: number, target: number): boolean {
  return Math.abs(rtp - target) <= RTP_TOLERANCE;
}
