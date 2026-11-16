import { z } from "zod";

/**
 * A slot game is pure data. The engine in `apps/api/src/modules/slots` knows how
 * to spin and evaluate *any* config that parses here, so a new theme is a new
 * JSON blob in `slot_games.config_json` and no new code.
 *
 * Money note: paytable values are **multipliers**, not chips. Line symbols pay
 * `multiplier x line bet`; scatters pay `multiplier x total bet`.
 */

export const symbolKindSchema = z.enum(["normal", "wild", "scatter"]);
export type SymbolKind = z.infer<typeof symbolKindSchema>;

export const slotSymbolSchema = z.object({
  /** Short id used in reel strips and paytable keys, e.g. "SHIP". */
  id: z
    .string()
    .min(1)
    .max(12)
    .regex(/^[A-Z0-9_]+$/),
  name: z.string().min(1).max(40),
  kind: symbolKindSchema.default("normal"),
});
export type SlotSymbol = z.infer<typeof slotSymbolSchema>;

/**
 * Payouts keyed by run length. `{ "3": 10, "4": 50, "5": 250 }`.
 *
 * Multipliers are whole numbers on purpose. Every bet level divides evenly by the
 * payline count, so an integer multiplier times a whole line bet is always a whole
 * number of chips - no rounding happens anywhere in the money path, and the exact
 * RTP calculation in `tools/slot-gen/src/exact.ts` describes the engine chip for
 * chip rather than approximately. Fractional multipliers would reintroduce a floor
 * at every win and put the two back out of step.
 */
export const payoutsSchema = z.record(z.string().regex(/^[1-9]$/), z.number().int().nonnegative());
export type Payouts = z.infer<typeof payoutsSchema>;

export const slotConfigSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(80),
    theme: z.string().min(1).max(40),

    reels: z.number().int().min(3).max(6),
    rows: z.number().int().min(3).max(5),

    symbols: z.array(slotSymbolSchema).min(3),

    /**
     * REEL MODEL. A config supplies exactly one of these two, and they behave differently in
     * a way players can feel:
     *
     *  - `reelStrips`: one strip per reel, and the spin picks a single stop index into it. The
     *    visible cells are ADJACENT on the strip, so they are correlated - two of the same
     *    symbol often appear together. This is how a physical reel behaves.
     *
     *  - `reelWeights`: a weight table per reel, and every visible cell is drawn
     *    independently. No correlation between rows, and a symbol can appear three times on
     *    one reel. Simpler to reason about and simpler to compute exactly, but it does not
     *    look like a mechanical reel.
     *
     * Both are legitimate. Which one a game uses is a design decision, not an implementation
     * detail, which is why it lives in the config.
     */
    reelStrips: z
      .array(z.array(z.string().min(1)).min(8))
      .min(3)
      .optional(),

    /** Weight per symbol, per reel. A weight of 0 keeps a symbol off that reel entirely. */
    reelWeights: z
      .array(z.record(z.string().min(1), z.number().int().nonnegative()))
      .min(3)
      .optional(),

    /**
     * Each payline is one row index per reel, left to right.
     * `[1,1,1,1,1]` is the middle row across.
     */
    paylines: z.array(z.array(z.number().int().min(0)).min(3)).min(1),

    /** symbolId -> run length -> multiplier of the line bet. */
    paytable: z.record(z.string(), payoutsSchema),

    wild: z.object({
      symbol: z.string().min(1),
      /** Wild stands in for every symbol except the scatter. */
      substitutes: z.boolean().default(true),
    }),

    scatter: z.object({
      symbol: z.string().min(1),
      /** count -> multiplier of TOTAL bet, paid regardless of position. */
      pays: payoutsSchema,
      /** count -> free spins awarded. */
      freeSpins: z.record(z.string().regex(/^[1-9]$/), z.number().int().min(0)),
      /** Multiplier applied to wins during free spins. */
      freeSpinMultiplier: z.number().min(1).default(1),
      /** Can free spins retrigger more free spins? */
      retrigger: z.boolean().default(false),
    }),

    /**
     * A money-symbol feature, as in "242 Wild Harbour".
     *
     * Each coin that lands carries its own value, drawn from a weighted table and expressed as
     * a multiple of the TOTAL bet. Coins pay nothing at all unless at least `needed` of them
     * land, and when they do, the whole set pays its summed value. That all-or-nothing
     * threshold is what gives the feature its shape: most spins the coins are decoration.
     *
     * Optional, because the three original games have no such feature.
     */
    coin: z
      .object({
        symbol: z.string().min(1),
        /** Weighted values, each a whole multiple of the total bet. */
        values: z
          .array(
            z.object({
              value: z.number().int().positive(),
              weight: z.number().int().positive(),
            }),
          )
          .min(1),
        /** Coins pay nothing unless at least this many land on the grid. */
        needed: z.number().int().min(1),
      })
      .optional(),

    rtpTarget: z.number().min(0.5).max(1),
    /** Selectable total bets, in chips. Must divide evenly by payline count. */
    betLevels: z.array(z.number().int().positive()).min(1),
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set(cfg.symbols.map((s) => s.id));

    if (ids.size !== cfg.symbols.length) {
      ctx.addIssue({ code: "custom", message: "duplicate symbol id" });
    }

    /* ----------------------------- reel model ------------------------------ */

    // Exactly one model. Both would be ambiguous; neither leaves nothing to spin.
    if (cfg.reelStrips && cfg.reelWeights) {
      ctx.addIssue({
        code: "custom",
        message: "a config supplies reelStrips OR reelWeights, never both",
      });
    }
    if (!cfg.reelStrips && !cfg.reelWeights) {
      ctx.addIssue({ code: "custom", message: "a config needs either reelStrips or reelWeights" });
    }

    if (cfg.reelStrips) {
      if (cfg.reelStrips.length !== cfg.reels) {
        ctx.addIssue({
          code: "custom",
          message: `expected ${cfg.reels} reel strips, got ${cfg.reelStrips.length}`,
        });
      }
      for (const [i, strip] of cfg.reelStrips.entries()) {
        for (const sym of strip) {
          if (!ids.has(sym)) {
            ctx.addIssue({ code: "custom", message: `reel ${i} uses unknown symbol ${sym}` });
          }
        }
      }
    }

    if (cfg.reelWeights) {
      if (cfg.reelWeights.length !== cfg.reels) {
        ctx.addIssue({
          code: "custom",
          message: `expected ${cfg.reels} weight tables, got ${cfg.reelWeights.length}`,
        });
      }
      for (const [i, weights] of cfg.reelWeights.entries()) {
        for (const sym of Object.keys(weights)) {
          if (!ids.has(sym)) {
            ctx.addIssue({ code: "custom", message: `reel ${i} weights unknown symbol ${sym}` });
          }
        }
        // An all-zero reel could never produce a symbol, so the spin would have nothing to pick.
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        if (total <= 0) {
          ctx.addIssue({
            code: "custom",
            message: `reel ${i} has no symbol with a weight above 0`,
          });
        }
      }
    }

    /* ------------------------------- coins --------------------------------- */

    if (cfg.coin) {
      if (!ids.has(cfg.coin.symbol)) {
        ctx.addIssue({ code: "custom", message: `unknown coin symbol ${cfg.coin.symbol}` });
      }
      // A coin that also pays as a line symbol would be paid twice for the same cell.
      if (cfg.paytable[cfg.coin.symbol]) {
        ctx.addIssue({
          code: "custom",
          message: `${cfg.coin.symbol} is the coin symbol and must not also appear in the paytable`,
        });
      }
      if (cfg.coin.needed > cfg.reels * cfg.rows) {
        ctx.addIssue({
          code: "custom",
          message: `coin.needed (${cfg.coin.needed}) exceeds the ${cfg.reels * cfg.rows} cells on the grid`,
        });
      }
    }
    for (const [i, line] of cfg.paylines.entries()) {
      if (line.length !== cfg.reels) {
        ctx.addIssue({ code: "custom", message: `payline ${i} must cover ${cfg.reels} reels` });
      }
      for (const row of line) {
        if (row >= cfg.rows) {
          ctx.addIssue({
            code: "custom",
            message: `payline ${i} row ${row} exceeds ${cfg.rows} rows`,
          });
        }
      }
    }
    for (const key of Object.keys(cfg.paytable)) {
      if (!ids.has(key)) {
        ctx.addIssue({ code: "custom", message: `paytable references unknown symbol ${key}` });
      }
    }
    if (!ids.has(cfg.wild.symbol)) {
      ctx.addIssue({ code: "custom", message: `unknown wild symbol ${cfg.wild.symbol}` });
    }
    if (!ids.has(cfg.scatter.symbol)) {
      ctx.addIssue({ code: "custom", message: `unknown scatter symbol ${cfg.scatter.symbol}` });
    }
    // Line bets must stay whole chips - no rounding anywhere in the money path.
    for (const bet of cfg.betLevels) {
      if (bet % cfg.paylines.length !== 0) {
        ctx.addIssue({
          code: "custom",
          message: `bet level ${bet} is not divisible by ${cfg.paylines.length} paylines`,
        });
      }
    }
  });

export type SlotConfig = z.infer<typeof slotConfigSchema>;

/** The grid the client animates to: `grid[reel][row]` symbol ids. */
export type SlotGrid = string[][];

export interface SlotLineWin {
  /** Index into `config.paylines`. */
  line: number;
  symbol: string;
  count: number;
  /** Chips won on this line. */
  amount: string;
  /** `grid` positions that lit up, as [reel, row] pairs, for the win animation. */
  cells: Array<[number, number]>;
}

export interface SlotScatterWin {
  symbol: string;
  count: number;
  amount: string;
  cells: Array<[number, number]>;
}

/**
 * The coin feature's payout. Present only when at least `coin.needed` coins landed - below
 * that threshold the coins are visible but worth nothing, which is the point of the feature.
 */
export interface SlotCoinWin {
  symbol: string;
  count: number;
  /** Chips won: the summed coin values times the total bet. */
  amount: string;
  /** Each coin's position and its own value, so the client can show the figure on the tile. */
  coins: Array<{ cell: [number, number]; value: number }>;
}

/**
 * Coin values by cell, `null` where the cell holds no coin.
 *
 * Kept beside the grid rather than inside it so `SlotGrid` stays a plain symbol matrix. Line
 * evaluation, the exact RTP maths and the reel renderer all only ever care which symbol is in
 * a cell, and threading a value through them for the sake of one game's feature would
 * complicate every other path.
 */
export type SlotCoinValues = Array<Array<number | null>>;

/** One spin's outcome. The server computes this; the client only renders it. */
export interface SlotSpinResult {
  roundId: string;
  gameSlug: string;
  /**
   * Stop index per reel, for a strip-based game - the client uses these to land the reels.
   * Empty for a weighted game, which has no strip to land on; those clients render the grid.
   */
  stops: number[];
  grid: SlotGrid;
  /** Coin values by cell, for a game with the coin feature. Null otherwise. */
  coinValues: SlotCoinValues | null;
  bet: string;
  totalWin: string;
  lineWins: SlotLineWin[];
  scatterWin: SlotScatterWin | null;
  coinWin: SlotCoinWin | null;
  /** Free spins awarded by this spin, if any. */
  freeSpinsAwarded: number;
  /** True when this spin was itself a free spin (no chips were debited). */
  isFreeSpin: boolean;
  freeSpinsRemaining: number;
  balanceAfter: string;
}
