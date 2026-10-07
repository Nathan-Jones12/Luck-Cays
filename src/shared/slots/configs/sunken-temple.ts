import type { SlotConfig } from "../types.js";

/**
 * Sunken Temple - low volatility. Frequent small wins, an extra wild, a modest top line.
 *
 * GENERATED FILE - do not edit. Source of truth is `tools/slot-gen/src/specs.ts`;
 * regenerate with `npm run generate --workspace @luck-cays/slot-gen`. The reel data below is
 * derived from the spec, so hand-editing it makes the composition documented here untrue.
 *
 * Composition per 39-symbol strip:
 *   A 5  J 5  K 5  Q 5  BRAZIER 4  URN 4  IDOL 3  MASK 3  SERPENT 3  GLYPH 2
 *
 * Measured RTP lives in `docs/rtp/sunken-temple.md`. Regenerate it with
 * `npm run rtp -- --game sunken-temple --spins 1000000 --write-docs` after ANY change here,
 * and do not set this game `is_active` until the exact figure is within 0.5% of `rtpTarget`.
 */
export const sunkenTemple: SlotConfig = {
  slug: "sunken-temple",
  name: "Sunken Temple",
  theme: "temple",

  reels: 5,
  rows: 3,

  symbols: [
    { id: "IDOL", name: "Golden Idol", kind: "wild" },
    { id: "GLYPH", name: "Glyph Stone", kind: "scatter" },
    { id: "SERPENT", name: "Serpent", kind: "normal" },
    { id: "MASK", name: "Jade Mask", kind: "normal" },
    { id: "BRAZIER", name: "Brazier", kind: "normal" },
    { id: "URN", name: "Urn", kind: "normal" },
    { id: "A", name: "Ace", kind: "normal" },
    { id: "K", name: "King", kind: "normal" },
    { id: "Q", name: "Queen", kind: "normal" },
    { id: "J", name: "Jack", kind: "normal" },
  ],

  reelStrips: [
    [
      "GLYPH", "IDOL", "BRAZIER", "URN", "A", "J", "SERPENT", "K",
      "K", "MASK", "URN", "A", "BRAZIER", "IDOL", "J", "Q",
      "K", "J", "A", "SERPENT", "GLYPH", "URN", "MASK", "BRAZIER",
      "K", "J", "IDOL", "A", "Q", "Q", "URN", "Q",
      "SERPENT", "BRAZIER", "A", "MASK", "J", "K", "Q",
    ],
    [
      "BRAZIER", "A", "MASK", "J", "K", "Q", "GLYPH", "IDOL",
      "BRAZIER", "URN", "A", "J", "SERPENT", "K", "K", "MASK",
      "URN", "A", "BRAZIER", "IDOL", "J", "Q", "K", "J",
      "A", "SERPENT", "GLYPH", "URN", "MASK", "BRAZIER", "K", "J",
      "IDOL", "A", "Q", "Q", "URN", "Q", "SERPENT",
    ],
    [
      "J", "IDOL", "A", "Q", "Q", "URN", "Q", "SERPENT",
      "BRAZIER", "A", "MASK", "J", "K", "Q", "GLYPH", "IDOL",
      "BRAZIER", "URN", "A", "J", "SERPENT", "K", "K", "MASK",
      "URN", "A", "BRAZIER", "IDOL", "J", "Q", "K", "J",
      "A", "SERPENT", "GLYPH", "URN", "MASK", "BRAZIER", "K",
    ],
    [
      "A", "SERPENT", "GLYPH", "URN", "MASK", "BRAZIER", "K", "J",
      "IDOL", "A", "Q", "Q", "URN", "Q", "SERPENT", "BRAZIER",
      "A", "MASK", "J", "K", "Q", "GLYPH", "IDOL", "BRAZIER",
      "URN", "A", "J", "SERPENT", "K", "K", "MASK", "URN",
      "A", "BRAZIER", "IDOL", "J", "Q", "K", "J",
    ],
    [
      "URN", "A", "BRAZIER", "IDOL", "J", "Q", "K", "J",
      "A", "SERPENT", "GLYPH", "URN", "MASK", "BRAZIER", "K", "J",
      "IDOL", "A", "Q", "Q", "URN", "Q", "SERPENT", "BRAZIER",
      "A", "MASK", "J", "K", "Q", "GLYPH", "IDOL", "BRAZIER",
      "URN", "A", "J", "SERPENT", "K", "K", "MASK",
    ],
  ],

  // 20 fixed lines. Row 0 is the top of the window, row 2 the bottom.
  paylines: [
    [1, 1, 1, 1, 1], // 1
    [0, 0, 0, 0, 0], // 2
    [2, 2, 2, 2, 2], // 3
    [0, 1, 2, 1, 0], // 4
    [2, 1, 0, 1, 2], // 5
    [0, 0, 1, 0, 0], // 6
    [2, 2, 1, 2, 2], // 7
    [1, 0, 0, 0, 1], // 8
    [1, 2, 2, 2, 1], // 9
    [1, 2, 1, 0, 1], // 10
    [1, 0, 1, 2, 1], // 11
    [0, 1, 1, 1, 0], // 12
    [2, 1, 1, 1, 2], // 13
    [0, 1, 0, 1, 0], // 14
    [2, 1, 2, 1, 2], // 15
    [1, 1, 0, 1, 1], // 16
    [1, 1, 2, 1, 1], // 17
    [0, 0, 1, 2, 2], // 18
    [2, 2, 1, 0, 0], // 19
    [0, 2, 0, 2, 0], // 20
  ],

  // Multipliers of the LINE bet (total bet / 20), paid left to right.
  paytable: {
    IDOL: { "3": 16, "4": 70, "5": 250 },
    SERPENT: { "3": 14, "4": 50, "5": 200 },
    MASK: { "3": 10, "4": 35, "5": 150 },
    BRAZIER: { "3": 9, "4": 25, "5": 100 },
    URN: { "3": 7, "4": 20, "5": 80 },
    A: { "3": 5, "4": 16, "5": 60 },
    K: { "3": 5, "4": 13, "5": 50 },
    Q: { "3": 4, "4": 9, "5": 35 },
    J: { "3": 3, "4": 8, "5": 30 },
  },

  wild: { symbol: "IDOL", substitutes: true },

  scatter: {
    symbol: "GLYPH",
    // Multipliers of the TOTAL bet - scatters pay from anywhere on the grid.
    pays: { "3": 4, "4": 14, "5": 50 },
    freeSpins: { "3": 8, "4": 12, "5": 18 },
    freeSpinMultiplier: 2,
    retrigger: false,
  },

  rtpTarget: 0.965,

  // Every level divides by 20 lines, so a line bet is always whole chips.
  betLevels: [20, 40, 100, 200, 400, 1000, 2000, 5000],
};
