/**
 * Paytable calibrator.
 *
 *   npm run tune --workspace @luck-cays/slot-gen
 *   npm run tune --workspace @luck-cays/slot-gen -- --game reef-riches
 *
 * RTP is computed in closed form by `exact.ts`, not sampled, so every candidate
 * paytable is evaluated instantly and exactly. That matters: Monte Carlo on a
 * high-volatility game swings most of a percentage point between seeds even at
 * 1.5M rounds, which is wider than the 0.5% tolerance we are trying to hit, so a
 * sampled tuner cannot actually land the target - it only looks like it has.
 *
 * Three stages:
 *   1. Scale every payout by `target / current`. RTP is linear in the paytable, so
 *      this is one exact step.
 *   2. Round to numbers that look designed - premiums coarsely, lows finely.
 *   3. Coordinate descent on the low symbols in integer steps to close the gap the
 *      rounding opened. Lows are the most frequent payers, so they are the finest
 *      knob available, and monotonicity within a symbol is preserved throughout.
 *
 * Then it cross-checks the closed-form figure against a real simulation. They
 * should agree inside the simulation's confidence interval; if they do not, the
 * exact model and the engine have drifted apart and that is a bug, not noise.
 *
 * It prints the calibrated numbers for pasting into `specs.ts` rather than
 * rewriting them: a paytable is a design decision and deserves a human reading it.
 */
import { makeFastRng, simulate } from "@luck-cays/rtp-sim/simulate";
import { toSlotConfig } from "./build.js";
import { exactRtp } from "@luck-cays/shared/slots/exact";
import { themes, type ThemeSpec } from "./specs.js";

interface Args {
  games: string[];
  verifyRounds: number;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const game = get("--game");
  return {
    games: game ? [game] : themes.map((t) => t.slug),
    verifyRounds: Number(get("--verify-rounds") ?? 1_000_000),
    seed: Number(get("--seed") ?? 20_260_401),
  };
}

const TOLERANCE = 0.005;
const BET = 100n;

function rtpOf(spec: ThemeSpec): number {
  return exactRtp(toSlotConfig(spec)).rtp;
}

function snap(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * Premiums, the wild and the scatter get coarse, deliberate-looking numbers. A
 * paytable reading 40/200/1000 looks designed; one reading 41/203/825 looks like
 * the output of a solver.
 */
function tidyRound(value: number): number {
  if (value < 10) return snap(value, 1);
  if (value < 20) return snap(value, 2);
  if (value < 50) return snap(value, 5);
  if (value < 100) return snap(value, 10);
  if (value < 500) return snap(value, 25);
  return snap(value, 50);
}

/**
 * Runs the tuner is allowed to move. The 3-of-a-kind and 4-of-a-kind values on the
 * low symbols are by far the most frequent payers, so they give the finest control
 * per unit; the 5-of-a-kind values are big numbers a player reads as a headline and
 * stay at tidy figures.
 */
const TUNABLE_RUNS = new Set(["3", "4"]);

function scalePays(
  pays: Record<string, number>,
  factor: number,
  round: (v: number) => number,
): Record<string, number> {
  return Object.fromEntries(Object.entries(pays).map(([k, v]) => [k, round(v * factor)]));
}

function rescale(spec: ThemeSpec, globalScale: number): ThemeSpec {
  const paytable: Record<string, Record<string, number>> = {};
  for (const [symbol, pays] of Object.entries(spec.paytable)) {
    paytable[symbol] = scalePays(pays, globalScale, tidyRound);
  }
  return { ...spec, paytable, scatterPays: scalePays(spec.scatterPays, globalScale, tidyRound) };
}

/**
 * A paytable has to read sensibly, not just total correctly:
 *  - a longer run of the same symbol never pays less than a shorter one;
 *  - within the low tier, a higher-ranked symbol never pays less than a lower one
 *    (an Ace paying under a King looks like a bug to a player, because it is one);
 *  - and no low symbol may out-pay the cheapest premium.
 */
function isReadable(spec: ThemeSpec): boolean {
  for (const pays of Object.values(spec.paytable)) {
    const runs = Object.keys(pays)
      .map(Number)
      .sort((a, b) => a - b);
    for (let i = 1; i < runs.length; i++) {
      const previous = pays[String(runs[i - 1])];
      const current = pays[String(runs[i])];
      if (previous !== undefined && current !== undefined && current <= previous) return false;
    }
  }

  // `lowSymbols` is ordered most to least valuable.
  for (let i = 1; i < spec.lowSymbols.length; i++) {
    const higher = spec.paytable[spec.lowSymbols[i - 1] as string];
    const lower = spec.paytable[spec.lowSymbols[i] as string];
    if (!higher || !lower) continue;
    for (const run of Object.keys(lower)) {
      const a = higher[run];
      const b = lower[run];
      if (a !== undefined && b !== undefined && a < b) return false;
    }
  }

  const lows = new Set(spec.lowSymbols);
  const premiums = Object.entries(spec.paytable).filter(([symbol]) => !lows.has(symbol));
  const topLow = spec.paytable[spec.lowSymbols[0] as string];
  if (topLow && premiums.length > 0) {
    for (const run of Object.keys(topLow)) {
      const cheapestPremium = Math.min(
        ...premiums.map(([, pays]) => pays[run] ?? Number.POSITIVE_INFINITY),
      );
      const lowValue = topLow[run];
      if (
        lowValue !== undefined &&
        Number.isFinite(cheapestPremium) &&
        lowValue > cheapestPremium
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Nudge the tunable low-symbol values by +/-1 while that moves RTP closer to target,
 * rejecting any move that makes the paytable unreadable. Because RTP is exact and
 * instant, this converges in a handful of steps.
 */
function coordinateDescent(spec: ThemeSpec, target: number): { spec: ThemeSpec; steps: number } {
  let current = structuredClone(spec);
  let error = Math.abs(rtpOf(current) - target);
  let steps = 0;

  // Least valuable symbols first: they move RTP in the smallest increments, so they
  // get first refusal on any correction.
  const entries: Array<[symbol: string, run: string]> = [];
  for (const symbol of [...spec.lowSymbols].reverse()) {
    for (const run of Object.keys(spec.paytable[symbol] ?? {})) {
      if (TUNABLE_RUNS.has(run)) entries.push([symbol, run]);
    }
  }

  let improved = true;
  while (improved && steps < 500) {
    improved = false;

    for (const [symbol, run] of entries) {
      for (const delta of [-1, 1]) {
        const candidate = structuredClone(current);
        const pays = candidate.paytable[symbol];
        if (!pays) continue;

        const next = (pays[run] ?? 0) + delta;
        if (next < 1) continue;
        pays[run] = next;
        if (!isReadable(candidate)) continue;

        const candidateError = Math.abs(rtpOf(candidate) - target);
        if (candidateError < error - 1e-12) {
          current = candidate;
          error = candidateError;
          improved = true;
          steps++;
          break;
        }
      }
    }
  }

  return { spec: current, steps };
}

const q = (s: string) => JSON.stringify(s);

function payMapSource(pays: Record<string, number>): string {
  return Object.entries(pays)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([count, value]) => `${q(count)}: ${value}`)
    .join(", ");
}

function patchSource(spec: ThemeSpec): string {
  const rows = Object.entries(spec.paytable)
    .map(([symbol, pays]) => `      ${symbol}: { ${payMapSource(pays)} },`)
    .join("\n");
  return [
    "    paytable: {",
    rows,
    "    },",
    `    scatterPays: { ${payMapSource(spec.scatterPays)} },`,
  ].join("\n");
}

const asPct = (n: number) => `${(n * 100).toFixed(3)}%`;
const asPp = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(3)}pp`;

function tune(spec: ThemeSpec, args: Args) {
  const target = spec.rtpTarget;

  const baseline = exactRtp(toSlotConfig(spec));
  console.log(`  baseline (exact)    ${asPct(baseline.rtp)}  (target ${asPct(target)})`);

  const globalScale = target / baseline.rtp;
  let tuned = rescale(spec, globalScale);
  console.log(`  global scale        x${globalScale.toFixed(4)}`);
  console.log(
    `  after rounding      ${asPct(rtpOf(tuned))}  (error ${asPp(rtpOf(tuned) - target)})`,
  );

  const descent = coordinateDescent(tuned, target);
  tuned = descent.spec;

  const final = exactRtp(toSlotConfig(tuned));
  console.log(
    `  after descent       ${asPct(final.rtp)}  (error ${asPp(final.rtp - target)}, ${descent.steps} steps)`,
  );
  console.log(
    `  breakdown           base lines ${asPct(final.lineRtp)}, scatters ${asPct(final.scatterRtp)}, free spins ${asPct(final.freeRtp)}`,
  );
  console.log(
    `  bonus trigger       ${asPct(final.triggerRate)} (1 in ${(1 / final.triggerRate).toFixed(0)}) - exact`,
  );

  // Cross-check the closed form against the engine. Disagreement beyond the CI
  // means the exact model and the engine have drifted - a bug, not noise.
  const measured = simulate(toSlotConfig(tuned), {
    rounds: args.verifyRounds,
    bet: BET,
    rng: makeFastRng(args.seed),
  });
  const drift = measured.rtp - final.rtp;
  const agrees = Math.abs(drift) <= measured.ci95;
  console.log(
    `  sim cross-check     ${asPct(measured.rtp)} +/- ${(measured.ci95 * 100).toFixed(3)}pp over ${args.verifyRounds.toLocaleString()} rounds`,
  );
  console.log(
    `                      exact is ${asPp(-drift)} from the sample mean - ${agrees ? "agrees within CI" : "OUTSIDE CI, investigate"}`,
  );
  // Hit rate and volatility come from the sample: both are frequencies or spreads
  // the closed form cannot give (see the note in exact.ts).
  console.log(
    `  hit rate (sim)      ${asPct(measured.hits / measured.rounds)}   volatility ${measured.stdDev.toFixed(2)}x   biggest round ${(Number(measured.maxRoundWin) / Number(BET)).toFixed(0)}x bet`,
  );
  console.log(
    `  within 0.5%         ${Math.abs(final.rtp - target) <= TOLERANCE ? "YES (exact)" : "NO"}`,
  );

  return { spec: tuned, exact: final.rtp, agrees };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    "Paytable tuner: RTP computed in closed form; simulation used only to cross-check.\n",
  );

  const patches: string[] = [];
  let allAgree = true;

  for (const slug of args.games) {
    const spec = themes.find((t) => t.slug === slug);
    if (!spec) throw new Error(`unknown theme: ${slug}`);

    console.log(`${spec.name} (${slug})`);
    const { spec: tuned, exact, agrees } = tune(spec, args);
    if (!agrees) allAgree = false;
    console.log();

    patches.push(
      [
        `// ${spec.name} (${slug}) - exact RTP ${asPct(exact)} against a ${asPct(spec.rtpTarget)} target`,
        patchSource(tuned),
      ].join("\n"),
    );
  }

  console.log("=".repeat(78));
  console.log("Paste these into tools/slot-gen/src/specs.ts, then:");
  console.log("  npm run generate --workspace @luck-cays/slot-gen");
  console.log("  npm run rtp -- --all --spins 1000000 --write-docs");
  console.log("=".repeat(78));
  console.log();
  console.log(patches.join("\n\n"));

  if (!allAgree) {
    console.error(
      "\nWARNING: a closed-form figure fell outside its simulation CI. Investigate before shipping.",
    );
    process.exitCode = 1;
  }
}

main();
