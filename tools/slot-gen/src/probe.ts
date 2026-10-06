/**
 * Ask "what if" of a game's maths, exactly and instantly.
 *
 *   npm run probe --workspace @luck-cays/slot-gen -- wild-harbour S 3 4 6 8 12
 *
 * Sweeps one symbol's weight across the given values and prints what each does to the
 * trigger rate and the RTP. Because the RTP is closed-form there is no sampling to wait on,
 * so this is a design tool: you can see the cost of a change before committing to it.
 *
 * Weighted games only - a strip game's frequencies come from its symbol counts.
 */
import { exactRtp } from "@luck-cays/shared/slots/exact";
import { toSlotConfig } from "./build.js";
import { getTheme } from "./specs.js";

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

function main(): void {
  const [slug, symbol, ...rawValues] = process.argv.slice(2);
  if (!slug || !symbol || rawValues.length === 0) {
    console.error("usage: probe <game-slug> <symbol> <weight> [weight...]");
    process.exitCode = 1;
    return;
  }

  const spec = getTheme(slug);
  if (!spec.reelWeights) {
    console.error(`${slug} is a strip game; adjust its symbol counts instead of weights`);
    process.exitCode = 1;
    return;
  }

  const baseline = exactRtp(toSlotConfig(spec));

  console.log(`${spec.name}: sweeping the weight of "${symbol}"\n`);
  console.log(
    `  weight   trigger rate      1 in      RTP        delta vs target (${pct(spec.rtpTarget)})`,
  );
  console.log(`  ${"".padEnd(72, "-")}`);

  for (const raw of rawValues) {
    const weight = Number(raw);
    if (!Number.isInteger(weight) || weight < 0) {
      console.error(`  skipping "${raw}": weights are non-negative integers`);
      continue;
    }

    const candidate = structuredClone(spec);
    // Reel 1 often differs deliberately (no wild there), so only the named symbol moves.
    candidate.reelWeights = (candidate.reelWeights ?? []).map((table) => ({
      ...table,
      [symbol]: weight,
    }));

    const r = exactRtp(toSlotConfig(candidate));
    const delta = r.rtp - spec.rtpTarget;
    const marker = weight === (spec.reelWeights[1]?.[symbol] ?? -1) ? "  <- current" : "";

    console.log(
      `  ${String(weight).padStart(6)}   ${pct(r.triggerRate).padStart(12)}   ${(1 / r.triggerRate)
        .toFixed(0)
        .padStart(
          7,
        )}   ${pct(r.rtp).padStart(9)}   ${(delta >= 0 ? "+" : "") + (delta * 100).toFixed(3)}pp${marker}`,
    );
  }

  console.log(
    `\n  Baseline: trigger ${pct(baseline.triggerRate)} (1 in ${(1 / baseline.triggerRate).toFixed(0)}), RTP ${pct(baseline.rtp)}`,
  );
  console.log(
    "  Raising a scatter's weight raises BOTH the trigger rate and the RTP, so a change here",
  );
  console.log("  needs the paytable retuned if the game is to keep its target return.");
}

main();
