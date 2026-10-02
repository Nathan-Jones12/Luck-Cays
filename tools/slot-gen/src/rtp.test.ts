/**
 * The RTP gate.
 *
 * The PRD's rule is that a game may not go live until its return-to-player is within 0.5% of
 * target. Enforcing that with a million-round simulation would make CI slow AND wrong: on a
 * high-volatility game, a million rounds still swings most of a percentage point between seeds,
 * which is wider than the tolerance being checked.
 *
 * So the gate is the closed-form figure from `exact.ts` - no sampling, no confidence interval,
 * and it runs in milliseconds. The simulator still exists, and `tools/rtp-sim` cross-checks the
 * two agree; what it cannot do is certify a tolerance finer than its own noise.
 */
import { describe, expect, it } from "vitest";
import { toSlotConfig } from "./build.js";
import { exactRtp } from "@luck-cays/shared/slots/exact";
import { themes } from "./specs.js";

const TOLERANCE = 0.005;

describe("return to player", () => {
  for (const theme of themes) {
    describe(theme.name, () => {
      const config = toSlotConfig(theme);
      const result = exactRtp(config);

      it(`is within 0.5% of its ${(theme.rtpTarget * 100).toFixed(1)}% target`, () => {
        const delta = result.rtp - theme.rtpTarget;
        expect(
          Math.abs(delta),
          `${theme.slug}: exact RTP ${(result.rtp * 100).toFixed(3)}% against a target of ${(
            theme.rtpTarget * 100
          ).toFixed(1)}% (off by ${(delta * 100).toFixed(3)}pp). Re-run the tuner.`,
        ).toBeLessThanOrEqual(TOLERANCE);
      });

      it("never pays more than it takes", () => {
        // A game above 100% is not a bug in the maths - it is a bug in the design, and it would
        // drain the chip supply.
        expect(result.rtp).toBeLessThan(1);
      });

      it("splits its return between base play and the bonus", () => {
        // A game that pays everything in the base game has a pointless bonus; one that pays
        // everything in the bonus is miserable until it triggers.
        expect(result.lineRtp).toBeGreaterThan(0);
        expect(result.freeRtp).toBeGreaterThan(0);
        expect(result.freeRtp / result.rtp).toBeLessThan(0.7);
      });

      it("triggers its bonus often enough to matter", () => {
        // Roughly between 1 in 20 and 1 in 400 rounds. Rarer than that and most sessions never
        // see the feature the game is built around.
        expect(result.triggerRate).toBeGreaterThan(0.0025);
        expect(result.triggerRate).toBeLessThan(0.05);
      });
    });
  }

  it("keeps the three games meaningfully different from each other", () => {
    // Otherwise there is no reason for a player to pick one over another.
    const rtps = themes.map((theme) => exactRtp(toSlotConfig(theme)).rtp);
    expect(new Set(rtps.map((rtp) => rtp.toFixed(4))).size).toBe(themes.length);
  });
});

describe("the generated configs match the specs", () => {
  for (const theme of themes) {
    it(`${theme.slug} builds reel strips with the documented composition`, () => {
      const config = toSlotConfig(theme);
      const expectedLength = Object.values(theme.counts).reduce((a, b) => a + b, 0);

      for (const strip of config.reelStrips) {
        expect(strip).toHaveLength(expectedLength);

        const counts = new Map<string, number>();
        for (const symbol of strip) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);

        for (const [symbol, want] of Object.entries(theme.counts)) {
          expect(counts.get(symbol), `${theme.slug} ${symbol}`).toBe(want);
        }
      }
    });

    it(`${theme.slug} never shows two scatters on one reel`, () => {
      // The exact scatter maths is general enough to handle it, but the game design assumes one
      // scatter per reel at most - two would change the trigger rate the tuner solved against.
      const config = toSlotConfig(theme);

      for (const strip of config.reelStrips) {
        for (let stop = 0; stop < strip.length; stop++) {
          let inWindow = 0;
          for (let row = 0; row < config.rows; row++) {
            if (strip[(stop + row) % strip.length] === config.scatter.symbol) inWindow++;
          }
          expect(
            inWindow,
            `${theme.slug} stop ${stop} shows ${inWindow} scatters`,
          ).toBeLessThanOrEqual(1);
        }
      }
    });
  }
});
