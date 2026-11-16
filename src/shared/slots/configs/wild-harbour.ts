import type { SlotConfig } from "../types.js";

/**
 * 242 Wild Harbour - weighted reels and a coin-collect feature. Ported from the original HTML build.
 *
 * GENERATED FILE - do not edit. Source of truth is `tools/slot-gen/src/specs.ts`;
 * regenerate with `npm run generate --workspace @luck-cays/slot-gen`. The reel data below is
 * derived from the spec, so hand-editing it makes the composition documented here untrue.
 *
 * Per-reel weights:
 *   reel 1: H 28  P 26  F 20  C 16  M 10  S 3  G 9
 *   reel 2: H 28  P 26  F 20  C 16  M 10  W 7  S 3  G 9
 *   reel 3: H 28  P 26  F 20  C 16  M 10  W 7  S 3  G 9
 *   reel 4: H 28  P 26  F 20  C 16  M 10  W 7  S 3  G 9
 *   reel 5: H 28  P 26  F 20  C 16  M 10  W 7  S 3  G 9
 *
 * Measured RTP lives in `docs/rtp/wild-harbour.md`. Regenerate it with
 * `npm run rtp -- --game wild-harbour --spins 1000000 --write-docs` after ANY change here,
 * and do not set this game `is_active` until the exact figure is within 0.5% of `rtpTarget`.
 */
export const wildHarbour: SlotConfig = {
  slug: "wild-harbour",
  name: "242 Wild Harbour",
  theme: "harbour",

  reels: 5,
  rows: 3,

  symbols: [
    { id: "W", name: "242 Wild", kind: "wild" },
    { id: "S", name: "Scatter", kind: "scatter" },
    { id: "G", name: "242 Coin", kind: "normal" },
    { id: "M", name: "Blue marlin", kind: "normal" },
    { id: "C", name: "Conch", kind: "normal" },
    { id: "F", name: "Flamingo", kind: "normal" },
    { id: "P", name: "Golden palm", kind: "normal" },
    { id: "H", name: "Hibiscus", kind: "normal" },
  ],

  // Weighted reels: every visible cell is drawn independently from its reel's table,
  // so rows are uncorrelated and a symbol can appear more than once on one reel.
  reelWeights: [
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 0, S: 3, G: 9 },
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 7, S: 3, G: 9 },
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 7, S: 3, G: 9 },
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 7, S: 3, G: 9 },
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 7, S: 3, G: 9 },
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
    W: { "3": 50, "4": 200, "5": 1000 },
    M: { "3": 25, "4": 80, "5": 250 },
    C: { "3": 15, "4": 40, "5": 100 },
    F: { "3": 10, "4": 30, "5": 80 },
    P: { "3": 5, "4": 20, "5": 50 },
    H: { "3": 5, "4": 15, "5": 40 },
  },

  wild: { symbol: "W", substitutes: true },

  scatter: {
    symbol: "S",
    // Multipliers of the TOTAL bet - scatters pay from anywhere on the grid.
    pays: { "3": 2, "4": 10, "5": 50 },
    freeSpins: { "3": 8, "4": 10, "5": 12 },
    freeSpinMultiplier: 2,
    retrigger: false,
  },

  coin: {
    symbol: "G",
    // Each coin draws its own value, as a multiple of the TOTAL bet.
    values: [
      { value: 1, weight: 40 },
      { value: 2, weight: 25 },
      { value: 3, weight: 15 },
      { value: 5, weight: 10 },
      { value: 10, weight: 6 },
      { value: 25, weight: 3 },
      { value: 100, weight: 1 },
    ],
    // Coins are decoration below this many - the feature is all or nothing.
    needed: 5,
  },

  rtpTarget: 0.9556,

  // Every level divides by 20 lines, so a line bet is always whole chips.
  betLevels: [20, 40, 100, 200, 400, 1000, 2000, 5000],
};
