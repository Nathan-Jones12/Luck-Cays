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

    /** One strip per reel. The spin picks a stop index into each strip. */
    reelStrips: z.array(z.array(z.string().min(1)).min(8)).min(3),

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

    rtpTarget: z.number().min(0.5).max(1),
    /** Selectable total bets, in chips. Must divide evenly by payline count. */
    betLevels: z.array(z.number().int().positive()).min(1),
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set(cfg.symbols.map((s) => s.id));

    if (ids.size !== cfg.symbols.length) {
      ctx.addIssue({ code: "custom", message: "duplicate symbol id" });
    }
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

/** One spin's outcome. The server computes this; the client only renders it. */
export interface SlotSpinResult {
  roundId: string;
  gameSlug: string;
  /** Stop index per reel - the client uses these to land the reels. */
  stops: number[];
  grid: SlotGrid;
  bet: string;
  totalWin: string;
  lineWins: SlotLineWin[];
  scatterWin: SlotScatterWin | null;
  /** Free spins awarded by this spin, if any. */
  freeSpinsAwarded: number;
  /** True when this spin was itself a free spin (no chips were debited). */
  isFreeSpin: boolean;
  freeSpinsRemaining: number;
  balanceAfter: string;
}
