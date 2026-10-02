/**
 * Rewrites `packages/shared/src/slots/configs/*.ts` from the specs.
 *
 *   npm run generate --workspace @luck-cays/slot-gen
 *
 * Every config is validated through `slotConfigSchema` before it is written, so a
 * broken spec fails here rather than at spin time.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitSource, toSlotConfig } from "./build.js";
import { themes } from "./specs.js";

const OUT_DIR = resolve(import.meta.dirname, "../../../packages/shared/src/slots/configs");

function main(): void {
  for (const spec of themes) {
    // Parse first: no point writing a file that would fail at startup.
    const config = toSlotConfig(spec);
    const out = resolve(OUT_DIR, `${spec.slug}.ts`);
    writeFileSync(out, emitSource(spec));
    console.log(
      `wrote ${spec.slug}.ts  (${config.reelStrips[0]?.length ?? 0}-symbol strips, ${config.paylines.length} lines, target ${(config.rtpTarget * 100).toFixed(1)}%)`,
    );
  }
  console.log(`\n${themes.length} configs written to packages/shared/src/slots/configs`);
}

main();
