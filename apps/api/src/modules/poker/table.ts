/**
 * The No-Limit Hold'em table state machine.
 *
 * Authoritative and server-side: deal -> preflop -> flop -> turn -> river -> showdown.
 * The deck lives only here, and `viewFor` builds a per-viewer projection so a player
 * receives their own hole cards and nobody else's. Nothing ever broadcasts full state.
 *
 * Chips at a table are not wallet chips. They were moved out of the wallet by a `buy_in`
 * ledger entry and return on cash-out, so `sum(seat stacks) + sum(wallet balances)` is
 * constant - the invariant that proves a table cannot mint chips. This class never
 * touches the wallet; `poker.service.ts` owns that boundary.
 *
 * In-memory, per process. The PRD puts poker state in Redis so it can be shared; with the
 * in-process store that means one API instance, which is the same constraint the wallet's
 * SQLite lock imposes.
 */
import type {
  ActionType,
  Card,
  PokerLegalAction,
  PokerSeatView,
  PokerTableView,
  Street,
} from "@luck-cays/shared";
import { badRequest, conflict } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { Dealer } from "./cards.js";
import { showdown, type HandRanking } from "./evaluator.js";

export interface SeatState {
  seatNo: number;
  userId: string | null;
  username: string | null;
  /** Chips in front of the player at this table. */
  stack: bigint;
  /** Committed on the current street. */
  committed: bigint;
  /** Committed across the whole hand, which is what side pots are built from. */
  totalCommitted: bigint;
  holeCards: Card[];
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  /** Set when the socket drops; the player is given a grace period before folding. */
  disconnectedAt: number | null;
  /** Has this seat acted since the last bet or raise on this street? */
  hasActed: boolean;
}

export interface TableConfig {
  id: string;
  name: string;
  maxSeats: number;
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyin: bigint;
  maxBuyin: bigint;
}

export interface HandWinner {
  seatNo: number;
  userId: string | null;
  username: string | null;
  amount: bigint;
  /** Absent when everyone else folded - no cards are shown in that case. */
  ranking?: HandRanking;
}

export interface CompletedHand {
  handId: string;
  board: Card[];
  pot: bigint;
  winners: HandWinner[];
  /** Hole cards shown at showdown, by seat. Empty when the hand ended on a fold. */
  revealed: Record<number, Card[]>;
}

/** Emitted so the service can persist actions and hands. */
export interface TableEvents {
  onStateChanged(table: PokerTable): void;
  onHandStarted(table: PokerTable, handId: string, dealerSeat: number): void;
  onAction(
    table: PokerTable,
    action: {
      handId: string;
      userId: string;
      street: Street;
      action: string;
      amount: bigint;
      seq: number;
    },
  ): void;
  onHandComplete(table: PokerTable, hand: CompletedHand): void;
}

const ACTION_TIMEOUT_MS = 20_000;
/** How long a dropped player keeps their seat and their turn before being folded. */
const RECONNECT_GRACE_MS = 30_000;

export class PokerTable {
  readonly seats: SeatState[];

  private handId: string | null = null;
  private street: Street | null = null;
  private board: Card[] = [];
  private dealer: Dealer | null = null;
  private dealerSeat = 0;
  private currentSeat: number | null = null;

  /** Highest amount committed by any seat on the current street. */
  private currentBet = 0n;
  /** Size of the last bet or raise - the minimum increment for the next raise. */
  private minRaise = 0n;
  /** Chips collected from completed streets. */
  private pot = 0n;

  private seq = 0;
  private actionDeadline: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly config: TableConfig,
    private readonly events: TableEvents,
  ) {
    this.seats = Array.from({ length: config.maxSeats }, (_, seatNo) => ({
      seatNo,
      userId: null,
      username: null,
      stack: 0n,
      committed: 0n,
      totalCommitted: 0n,
      holeCards: [],
      folded: false,
      allIn: false,
      sittingOut: false,
      disconnectedAt: null,
      hasActed: false,
    }));
  }

  /* ------------------------------- seating -------------------------------- */

  get handInProgress(): boolean {
    return this.handId !== null;
  }

  seatOf(userId: string): SeatState | null {
    return this.seats.find((seat) => seat.userId === userId) ?? null;
  }

  occupiedSeats(): SeatState[] {
    return this.seats.filter((seat) => seat.userId !== null);
  }

  /** Seats that can be dealt in: present, funded, not sitting out. */
  private eligibleSeats(): SeatState[] {
    return this.seats.filter((seat) => seat.userId !== null && !seat.sittingOut && seat.stack > 0n);
  }

  /**
   * Seat a player. The chips have already left their wallet, so this only records them at
   * the table.
   */
  sit(seatNo: number, userId: string, username: string, chips: bigint): SeatState {
    const seat = this.seats[seatNo];
    if (!seat) throw badRequest("NO_SUCH_SEAT", "That seat does not exist");
    if (seat.userId !== null) throw conflict("SEAT_TAKEN", "That seat is taken");
    if (this.seatOf(userId)) throw conflict("ALREADY_SEATED", "You are already at this table");

    seat.userId = userId;
    seat.username = username;
    seat.stack = chips;
    seat.sittingOut = false;
    seat.disconnectedAt = null;
    this.resetSeatForHand(seat);

    return seat;
  }

  firstOpenSeat(): number | null {
    return this.seats.find((seat) => seat.userId === null)?.seatNo ?? null;
  }

  /**
   * Remove a player and return the chips to hand back to their wallet.
   *
   * A seat in a live hand is folded first: leaving must not abandon chips that other
   * players have already called, so whatever is committed to the pot stays there.
   */
  stand(userId: string): { seatNo: number; chips: bigint } | null {
    const seat = this.seatOf(userId);
    if (!seat) return null;

    if (this.handInProgress && !seat.folded && seat.totalCommitted > 0n) {
      seat.folded = true;
      seat.hasActed = true;
      if (this.currentSeat === seat.seatNo) this.advanceAction();
    }

    const chips = seat.stack;
    seat.userId = null;
    seat.username = null;
    seat.stack = 0n;
    seat.sittingOut = false;
    seat.disconnectedAt = null;
    this.resetSeatForHand(seat);

    return { seatNo: seat.seatNo, chips };
  }

  setSittingOut(userId: string, sitOut: boolean): void {
    const seat = this.seatOf(userId);
    if (!seat) throw conflict("NOT_SEATED", "You are not at this table");
    seat.sittingOut = sitOut;
  }

  markDisconnected(userId: string): void {
    const seat = this.seatOf(userId);
    if (seat) seat.disconnectedAt = Date.now();
  }

  markReconnected(userId: string): void {
    const seat = this.seatOf(userId);
    if (seat) seat.disconnectedAt = null;
  }

  /** Seats dropped for longer than the grace period, for the caller to cash out. */
  expiredDisconnects(now = Date.now()): SeatState[] {
    return this.seats.filter(
      (seat) =>
        seat.userId !== null &&
        seat.disconnectedAt !== null &&
        now - seat.disconnectedAt > RECONNECT_GRACE_MS,
    );
  }

  /* -------------------------------- hands --------------------------------- */

  private resetSeatForHand(seat: SeatState): void {
    seat.committed = 0n;
    seat.totalCommitted = 0n;
    seat.holeCards = [];
    seat.folded = false;
    seat.allIn = false;
    seat.hasActed = false;
  }

  /** True when a new hand can begin. */
  canStartHand(): boolean {
    return !this.handInProgress && this.eligibleSeats().length >= 2;
  }

  startHand(handId: string): void {
    if (this.handInProgress) throw conflict("HAND_IN_PROGRESS", "A hand is already running");

    const eligible = this.eligibleSeats();
    if (eligible.length < 2) {
      throw conflict("NOT_ENOUGH_PLAYERS", "At least two funded players are needed");
    }

    for (const seat of this.seats) this.resetSeatForHand(seat);

    this.handId = handId;
    this.dealer = new Dealer();
    this.board = [];
    this.pot = 0n;
    this.seq = 0;
    this.street = "preflop";

    // Move the button to the next eligible seat.
    this.dealerSeat = this.nextEligibleFrom(this.dealerSeat + 1, eligible);

    const hedsUp = eligible.length === 2;
    // Heads-up: the button posts the small blind. Three or more: the two seats after it.
    const smallBlindSeat = hedsUp
      ? this.dealerSeat
      : this.nextEligibleFrom(this.dealerSeat + 1, eligible);
    const bigBlindSeat = this.nextEligibleFrom(smallBlindSeat + 1, eligible);

    this.postBlind(smallBlindSeat, this.config.smallBlind);
    this.postBlind(bigBlindSeat, this.config.bigBlind);

    this.currentBet = this.config.bigBlind;
    this.minRaise = this.config.bigBlind;

    for (const seat of eligible) seat.holeCards = (this.dealer as Dealer).deal(2);

    // Preflop action starts left of the big blind; heads-up that is the button.
    this.currentSeat = hedsUp ? this.dealerSeat : this.nextActionableFrom(bigBlindSeat + 1);

    // Posting a blind is not acting: the big blind still gets to raise.
    for (const seat of eligible) seat.hasActed = false;

    this.events.onHandStarted(this, handId, this.dealerSeat);
    this.startActionTimer();
    this.events.onStateChanged(this);

    logger.debug({ tableId: this.config.id, handId, dealerSeat: this.dealerSeat }, "hand started");
  }

  private postBlind(seatNo: number, amount: bigint): void {
    const seat = this.seats[seatNo];
    if (!seat) return;

    // A short stack posts what it has and is all-in.
    const posted = amount > seat.stack ? seat.stack : amount;
    seat.stack -= posted;
    seat.committed += posted;
    seat.totalCommitted += posted;
    if (seat.stack === 0n) seat.allIn = true;

    this.seq += 1;
    if (seat.userId) {
      this.events.onAction(this, {
        handId: this.handId as string,
        userId: seat.userId,
        street: "preflop",
        action: "post_blind",
        amount: posted,
        seq: this.seq,
      });
    }
  }

  private nextEligibleFrom(start: number, eligible: SeatState[]): number {
    const ids = new Set(eligible.map((seat) => seat.seatNo));
    for (let step = 0; step < this.config.maxSeats; step++) {
      const seatNo = (start + step + this.config.maxSeats) % this.config.maxSeats;
      if (ids.has(seatNo)) return seatNo;
    }
    throw new Error("no eligible seat found");
  }

  /** The next seat that can still act: in the hand, not folded, not all-in. */
  private nextActionableFrom(start: number): number | null {
    for (let step = 0; step < this.config.maxSeats; step++) {
      const seatNo = (start + step + this.config.maxSeats) % this.config.maxSeats;
      const seat = this.seats[seatNo];
      if (
        seat &&
        seat.userId !== null &&
        !seat.folded &&
        !seat.allIn &&
        seat.holeCards.length > 0
      ) {
        return seatNo;
      }
    }
    return null;
  }

  private contenders(): SeatState[] {
    return this.seats.filter((seat) => seat.holeCards.length > 0 && !seat.folded);
  }

  /* -------------------------------- actions -------------------------------- */

  legalActionsFor(seatNo: number): PokerLegalAction[] {
    if (this.currentSeat !== seatNo || !this.handInProgress) return [];

    const seat = this.seats[seatNo];
    if (!seat || seat.folded || seat.allIn) return [];

    const toCall = this.currentBet - seat.committed;
    const actions: PokerLegalAction[] = [{ action: "fold" }];

    if (toCall <= 0n) {
      actions.push({ action: "check" });
    } else {
      // Calling more than the stack is simply all-in.
      const callAmount = toCall > seat.stack ? seat.stack : toCall;
      actions.push({ action: "call", callAmount: callAmount.toString(10) });
    }

    const maxTotal = seat.committed + seat.stack;

    if (this.currentBet === 0n) {
      // Opening bet: at least one big blind, unless the stack is shorter.
      if (seat.stack > 0n) {
        const min = this.config.bigBlind > seat.stack ? maxTotal : this.config.bigBlind;
        actions.push({ action: "bet", min: min.toString(10), max: maxTotal.toString(10) });
      }
    } else if (maxTotal > this.currentBet) {
      // A raise must add at least the last raise's size, unless that is more than the
      // stack - in which case the only raise available is all-in.
      const wanted = this.currentBet + this.minRaise;
      const min = wanted > maxTotal ? maxTotal : wanted;
      actions.push({ action: "raise", min: min.toString(10), max: maxTotal.toString(10) });
    }

    if (seat.stack > 0n) actions.push({ action: "allin", max: maxTotal.toString(10) });

    return actions;
  }

  /**
   * Apply a player's action.
   *
   * `amount` for bet and raise is the TOTAL the player will have committed on this street,
   * not the increment - the same convention the legal-action minimums use, so a client can
   * send back exactly what it was offered.
   */
  act(userId: string, handId: string, action: ActionType, amount?: bigint): void {
    if (!this.handInProgress) throw conflict("NO_HAND", "No hand is in progress");
    if (handId !== this.handId) {
      // The hand moved on before this arrived - usually a slow client, not an attack.
      throw conflict("STALE_HAND", "That hand has already finished");
    }

    const seat = this.seatOf(userId);
    if (!seat) throw conflict("NOT_SEATED", "You are not at this table");
    if (this.currentSeat !== seat.seatNo) throw conflict("NOT_YOUR_TURN", "It is not your turn");

    const legal = this.legalActionsFor(seat.seatNo);
    const permitted = legal.find((entry) => entry.action === action);
    if (!permitted) throw badRequest("ILLEGAL_ACTION", `You cannot ${action} right now`);

    const toCall = this.currentBet - seat.committed;

    switch (action) {
      case "fold":
        seat.folded = true;
        break;

      case "check":
        break;

      case "call":
        this.commit(seat, toCall > seat.stack ? seat.stack : toCall);
        break;

      case "bet":
      case "raise": {
        if (amount === undefined) {
          throw badRequest("AMOUNT_REQUIRED", `A ${action} needs an amount`);
        }
        const min = BigInt(permitted.min ?? "0");
        const max = BigInt(permitted.max ?? "0");
        if (amount < min || amount > max) {
          throw badRequest(
            "AMOUNT_OUT_OF_RANGE",
            `That ${action} must be between ${min} and ${max}`,
          );
        }

        const raiseSize = amount - this.currentBet;
        this.commit(seat, amount - seat.committed);
        this.currentBet = amount;
        // Only a full raise resets the minimum; an all-in for less does not.
        if (raiseSize > this.minRaise) this.minRaise = raiseSize;
        this.reopenAction(seat.seatNo);
        break;
      }

      case "allin": {
        const total = seat.committed + seat.stack;
        this.commit(seat, seat.stack);
        if (total > this.currentBet) {
          const raiseSize = total - this.currentBet;
          this.currentBet = total;
          if (raiseSize > this.minRaise) this.minRaise = raiseSize;
          this.reopenAction(seat.seatNo);
        }
        break;
      }
    }

    seat.hasActed = true;
    this.seq += 1;
    this.events.onAction(this, {
      handId: this.handId as string,
      userId,
      street: this.street as Street,
      action,
      amount: action === "fold" || action === "check" ? 0n : seat.committed,
      seq: this.seq,
    });

    this.advanceAction();
  }

  private commit(seat: SeatState, amount: bigint): void {
    const moved = amount > seat.stack ? seat.stack : amount;
    seat.stack -= moved;
    seat.committed += moved;
    seat.totalCommitted += moved;
    if (seat.stack === 0n) seat.allIn = true;
  }

  /** A bet or raise gives everyone else a fresh decision. */
  private reopenAction(raiserSeatNo: number): void {
    for (const seat of this.seats) {
      if (seat.seatNo !== raiserSeatNo && !seat.folded && !seat.allIn) seat.hasActed = false;
    }
  }

  private bettingComplete(): boolean {
    const live = this.seats.filter((seat) => seat.holeCards.length > 0 && !seat.folded);
    if (live.length <= 1) return true;

    const canAct = live.filter((seat) => !seat.allIn);
    // Everyone remaining is all-in: nothing left to decide.
    if (canAct.length === 0) return true;

    return canAct.every((seat) => seat.hasActed && seat.committed === this.currentBet);
  }

  private advanceAction(): void {
    this.clearTimer();

    // Everyone folded but one: the hand is over without a showdown.
    if (this.contenders().length <= 1) {
      this.finishHand();
      return;
    }

    if (this.bettingComplete()) {
      this.advanceStreet();
      return;
    }

    const next = this.nextActionableFrom((this.currentSeat ?? 0) + 1);
    this.currentSeat = next;

    if (next === null) {
      this.advanceStreet();
      return;
    }

    this.startActionTimer();
    this.events.onStateChanged(this);
  }

  /** Sweep the street's commitments into the pot and reset for the next one. */
  private collectBets(): void {
    for (const seat of this.seats) {
      this.pot += seat.committed;
      seat.committed = 0n;
      seat.hasActed = false;
    }
    this.currentBet = 0n;
    this.minRaise = this.config.bigBlind;
  }

  private advanceStreet(): void {
    this.collectBets();

    const dealer = this.dealer as Dealer;

    switch (this.street) {
      case "preflop":
        dealer.burn();
        this.board = dealer.deal(3);
        this.street = "flop";
        break;
      case "flop":
        dealer.burn();
        this.board = [...this.board, ...dealer.deal(1)];
        this.street = "turn";
        break;
      case "turn":
        dealer.burn();
        this.board = [...this.board, ...dealer.deal(1)];
        this.street = "river";
        break;
      case "river":
        this.street = "showdown";
        this.finishHand();
        return;
      default:
        this.finishHand();
        return;
    }

    // If everyone left is all-in there is nothing to decide: run the board out.
    const canAct = this.contenders().filter((seat) => !seat.allIn);
    if (canAct.length <= 1 && this.contenders().length > 1) {
      // One player with chips behind and the rest all-in still has no decision to make
      // once there is nothing to call.
      if (canAct.length === 0) {
        this.advanceStreet();
        return;
      }
    }

    // Postflop action starts left of the button.
    this.currentSeat = this.nextActionableFrom(this.dealerSeat + 1);
    if (this.currentSeat === null) {
      this.advanceStreet();
      return;
    }

    this.startActionTimer();
    this.events.onStateChanged(this);
  }

  /* ------------------------------- pot award ------------------------------- */

  /**
   * Split the pot into main and side pots.
   *
   * A player who is all-in for less than the current bet can only win what they matched.
   * Pots are built by walking the distinct all-in levels upward, taking that much from
   * every seat that reached it.
   */
  private buildPots(): Array<{ amount: bigint; eligible: SeatState[] }> {
    const participants = this.seats.filter((seat) => seat.totalCommitted > 0n);
    if (participants.length === 0) return [];

    const levels = [...new Set(participants.map((seat) => seat.totalCommitted))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

    const pots: Array<{ amount: bigint; eligible: SeatState[] }> = [];
    let previous = 0n;

    for (const level of levels) {
      const band = level - previous;
      if (band <= 0n) continue;

      // Everyone who committed at least this much contributes one band to this pot -
      // including folded players, whose chips stay in.
      const contributors = participants.filter((seat) => seat.totalCommitted >= level);
      const amount = band * BigInt(contributors.length);

      // Only unfolded contributors can win it.
      const eligible = contributors.filter((seat) => !seat.folded);

      if (amount > 0n && eligible.length > 0) pots.push({ amount, eligible });
      else if (amount > 0n && pots.length > 0) {
        // No eligible winner for this band (everyone folded): fold it into the last pot.
        const last = pots[pots.length - 1] as { amount: bigint; eligible: SeatState[] };
        last.amount += amount;
      }

      previous = level;
    }

    return pots;
  }

  private finishHand(): void {
    this.clearTimer();
    if (!this.handId) return;

    this.collectBets();

    const contenders = this.contenders();
    const pots = this.buildPots();
    const winners = new Map<number, HandWinner>();
    const revealed: Record<number, Card[]> = {};

    const addWin = (seat: SeatState, amount: bigint, ranking?: HandRanking) => {
      const existing = winners.get(seat.seatNo);
      if (existing) {
        existing.amount += amount;
        return;
      }
      winners.set(seat.seatNo, {
        seatNo: seat.seatNo,
        userId: seat.userId,
        username: seat.username,
        amount,
        ...(ranking ? { ranking } : {}),
      });
    };

    if (contenders.length === 1) {
      // Won on a fold: no cards are shown, which matters - revealing them would leak
      // information about how the winner plays.
      const winner = contenders[0] as SeatState;
      const total = pots.reduce((sum, pot) => sum + pot.amount, 0n);
      winner.stack += total;
      addWin(winner, total);
    } else {
      for (const pot of pots) {
        const eligible = pot.eligible.filter((seat) => !seat.folded);
        if (eligible.length === 0) continue;

        const result = showdown(
          eligible.map((seat) => ({ seatNo: seat.seatNo, holeCards: seat.holeCards })),
          this.board,
        );

        // Integer split; the odd chips go to the first winners left of the button, as at a
        // real table. No chip is ever created or lost.
        const share = pot.amount / BigInt(result.winners.length);
        let remainder = pot.amount - share * BigInt(result.winners.length);

        for (const win of result.winners) {
          const seat = this.seats[win.seatNo];
          if (!seat) continue;
          let amount = share;
          if (remainder > 0n) {
            amount += 1n;
            remainder -= 1n;
          }
          seat.stack += amount;
          addWin(seat, amount, win.ranking);
        }
      }

      for (const seat of contenders) revealed[seat.seatNo] = seat.holeCards;
    }

    const completed: CompletedHand = {
      handId: this.handId,
      board: this.board,
      pot: pots.reduce((sum, pot) => sum + pot.amount, 0n),
      winners: [...winners.values()],
      revealed,
    };

    this.handId = null;
    this.street = null;
    this.currentSeat = null;
    this.pot = 0n;
    this.currentBet = 0n;
    this.actionDeadline = null;

    this.events.onHandComplete(this, completed);
    this.events.onStateChanged(this);
  }

  /* -------------------------------- timers -------------------------------- */

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.actionDeadline = null;
  }

  private startActionTimer(): void {
    this.clearTimer();
    if (this.currentSeat === null) return;

    const seat = this.seats[this.currentSeat];
    // A disconnected player gets the longer grace window before being folded.
    const timeout = seat?.disconnectedAt !== null ? RECONNECT_GRACE_MS : ACTION_TIMEOUT_MS;

    this.actionDeadline = Date.now() + timeout;
    this.timer = setTimeout(() => this.onTimeout(), timeout);
    // Never let a pending action timer hold the process open.
    this.timer.unref?.();
  }

  /** Out of time: check if it is free, otherwise fold. */
  private onTimeout(): void {
    if (this.currentSeat === null || !this.handId) return;

    const seat = this.seats[this.currentSeat];
    if (!seat?.userId) return;

    const toCall = this.currentBet - seat.committed;
    try {
      this.act(seat.userId, this.handId, toCall <= 0n ? "check" : "fold");
      // A player who timed out is sat out rather than left to time out every hand.
      if (toCall > 0n) seat.sittingOut = true;
    } catch (error) {
      logger.error({ err: error, tableId: this.config.id }, "failed to apply action timeout");
    }
  }

  /** Stop every timer. Called on shutdown so the process can exit. */
  dispose(): void {
    this.clearTimer();
  }

  /* --------------------------------- views -------------------------------- */

  /**
   * Build the view for one viewer.
   *
   * Hole cards are included only for the viewer's own seat, or for seats still contesting
   * a showdown once `revealed` has been published. Everyone else's cards are null - the
   * projection is the security boundary, so it must stay the only way state leaves here.
   */
  viewFor(userId: string | null): PokerTableView {
    const viewerSeat = userId ? this.seatOf(userId) : null;

    const seats: PokerSeatView[] = this.seats.map((seat) => ({
      seatNo: seat.seatNo,
      userId: seat.userId,
      username: seat.username,
      stack: seat.stack.toString(10),
      committed: seat.committed.toString(10),
      folded: seat.folded,
      allIn: seat.allIn,
      sittingOut: seat.sittingOut,
      isDealer: seat.seatNo === this.dealerSeat && this.handInProgress,
      isTurn: this.currentSeat === seat.seatNo,
      holeCards:
        viewerSeat !== null && seat.seatNo === viewerSeat.seatNo && seat.holeCards.length > 0
          ? seat.holeCards
          : null,
      timeLeftMs:
        this.currentSeat === seat.seatNo && this.actionDeadline !== null
          ? Math.max(0, this.actionDeadline - Date.now())
          : null,
    }));

    // Live pot: collected streets plus what is committed right now.
    const liveCommitted = this.seats.reduce((sum, seat) => sum + seat.committed, 0n);

    return {
      tableId: this.config.id,
      handId: this.handId,
      street: this.street,
      board: this.board,
      pots: [
        {
          amount: (this.pot + liveCommitted).toString(10),
          eligibleSeats: this.contenders().map((seat) => seat.seatNo),
        },
      ],
      seats,
      smallBlind: this.config.smallBlind.toString(10),
      bigBlind: this.config.bigBlind.toString(10),
      legalActions: viewerSeat ? this.legalActionsFor(viewerSeat.seatNo) : [],
      yourSeat: viewerSeat?.seatNo ?? null,
    };
  }
}
