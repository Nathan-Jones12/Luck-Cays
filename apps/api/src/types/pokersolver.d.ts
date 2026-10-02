/**
 * Minimal types for `pokersolver`, which ships none.
 *
 * Only the surface `poker/evaluator.ts` uses is declared. Keeping it narrow is deliberate:
 * a wider guess at the library's shape would be a guess the compiler then trusts.
 *
 * It is CommonJS, so Node's ESM loader cannot see its named exports statically - hence the
 * default export here, which `evaluator.ts` destructures. Importing `{ Hand }` directly
 * typechecks but fails at runtime.
 *
 * Cards are rank + suit strings, e.g. "Ad", "Ts", "2c".
 */
declare module "pokersolver" {
  export interface SolvedCard {
    value: string;
    suit: string;
    toString(): string;
  }

  export interface SolvedHand {
    /** Category name, e.g. "Full House". A royal flush is reported as "Straight Flush". */
    readonly name: string;
    /** Longer description, e.g. "Full House, A's over K's". */
    readonly descr: string;
    /** Relative strength; higher is better. Only comparable within this library. */
    readonly rank: number;
    /** The five cards that make the hand, best first. */
    readonly cards: SolvedCard[];
  }

  export interface HandStatic {
    /** Best five-card hand from five to seven cards. */
    solve(cards: string[]): SolvedHand;
    /** The winning hand or hands; more than one when the pot is split. */
    winners(hands: SolvedHand[]): SolvedHand[];
  }

  const pokersolver: { Hand: HandStatic };
  export default pokersolver;
}
