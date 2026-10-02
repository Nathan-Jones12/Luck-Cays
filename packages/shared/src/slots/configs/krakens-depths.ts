import type { SlotConfig } from "../types.js";

/**
 * Kraken's Depths - high volatility. Rarer premiums, a far bigger top line.
 *
 * GENERATED FILE - do not edit. Source of truth is `tools/slot-gen/src/specs.ts`;
 * regenerate with `npm run generate --workspace @luck-cays/slot-gen`. The reel
 * strips below are derived from the symbol counts, so hand-editing them makes the
 * composition documented here untrue.
 *
 * Composition per 45-symbol strip:
 *   J 7  Q 7  A 6  K 6  URCHIN 5  JELLYFISH 4  LEVIATHAN 3  SHARK 3  PEARL 2  TENTACLE 2
 *
 * Measured RTP lives in `docs/rtp/krakens-depths.md`. Regenerate it with
 * `npm run rtp -- --game krakens-depths --spins 1000000 --write-docs` after ANY
 * change here, and do not set this game `is_active` until the measured figure is
 * within 0.5% of `rtpTarget`.
 */
export const krakensDepths: SlotConfig = {
  slug: "krakens-depths",
  name: "Kraken's Depths",
  theme: "abyss",

  reels: 5,
  rows: 3,

  symbols: [
    { id: "TENTACLE", name: "Tentacle", kind: "wild" },
    { id: "PEARL", name: "Black Pearl", kind: "scatter" },
    { id: "LEVIATHAN", name: "Leviathan", kind: "normal" },
    { id: "SHARK", name: "Shark", kind: "normal" },
    { id: "JELLYFISH", name: "Jellyfish", kind: "normal" },
    { id: "URCHIN", name: "Urchin", kind: "normal" },
    { id: "A", name: "Ace", kind: "normal" },
    { id: "K", name: "King", kind: "normal" },
    { id: "Q", name: "Queen", kind: "normal" },
    { id: "J", name: "Jack", kind: "normal" },
  ],

  reelStrips: [
    [
      "PEARL", "Q", "J", "Q", "URCHIN", "JELLYFISH", "A", "K",
      "J", "SHARK", "Q", "Q", "K", "URCHIN", "TENTACLE", "LEVIATHAN",
      "JELLYFISH", "A", "J", "Q", "K", "A", "URCHIN", "PEARL",
      "SHARK", "J", "Q", "JELLYFISH", "A", "LEVIATHAN", "K", "URCHIN",
      "J", "Q", "J", "K", "A", "TENTACLE", "JELLYFISH", "SHARK",
      "URCHIN", "J", "K", "A", "LEVIATHAN",
    ],
    [
      "A", "TENTACLE", "JELLYFISH", "SHARK", "URCHIN", "J", "K", "A",
      "LEVIATHAN", "PEARL", "Q", "J", "Q", "URCHIN", "JELLYFISH", "A",
      "K", "J", "SHARK", "Q", "Q", "K", "URCHIN", "TENTACLE",
      "LEVIATHAN", "JELLYFISH", "A", "J", "Q", "K", "A", "URCHIN",
      "PEARL", "SHARK", "J", "Q", "JELLYFISH", "A", "LEVIATHAN", "K",
      "URCHIN", "J", "Q", "J", "K",
    ],
    [
      "A", "LEVIATHAN", "K", "URCHIN", "J", "Q", "J", "K",
      "A", "TENTACLE", "JELLYFISH", "SHARK", "URCHIN", "J", "K", "A",
      "LEVIATHAN", "PEARL", "Q", "J", "Q", "URCHIN", "JELLYFISH", "A",
      "K", "J", "SHARK", "Q", "Q", "K", "URCHIN", "TENTACLE",
      "LEVIATHAN", "JELLYFISH", "A", "J", "Q", "K", "A", "URCHIN",
      "PEARL", "SHARK", "J", "Q", "JELLYFISH",
    ],
    [
      "Q", "K", "A", "URCHIN", "PEARL", "SHARK", "J", "Q",
      "JELLYFISH", "A", "LEVIATHAN", "K", "URCHIN", "J", "Q", "J",
      "K", "A", "TENTACLE", "JELLYFISH", "SHARK", "URCHIN", "J", "K",
      "A", "LEVIATHAN", "PEARL", "Q", "J", "Q", "URCHIN", "JELLYFISH",
      "A", "K", "J", "SHARK", "Q", "Q", "K", "URCHIN",
      "TENTACLE", "LEVIATHAN", "JELLYFISH", "A", "J",
    ],
    [
      "J", "SHARK", "Q", "Q", "K", "URCHIN", "TENTACLE", "LEVIATHAN",
      "JELLYFISH", "A", "J", "Q", "K", "A", "URCHIN", "PEARL",
      "SHARK", "J", "Q", "JELLYFISH", "A", "LEVIATHAN", "K", "URCHIN",
      "J", "Q", "J", "K", "A", "TENTACLE", "JELLYFISH", "SHARK",
      "URCHIN", "J", "K", "A", "LEVIATHAN", "PEARL", "Q", "J",
      "Q", "URCHIN", "JELLYFISH", "A", "K",
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
    TENTACLE: { "3": 35, "4": 225, "5": 1450 },
    LEVIATHAN: { "3": 25, "4": 150, "5": 900 },
    SHARK: { "3": 18, "4": 80, "5": 450 },
    JELLYFISH: { "3": 12, "4": 45, "5": 225 },
    URCHIN: { "3": 9, "4": 25, "5": 125 },
    A: { "3": 7, "4": 17, "5": 90 },
    K: { "3": 6, "4": 13, "5": 70 },
    Q: { "3": 5, "4": 11, "5": 45 },
    J: { "3": 4, "4": 10, "5": 35 },
  },

  wild: { symbol: "TENTACLE", substitutes: true },

  scatter: {
    symbol: "PEARL",
    // Multipliers of the TOTAL bet - scatters pay from anywhere on the grid.
    pays: { "3": 5, "4": 25, "5": 175 },
    freeSpins: { "3": 12, "4": 20, "5": 30 },
    freeSpinMultiplier: 3,
    retrigger: false,
  },

  rtpTarget: 0.955,

  // Every level divides by 20 lines, so a line bet is always whole chips.
  betLevels: [20, 40, 100, 200, 400, 1000, 2000, 5000],
};
