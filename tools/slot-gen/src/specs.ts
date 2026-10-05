/**
 * Slot game specs - the human-editable source for the generated configs in
 * `packages/shared/src/slots/configs`.
 *
 * Edit here, then regenerate and recalibrate:
 *
 *   npm run generate --workspace @luck-cays/slot-gen   # rewrite the configs
 *   npm run tune --workspace @luck-cays/slot-gen       # solve paytables for rtpTarget
 *
 * Never hand-edit a generated config: the reel strips there are produced from
 * `counts` below, so editing them makes the documented symbol composition a lie.
 *
 * Paytable values are multipliers. Line symbols pay `multiplier x line bet`
 * (total bet / 20); scatters pay `multiplier x total bet`. Because every payout
 * is linear in these numbers, RTP is linear in a global paytable scale - which is
 * exactly what `tune.ts` exploits.
 */
import type { SymbolKind } from "@luck-cays/shared/slots/types";

export interface ThemeSpec {
  /** Exported binding name in the generated file. */
  varName: string;
  slug: string;
  name: string;
  theme: string;
  /** One line for the generated file's doc comment. */
  blurb: string;

  wild: string;
  scatter: string;
  symbols: Array<{ id: string; name: string; kind: SymbolKind }>;

  /**
   * Symbol counts per reel strip. The sum is the strip length.
   * Present for a strip game; omitted for a weighted one.
   */
  counts?: Record<string, number>;
  /** Starting phase per reel, so the five strips are not rotations of each other. */
  offsets?: number[];

  /**
   * Per-reel symbol weights, for a weighted game. Every visible cell is drawn independently.
   * Supply this OR `counts`, never both.
   */
  reelWeights?: Array<Record<string, number>>;

  /** The coin feature, for games that have one. */
  coin?: {
    symbol: string;
    values: Array<{ value: number; weight: number }>;
    needed: number;
  };

  /**
   * The low-value symbols. They are the most frequent payers, so the tuner trims
   * these for fine RTP control once the premiums are at tidy round numbers.
   */
  lowSymbols: string[];

  /** symbolId -> run length -> multiplier of the line bet. */
  paytable: Record<string, Record<string, number>>;
  /** scatter count -> multiplier of the total bet. */
  scatterPays: Record<string, number>;
  /** scatter count -> free spins awarded. */
  freeSpins: Record<string, number>;
  freeSpinMultiplier: number;
  retrigger: boolean;

  rtpTarget: number;
  betLevels: number[];
}

const LOWS = ["A", "K", "Q", "J"];

const CARD_SYMBOLS: Array<{ id: string; name: string; kind: SymbolKind }> = [
  { id: "A", name: "Ace", kind: "normal" },
  { id: "K", name: "King", kind: "normal" },
  { id: "Q", name: "Queen", kind: "normal" },
  { id: "J", name: "Jack", kind: "normal" },
];

/** Bet levels are shared: every one divides by 20 lines, so line bets stay whole. */
const BET_LEVELS = [20, 40, 100, 200, 400, 1000, 2000, 5000];

export const themes: ThemeSpec[] = [
  {
    varName: "reefRiches",
    slug: "reef-riches",
    name: "Reef Riches",
    theme: "caribbean",
    blurb: "the launch slot. Medium volatility, 20 fixed lines.",
    wild: "KRAKEN",
    scatter: "CHEST",
    symbols: [
      { id: "KRAKEN", name: "Kraken", kind: "wild" },
      { id: "CHEST", name: "Treasure Chest", kind: "scatter" },
      { id: "SHIP", name: "Galleon", kind: "normal" },
      { id: "PARROT", name: "Parrot", kind: "normal" },
      { id: "COMPASS", name: "Compass", kind: "normal" },
      { id: "ANCHOR", name: "Anchor", kind: "normal" },
      ...CARD_SYMBOLS,
    ],
    counts: {
      J: 6,
      Q: 6,
      K: 5,
      A: 5,
      ANCHOR: 4,
      COMPASS: 4,
      PARROT: 3,
      SHIP: 3,
      KRAKEN: 2,
      CHEST: 2,
    },
    offsets: [0, 7, 13, 23, 31],
    lowSymbols: LOWS,
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
    scatterPays: { "3": 4, "4": 20, "5": 100 },
    freeSpins: { "3": 10, "4": 15, "5": 25 },
    freeSpinMultiplier: 2,
    retrigger: false,
    rtpTarget: 0.96,
    betLevels: BET_LEVELS,
  },
  {
    varName: "krakensDepths",
    slug: "krakens-depths",
    name: "Kraken's Depths",
    theme: "abyss",
    blurb: "high volatility. Rarer premiums, a far bigger top line.",
    wild: "TENTACLE",
    scatter: "PEARL",
    symbols: [
      { id: "TENTACLE", name: "Tentacle", kind: "wild" },
      { id: "PEARL", name: "Black Pearl", kind: "scatter" },
      { id: "LEVIATHAN", name: "Leviathan", kind: "normal" },
      { id: "SHARK", name: "Shark", kind: "normal" },
      { id: "JELLYFISH", name: "Jellyfish", kind: "normal" },
      { id: "URCHIN", name: "Urchin", kind: "normal" },
      ...CARD_SYMBOLS,
    ],
    counts: {
      J: 7,
      Q: 7,
      K: 6,
      A: 6,
      URCHIN: 5,
      JELLYFISH: 4,
      SHARK: 3,
      LEVIATHAN: 3,
      TENTACLE: 2,
      PEARL: 2,
    },
    offsets: [0, 9, 17, 26, 37],
    lowSymbols: LOWS,
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
    scatterPays: { "3": 5, "4": 25, "5": 175 },
    freeSpins: { "3": 12, "4": 20, "5": 30 },
    freeSpinMultiplier: 3,
    retrigger: false,
    rtpTarget: 0.955,
    betLevels: BET_LEVELS,
  },
  {
    varName: "sunkenTemple",
    slug: "sunken-temple",
    name: "Sunken Temple",
    theme: "temple",
    blurb: "low volatility. Frequent small wins, an extra wild, a modest top line.",
    wild: "IDOL",
    scatter: "GLYPH",
    symbols: [
      { id: "IDOL", name: "Golden Idol", kind: "wild" },
      { id: "GLYPH", name: "Glyph Stone", kind: "scatter" },
      { id: "SERPENT", name: "Serpent", kind: "normal" },
      { id: "MASK", name: "Jade Mask", kind: "normal" },
      { id: "BRAZIER", name: "Brazier", kind: "normal" },
      { id: "URN", name: "Urn", kind: "normal" },
      ...CARD_SYMBOLS,
    ],
    counts: { J: 5, Q: 5, K: 5, A: 5, URN: 4, BRAZIER: 4, MASK: 3, SERPENT: 3, IDOL: 3, GLYPH: 2 },
    offsets: [0, 6, 14, 21, 29],
    lowSymbols: LOWS,
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
    scatterPays: { "3": 4, "4": 14, "5": 50 },
    freeSpins: { "3": 8, "4": 12, "5": 18 },
    freeSpinMultiplier: 2,
    retrigger: false,
    rtpTarget: 0.965,
    betLevels: BET_LEVELS,
  },
];

/**
 * 242 Wild Harbour. Ported from a self-contained HTML build we own the rights to.
 *
 * Two things make this unlike the other three, and both come straight from the original rather
 * than being choices made here:
 *
 *  - WEIGHTED REELS. Every visible cell is drawn independently from a per-reel weight table,
 *    not from a strip with a single stop. No wild on reel 1 (`W: 0`), which is the usual way to
 *    stop five-wild lines being too common.
 *  - A COIN FEATURE. Coins carry their own weighted value, and pay nothing at all unless five
 *    or more land. Below the threshold they are decoration.
 *
 * The line pays, weights, coin table, scatter pays and free-spin counts below are the
 * original's numbers exactly. `rtpTarget` is the measured figure, not an aspiration - see the
 * note where it is set.
 */
const wildHarbour: ThemeSpec = {
  varName: "wildHarbour",
  slug: "wild-harbour",
  name: "242 Wild Harbour",
  theme: "harbour",
  blurb: "weighted reels and a coin-collect feature. Ported from the original HTML build.",

  wild: "W",
  scatter: "S",

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

  // Reel 1 carries no wild, exactly as the original.
  reelWeights: [
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 0, S: 3, G: 9 },
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 7, S: 3, G: 9 },
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 7, S: 3, G: 9 },
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 7, S: 3, G: 9 },
    { H: 28, P: 26, F: 20, C: 16, M: 10, W: 7, S: 3, G: 9 },
  ],

  lowSymbols: ["C", "F", "P", "H"],

  paytable: {
    W: { "3": 50, "4": 200, "5": 1000 },
    M: { "3": 25, "4": 80, "5": 250 },
    C: { "3": 15, "4": 40, "5": 100 },
    F: { "3": 10, "4": 30, "5": 80 },
    P: { "3": 5, "4": 20, "5": 50 },
    H: { "3": 5, "4": 15, "5": 40 },
  },

  coin: {
    symbol: "G",
    // Value is a multiple of the TOTAL bet, drawn per coin.
    values: [
      { value: 1, weight: 40 },
      { value: 2, weight: 25 },
      { value: 3, weight: 15 },
      { value: 5, weight: 10 },
      { value: 10, weight: 6 },
      { value: 25, weight: 3 },
      { value: 100, weight: 1 },
    ],
    needed: 5,
  },

  scatterPays: { "3": 2, "4": 10, "5": 50 },
  freeSpins: { "3": 8, "4": 10, "5": 12 },
  freeSpinMultiplier: 2,
  retrigger: false,

  /**
   * 95.56%, which is what the original's own numbers return - computed exactly, not aimed at.
   *
   * The original shipped no RTP figure, so there was nothing to hit. Once the port was in place
   * the closed-form maths said 95.560%, and since that is a perfectly reasonable return the
   * honest move was to record it rather than massage a balanced game toward a rounder number.
   *
   * Its character differs from the other three, and deliberately so: about 80% of the return
   * comes from base-game line hits, and the bonus is rare (1 in 166 spins against 1 in 35-52
   * elsewhere). Changing that would be redesigning the game, not porting it.
   */
  rtpTarget: 0.9556,
  betLevels: BET_LEVELS,
};

themes.push(wildHarbour);

export function getTheme(slug: string): ThemeSpec {
  const theme = themes.find((t) => t.slug === slug);
  if (!theme) throw new Error(`unknown theme: ${slug}`);
  return theme;
}
