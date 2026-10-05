/**
 * Exact RTP breakdown for every game, straight from the closed-form maths.
 *
 *   npm run exact --workspace @luck-cays/slot-gen
 *
 * No simulation and no sampling, so it finishes instantly. Use this while designing a game -
 * change a weight or a payout in `specs.ts` and see the effect immediately, rather than waiting
 * on a million rounds that could not resolve the difference anyway.
 *
 * `tools/rtp-sim` remains the thing that corroborates these figures against the live engine.
 */
import { exactRtp } from "@luck-cays/shared/slots/exact";
import { reelModel } from "@luck-cays/shared/slots/engine";
import { toSlotConfig } from "./build.js";
import { themes } from "./specs.js";

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
const pp = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(3)}pp`;
const TOLERANCE = 0.005;

function main(): void {
  const wanted = process.argv[2];
  const selected = wanted ? themes.filter((theme) => theme.slug === wanted) : themes;

  if (selected.length === 0) {
    console.error(`no such game: ${wanted}`);
    process.exitCode = 1;
    return;
  }

  let allWithinTolerance = true;

  for (const theme of selected) {
    const config = toSlotConfig(theme);
    const r = exactRtp(config);
    const delta = r.rtp - config.rtpTarget;
    const within = Math.abs(delta) <= TOLERANCE;
    if (!within) allWithinTolerance = false;

    console.log(`${config.name}  (${config.slug}, ${reelModel(config)} reels)`);
    console.log(`  base lines        ${pct(r.lineRtp)}`);
    console.log(`  scatter pays      ${pct(r.scatterRtp)}`);
    if (config.coin) {
      console.log(
        `  coin feature      ${pct(r.coinRtp)}   (pays ${pct(r.coinHitRate)} of spins, 1 in ${(1 / r.coinHitRate).toFixed(0)})`,
      );
    }
    console.log(`  free spin rounds  ${pct(r.freeRtp)}`);
    console.log(`  ${"".padEnd(44, "-")}`);
    console.log(
      `  TOTAL RTP         ${pct(r.rtp)}   target ${pct(config.rtpTarget)}, delta ${pp(delta)}  ${within ? "OK" : "OUT OF TOLERANCE"}`,
    );
    console.log(
      `  bonus trigger     ${pct(r.triggerRate)} (1 in ${(1 / r.triggerRate).toFixed(0)}), ${r.freeSpinsPerSpin.toFixed(4)} free spins per spin`,
    );
    console.log();
  }

  if (!allWithinTolerance) {
    console.error("At least one game is outside the 0.5% tolerance and must not be set active.");
    process.exitCode = 1;
  }
}

main();
