import type { SlotConfig } from "../types.js";

/**
 * Reef Riches - the launch slot. Medium volatility, 20 fixed lines.
 *
 * GENERATED FILE - do not edit. Source of truth is `tools/slot-gen/src/specs.ts`;
 * regenerate with `npm run generate --workspace @luck-cays/slot-gen`. The reel data below is
 * derived from the spec, so hand-editing it makes the composition documented here untrue.
 *
 * Composition per 40-symbol strip:
 *   J 6  Q 6  A 5  K 5  ANCHOR 4  COMPASS 4  PARROT 3  SHIP 3  CHEST 2  KRAKEN 2
 *
 * Measured RTP lives in `docs/rtp/reef-riches.md`. Regenerate it with
 * `npm run rtp -- --game reef-riches --spins 1000000 --write-docs` after ANY change here,
 * and do not set this game `is_active` until the exact figure is within 0.5% of `rtpTarget`.
 */
export const reefRiches: SlotConfig = {
  slug: "reef-riches",
  name: "Reef Riches",
  theme: "caribbean",

  reels: 5,
  rows: 3,

  symbols: [
    { id: "KRAKEN", name: "Kraken", kind: "wild" },
    { id: "CHEST", name: "Treasure Chest", kind: "scatter" },
    { id: "SHIP", name: "Galleon", kind: "normal" },
    { id: "PARROT", name: "Parrot", kind: "normal" },
    { id: "COMPASS", name: "Compass", kind: "normal" },
    { id: "ANCHOR", name: "Anchor", kind: "normal" },
    { id: "A", name: "Ace", kind: "normal" },
    { id: "K", name: "King", kind: "normal" },
    { id: "Q", name: "Queen", kind: "normal" },
    { id: "J", name: "Jack", kind: "normal" },
  ],

  reelStrips: [
    [
      "CHEST", "J", "J", "COMPASS", "K", "ANCHOR", "A", "Q",
      "Q", "SHIP", "J", "Q", "K", "KRAKEN", "PARROT", "ANCHOR",
      "COMPASS", "A", "J", "Q", "CHEST", "A", "SHIP", "COMPASS",
      "K", "ANCHOR", "PARROT", "J", "K", "A", "J", "Q",
      "Q", "KRAKEN", "COMPASS", "ANCHOR", "SHIP", "A", "K", "PARROT",
    ],
    [
      "KRAKEN", "COMPASS", "ANCHOR", "SHIP", "A", "K", "PARROT", "CHEST",
      "J", "J", "COMPASS", "K", "ANCHOR", "A", "Q", "Q",
      "SHIP", "J", "Q", "K", "KRAKEN", "PARROT", "ANCHOR", "COMPASS",
      "A", "J", "Q", "CHEST", "A", "SHIP", "COMPASS", "K",
      "ANCHOR", "PARROT", "J", "K", "A", "J", "Q", "Q",
    ],
    [
      "J", "K", "A", "J", "Q", "Q", "KRAKEN", "COMPASS",
      "ANCHOR", "SHIP", "A", "K", "PARROT", "CHEST", "J", "J",
      "COMPASS", "K", "ANCHOR", "A", "Q", "Q", "SHIP", "J",
      "Q", "K", "KRAKEN", "PARROT", "ANCHOR", "COMPASS", "A", "J",
      "Q", "CHEST", "A", "SHIP", "COMPASS", "K", "ANCHOR", "PARROT",
    ],
    [
      "A", "J", "Q", "CHEST", "A", "SHIP", "COMPASS", "K",
      "ANCHOR", "PARROT", "J", "K", "A", "J", "Q", "Q",
      "KRAKEN", "COMPASS", "ANCHOR", "SHIP", "A", "K", "PARROT", "CHEST",
      "J", "J", "COMPASS", "K", "ANCHOR", "A", "Q", "Q",
      "SHIP", "J", "Q", "K", "KRAKEN", "PARROT", "ANCHOR", "COMPASS",
    ],
    [
      "SHIP", "J", "Q", "K", "KRAKEN", "PARROT", "ANCHOR", "COMPASS",
      "A", "J", "Q", "CHEST", "A", "SHIP", "COMPASS", "K",
      "ANCHOR", "PARROT", "J", "K", "A", "J", "Q", "Q",
      "KRAKEN", "COMPASS", "ANCHOR", "SHIP", "A", "K", "PARROT", "CHEST",
      "J", "J", "COMPASS", "K", "ANCHOR", "A", "Q", "Q",
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
    KRAKEN: { "3": 30, "4": 175, "5": 800 },
    SHIP: { "3": 20, "4": 100, "5": 500 },
    PARROT: { "3": 16, "4": 60, "5": 300 },
    COMPASS: { "3": 12, "4": 40, "5": 200 },
    ANCHOR: { "3": 10, "4": 30, "5": 150 },
    A: { "3": 8, "4": 21, "5": 100 },
    K: { "3": 6, "4": 17, "5": 80 },
    Q: { "3": 5, "4": 13, "5": 50 },
    J: { "3": 4, "4": 11, "5": 40 },
  },

  wild: { symbol: "KRAKEN", substitutes: true },

  scatter: {
    symbol: "CHEST",
    // Multipliers of the TOTAL bet - scatters pay from anywhere on the grid.
    pays: { "3": 4, "4": 20, "5": 100 },
    freeSpins: { "3": 10, "4": 15, "5": 25 },
    freeSpinMultiplier: 2,
    retrigger: false,
  },

  rtpTarget: 0.96,

  // Every level divides by 20 lines, so a line bet is always whole chips.
  betLevels: [20, 40, 100, 200, 400, 1000, 2000, 5000],
};
