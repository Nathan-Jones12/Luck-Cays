/**
 * Turns a `ThemeSpec` into either a live `SlotConfig` (for the tuner) or TypeScript
 * source (for the generator). Both paths go through `toSlotConfig`, so what the
 * tuner measures is exactly what gets written to disk.
 */
import { slotConfigSchema, type SlotConfig } from "@luck-cays/shared/slots/types";
import type { ThemeSpec } from "./specs.js";

/** 20 fixed lines on a 5x3 window. Row 0 is the top, row 2 the bottom. */
export const PAYLINES_20: number[][] = [
  [1, 1, 1, 1, 1], // 1  middle
  [0, 0, 0, 0, 0], // 2  top
  [2, 2, 2, 2, 2], // 3  bottom
  [0, 1, 2, 1, 0], // 4  V
  [2, 1, 0, 1, 2], // 5  inverted V
  [0, 0, 1, 0, 0], // 6
  [2, 2, 1, 2, 2], // 7
  [1, 0, 0, 0, 1], // 8
  [1, 2, 2, 2, 1], // 9
  [1, 2, 1, 0, 1], // 10
  [1, 0, 1, 2, 1], // 11
  [0, 1, 1, 1, 0], // 12
  [2, 1, 1, 1, 2], // 13
  [0, 1, 0, 1, 0], // 14 zigzag
  [2, 1, 2, 1, 2], // 15 zigzag
  [1, 1, 0, 1, 1], // 16
  [1, 1, 2, 1, 1], // 17
  [0, 0, 1, 2, 2], // 18 descending
  [2, 2, 1, 0, 0], // 19 ascending
  [0, 2, 0, 2, 0], // 20 comb
];

/**
 * Place each symbol at evenly spaced slots, rarest first so wilds and scatters
 * get the cleanest spacing, probing forward when a slot is taken. Deterministic:
 * the same spec always produces the same strips.
 */
export function buildStrip(counts: Record<string, number>, offset: number): string[] {
  const length = Object.values(counts).reduce((a, b) => a + b, 0);
  const slots: Array<string | null> = new Array(length).fill(null);

  const order = Object.entries(counts).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

  let phase = offset;
  for (const [symbol, n] of order) {
    const step = length / n;
    for (let i = 0; i < n; i++) {
      let index = Math.round(phase + i * step) % length;
      let guard = 0;
      while (slots[index] !== null && guard++ < length) index = (index + 1) % length;
      slots[index] = symbol;
    }
    // Shift the phase so different symbols do not line up with each other.
    phase = (phase + step / 2 + 3) % length;
  }

  if (slots.some((s) => s === null)) throw new Error("strip not completely filled");
  return slots as string[];
}

export function buildStrips(spec: ThemeSpec): string[][] {
  const strips = spec.offsets.map((offset) => buildStrip(spec.counts, offset));

  // The documented composition must actually hold on every reel.
  for (const [reel, strip] of strips.entries()) {
    const got = new Map<string, number>();
    for (const symbol of strip) got.set(symbol, (got.get(symbol) ?? 0) + 1);
    for (const [symbol, want] of Object.entries(spec.counts)) {
      const actual = got.get(symbol) ?? 0;
      if (actual !== want) {
        throw new Error(`${spec.slug} reel ${reel}: ${symbol} appears ${actual}x, want ${want}`);
      }
    }
  }

  return strips;
}

export function toSlotConfig(spec: ThemeSpec): SlotConfig {
  return slotConfigSchema.parse({
    slug: spec.slug,
    name: spec.name,
    theme: spec.theme,
    reels: 5,
    rows: 3,
    symbols: spec.symbols,
    reelStrips: buildStrips(spec),
    paylines: PAYLINES_20,
    paytable: spec.paytable,
    wild: { symbol: spec.wild, substitutes: true },
    scatter: {
      symbol: spec.scatter,
      pays: spec.scatterPays,
      freeSpins: spec.freeSpins,
      freeSpinMultiplier: spec.freeSpinMultiplier,
      retrigger: spec.retrigger,
    },
    rtpTarget: spec.rtpTarget,
    betLevels: spec.betLevels,
  });
}

const q = (s: string) => JSON.stringify(s);

function stripSource(strips: string[][]): string {
  return strips
    .map((strip) => {
      const rows: string[] = [];
      for (let i = 0; i < strip.length; i += 8) {
        rows.push(
          "      " +
            strip
              .slice(i, i + 8)
              .map(q)
              .join(", ") +
            ",",
        );
      }
      return "    [\n" + rows.join("\n") + "\n    ],";
    })
    .join("\n");
}

function payMap(pays: Record<string, number>): string {
  return Object.entries(pays)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([count, value]) => `${q(count)}: ${value}`)
    .join(", ");
}

/** Emit the generated TypeScript module for one theme. */
export function emitSource(spec: ThemeSpec): string {
  const strips = buildStrips(spec);
  const stripLength = strips[0]?.length ?? 0;

  const symbolsSource = spec.symbols
    .map((s) => `    { id: ${q(s.id)}, name: ${q(s.name)}, kind: ${q(s.kind)} },`)
    .join("\n");

  const paytableSource = Object.entries(spec.paytable)
    .map(([symbol, pays]) => `    ${symbol}: { ${payMap(pays)} },`)
    .join("\n");

  const linesSource = PAYLINES_20.map((line, i) => `    [${line.join(", ")}], // ${i + 1}`).join(
    "\n",
  );

  const composition = Object.entries(spec.counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([symbol, n]) => `${symbol} ${n}`)
    .join("  ");

  return `import type { SlotConfig } from "../types.js";

/**
 * ${spec.name} - ${spec.blurb}
 *
 * GENERATED FILE - do not edit. Source of truth is \`tools/slot-gen/src/specs.ts\`;
 * regenerate with \`npm run generate --workspace @luck-cays/slot-gen\`. The reel
 * strips below are derived from the symbol counts, so hand-editing them makes the
 * composition documented here untrue.
 *
 * Composition per ${stripLength}-symbol strip:
 *   ${composition}
 *
 * Measured RTP lives in \`docs/rtp/${spec.slug}.md\`. Regenerate it with
 * \`npm run rtp -- --game ${spec.slug} --spins 1000000 --write-docs\` after ANY
 * change here, and do not set this game \`is_active\` until the measured figure is
 * within 0.5% of \`rtpTarget\`.
 */
export const ${spec.varName}: SlotConfig = {
  slug: ${q(spec.slug)},
  name: ${q(spec.name)},
  theme: ${q(spec.theme)},

  reels: 5,
  rows: 3,

  symbols: [
${symbolsSource}
  ],

  reelStrips: [
${stripSource(strips)}
  ],

  // 20 fixed lines. Row 0 is the top of the window, row 2 the bottom.
  paylines: [
${linesSource}
  ],

  // Multipliers of the LINE bet (total bet / 20), paid left to right.
  paytable: {
${paytableSource}
  },

  wild: { symbol: ${q(spec.wild)}, substitutes: true },

  scatter: {
    symbol: ${q(spec.scatter)},
    // Multipliers of the TOTAL bet - scatters pay from anywhere on the grid.
    pays: { ${payMap(spec.scatterPays)} },
    freeSpins: { ${payMap(spec.freeSpins)} },
    freeSpinMultiplier: ${spec.freeSpinMultiplier},
    retrigger: ${spec.retrigger},
  },

  rtpTarget: ${spec.rtpTarget},

  // Every level divides by 20 lines, so a line bet is always whole chips.
  betLevels: [${spec.betLevels.join(", ")}],
};
`;
}
