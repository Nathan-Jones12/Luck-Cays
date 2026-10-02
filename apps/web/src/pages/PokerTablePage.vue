<script setup lang="ts">
/**
 * A live poker table over Socket.IO.
 *
 * The page renders whatever view the server sends and sends back actions. It holds no game
 * state of its own - no deck, no other player's cards, no notion of whose turn it is beyond
 * what the last `poker:state` said. That is the point: the only hole cards this client ever
 * receives are the viewer's own, because the server builds a separate projection per socket.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  formatChips,
  POKER_EVENTS,
  type Card,
  type PokerLegalAction,
  type PokerTableSummary,
  type PokerTableView,
} from "@luck-cays/shared";
import { api, ApiError } from "@/api/client";
import { connectSocket } from "@/api/socket";
import { useWalletStore } from "@/stores/wallet";

const route = useRoute();
const router = useRouter();
const wallet = useWalletStore();

const tableId = String(route.params["id"]);

const table = ref<PokerTableView | null>(null);
const info = ref<PokerTableSummary | null>(null);
const buyin = ref(0);
const seated = ref(false);
const error = ref<string | null>(null);
const joining = ref(false);
const raiseTo = ref(0);

/** Set from the server's hand-result event, shown until the next hand starts. */
const lastResult = ref<{
  winners: Array<{ seatNo: number; username: string | null; amount: string; handName?: string }>;
} | null>(null);

const socket = connectSocket();

const mySeat = computed(() =>
  table.value?.yourSeat === null || table.value === null
    ? null
    : (table.value.seats.find((seat) => seat.seatNo === table.value?.yourSeat) ?? null),
);

const legal = computed<PokerLegalAction[]>(() => table.value?.legalActions ?? []);
const isMyTurn = computed(() => legal.value.length > 0);

function actionOf(name: string): PokerLegalAction | undefined {
  return legal.value.find((entry) => entry.action === name);
}

const raiseAction = computed(() => actionOf("raise") ?? actionOf("bet"));

/** Seats laid out around an oval, with the viewer's seat rotated to the bottom. */
const seatPositions = computed(() => {
  const seats = table.value?.seats ?? [];
  const count = seats.length || 1;
  const mine = table.value?.yourSeat ?? 0;

  return seats.map((seat) => {
    // Rotate so the viewer sits at the bottom centre of the oval.
    const offset = ((seat.seatNo - mine + count) % count) / count;
    const angle = Math.PI / 2 + offset * Math.PI * 2;
    return {
      seat,
      style: {
        left: `${50 + 42 * Math.cos(angle)}%`,
        top: `${50 + 38 * Math.sin(angle)}%`,
      },
    };
  });
});

function cardColor(card: Card): string {
  const suit = card[1];
  return suit === "h" || suit === "d" ? "red" : "black";
}

function suitGlyph(card: Card): string {
  return { c: "♣", d: "♦", h: "♥", s: "♠" }[card[1] ?? ""] ?? "?";
}

onMounted(async () => {
  try {
    const [snapshot, tables] = await Promise.all([
      api.get<{ table: PokerTableView }>(`/poker/tables/${tableId}`),
      api.get<{ tables: PokerTableSummary[] }>("/poker/tables"),
    ]);

    table.value = snapshot.table;
    info.value = tables.tables.find((entry) => entry.id === tableId) ?? null;
    seated.value = snapshot.table.yourSeat !== null;

    if (info.value) {
      // Default to the minimum, or the whole balance if that is less.
      const min = BigInt(info.value.minBuyin);
      buyin.value = Number(wallet.balanceChips >= min ? min : wallet.balanceChips);
    }
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : "Could not open that table.";
  }

  socket.on(POKER_EVENTS.state, (view: PokerTableView) => {
    table.value = view;
    seated.value = view.yourSeat !== null;

    // Pre-fill the raise box with the minimum, so the slider starts somewhere legal.
    const raise = view.legalActions.find((a) => a.action === "raise" || a.action === "bet");
    if (raise?.min) raiseTo.value = Number(raise.min);
  });

  socket.on(POKER_EVENTS.handResult, (result: typeof lastResult.value) => {
    lastResult.value = result;
    void wallet.refresh();
  });

  socket.on(POKER_EVENTS.error, (payload: { code: string; message: string }) => {
    error.value = payload.message;
    joining.value = false;
  });
});

onBeforeUnmount(() => {
  socket.off(POKER_EVENTS.state);
  socket.off(POKER_EVENTS.handResult);
  socket.off(POKER_EVENTS.error);
  // The seat is deliberately NOT given up here: navigating away should not forfeit chips
  // committed to a live pot. The server holds it through the reconnect grace period.
});

function join(): void {
  error.value = null;
  joining.value = true;
  socket.emit(POKER_EVENTS.join, { tableId, buyin: String(buyin.value) });
  // The state broadcast confirms it; this just stops the button spinning forever.
  setTimeout(() => {
    joining.value = false;
  }, 2500);
}

async function leave(): Promise<void> {
  socket.emit(POKER_EVENTS.leave, { tableId });
  await wallet.refresh();
  await router.push("/poker");
}

function act(action: string, amount?: number): void {
  if (!table.value?.handId) return;
  error.value = null;
  socket.emit(POKER_EVENTS.action, {
    tableId,
    handId: table.value.handId,
    action,
    ...(amount === undefined ? {} : { amount: String(amount) }),
  });
}

function sitOut(value: boolean): void {
  socket.emit(POKER_EVENTS.sitOut, { tableId, sitOut: value });
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{{ info?.name ?? "Table" }}</h1>
        <p v-if="info" class="small">
          Blinds <span class="chips">{{ formatChips(info.smallBlind) }}</span> /
          <span class="chips">{{ formatChips(info.bigBlind) }}</span> &middot; up to
          {{ info.maxSeats }} seats
        </p>
      </div>
      <RouterLink to="/poker" class="btn btn-ghost btn-sm">All tables</RouterLink>
    </div>

    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>

    <!-- Buy-in -->
    <section v-if="!seated" class="card buyin">
      <h2>Take a seat</h2>
      <p v-if="info" class="small muted">
        Buy in between <span class="chips">{{ formatChips(info.minBuyin) }}</span> and
        <span class="chips">{{ formatChips(info.maxBuyin) }}</span> LC. Those chips move from your
        wallet to the table, and come back when you leave.
      </p>

      <div class="field buyin-field">
        <label for="buyin">Buy-in (LC)</label>
        <input id="buyin" v-model.number="buyin" type="number" :min="Number(info?.minBuyin ?? 0)" />
      </div>

      <button
        class="btn btn-primary"
        :disabled="joining || !wallet.canAfford(String(buyin)) || buyin <= 0"
        @click="join"
      >
        <span v-if="joining" class="spinner"></span>
        <span v-else-if="!wallet.canAfford(String(buyin))">Not enough chips</span>
        <span v-else>Sit down with {{ formatChips(String(buyin)) }} LC</span>
      </button>
    </section>

    <!-- The table -->
    <section v-if="table" class="felt-wrap">
      <div class="felt">
        <!-- Pot and board -->
        <div class="centre">
          <div class="pot">
            <span class="tiny faint">Pot</span>
            <p class="chips chips-gold pot-amount">
              {{ formatChips(table.pots[0]?.amount ?? "0") }}
            </p>
          </div>

          <div class="board">
            <div
              v-for="(card, index) in table.board"
              :key="index"
              class="card-face"
              :class="cardColor(card)"
            >
              <span class="rank">{{ card[0] }}</span>
              <span class="suit">{{ suitGlyph(card) }}</span>
            </div>
            <div v-for="n in 5 - table.board.length" :key="`slot-${n}`" class="card-slot"></div>
          </div>

          <p v-if="table.street" class="tiny faint street">{{ table.street }}</p>
          <p v-else class="tiny faint street">Waiting for players</p>
        </div>

        <!-- Seats -->
        <div
          v-for="entry in seatPositions"
          :key="entry.seat.seatNo"
          class="seat"
          :class="{
            'seat-empty': !entry.seat.userId,
            'seat-turn': entry.seat.isTurn,
            'seat-folded': entry.seat.folded,
            'seat-mine': entry.seat.seatNo === table.yourSeat,
          }"
          :style="entry.style"
        >
          <template v-if="entry.seat.userId">
            <div class="seat-head">
              <span class="seat-name">{{ entry.seat.username }}</span>
              <span v-if="entry.seat.isDealer" class="dealer" title="Dealer">D</span>
            </div>

            <span class="chips seat-stack">{{ formatChips(entry.seat.stack) }}</span>

            <div v-if="entry.seat.holeCards" class="hole">
              <div
                v-for="card in entry.seat.holeCards"
                :key="card"
                class="card-face card-sm"
                :class="cardColor(card)"
              >
                <span class="rank">{{ card[0] }}</span>
                <span class="suit">{{ suitGlyph(card) }}</span>
              </div>
            </div>
            <div v-else-if="!entry.seat.folded && table.handId" class="hole">
              <div class="card-back"></div>
              <div class="card-back"></div>
            </div>

            <span v-if="BigInt(entry.seat.committed) > 0n" class="chips committed">
              {{ formatChips(entry.seat.committed) }}
            </span>

            <span v-if="entry.seat.allIn" class="badge badge-loss tiny-badge">All in</span>
            <span v-else-if="entry.seat.folded" class="badge badge-muted tiny-badge">Folded</span>
            <span v-else-if="entry.seat.sittingOut" class="badge badge-muted tiny-badge">Out</span>
          </template>

          <span v-else class="tiny faint">Seat {{ entry.seat.seatNo + 1 }}</span>
        </div>
      </div>
    </section>

    <!-- Hand result -->
    <div v-if="lastResult" class="alert alert-ok result">
      <strong>Hand complete.</strong>
      <span v-for="winner in lastResult.winners" :key="winner.seatNo">
        {{ winner.username ?? `Seat ${winner.seatNo + 1}` }} wins
        <span class="chips">{{ formatChips(winner.amount) }}</span> LC<span v-if="winner.handName">
          with {{ winner.handName }}</span
        >.
      </span>
    </div>

    <!-- Action bar -->
    <section v-if="seated" class="card actions">
      <template v-if="isMyTurn">
        <div class="action-row">
          <button class="btn btn-ghost" @click="act('fold')">Fold</button>

          <button v-if="actionOf('check')" class="btn" @click="act('check')">Check</button>

          <button v-if="actionOf('call')" class="btn btn-teal" @click="act('call')">
            Call {{ formatChips(actionOf("call")?.callAmount ?? "0") }}
          </button>

          <template v-if="raiseAction">
            <input
              v-model.number="raiseTo"
              type="range"
              class="raise-slider"
              :min="Number(raiseAction.min ?? 0)"
              :max="Number(raiseAction.max ?? 0)"
              :step="Number(info?.bigBlind ?? 1)"
            />
            <button class="btn btn-primary" @click="act(raiseAction.action, raiseTo)">
              {{ raiseAction.action === "bet" ? "Bet" : "Raise to" }}
              {{ formatChips(String(raiseTo)) }}
            </button>
          </template>

          <button v-if="actionOf('allin')" class="btn btn-danger" @click="act('allin')">
            All in
          </button>
        </div>

        <p v-if="mySeat?.timeLeftMs" class="tiny faint">
          {{ Math.ceil(mySeat.timeLeftMs / 1000) }}s to act
        </p>
      </template>

      <template v-else>
        <p class="small faint waiting">
          {{ table?.handId ? "Waiting for the other players…" : "Waiting for a hand to start…" }}
        </p>
      </template>

      <div class="action-foot">
        <button v-if="mySeat" class="btn btn-ghost btn-sm" @click="sitOut(!mySeat.sittingOut)">
          {{ mySeat.sittingOut ? "Sit back in" : "Sit out next hand" }}
        </button>
        <button class="btn btn-danger btn-sm" @click="leave">
          Leave &amp; cash out
          <span v-if="mySeat" class="chips">{{ formatChips(mySeat.stack) }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.buyin {
  margin-bottom: 18px;
}

.buyin-field {
  max-width: 200px;
}

.felt-wrap {
  margin-bottom: 16px;
}

.felt {
  position: relative;
  aspect-ratio: 16 / 9;
  min-height: 360px;
  border-radius: 180px / 120px;
  background: radial-gradient(ellipse at 50% 42%, #14503f 0%, #0e3a2e 55%, #0a2a21 100%);
  border: 10px solid #1b2b3b;
  box-shadow:
    inset 0 0 70px rgba(0, 0, 0, 0.6),
    var(--shadow-lg);
}

.centre {
  position: absolute;
  left: 50%;
  top: 44%;
  transform: translate(-50%, -50%);
  text-align: center;
  width: min(420px, 74%);
}

.pot-amount {
  margin: 0 0 8px;
  font-size: 1.3rem;
  font-weight: 700;
}

.board {
  display: flex;
  gap: 5px;
  justify-content: center;
}

.street {
  margin: 8px 0 0;
  text-transform: capitalize;
  letter-spacing: 0.05em;
}

.card-face {
  width: 40px;
  height: 56px;
  border-radius: 5px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-weight: 750;
  line-height: 1;
  box-shadow: var(--shadow-sm);
}

.card-face.red {
  color: #dc2626;
}
.card-face.black {
  color: #0f172a;
}

.card-face .rank {
  font-size: 1rem;
}
.card-face .suit {
  font-size: 0.95rem;
}

.card-sm {
  width: 28px;
  height: 39px;
}

.card-sm .rank {
  font-size: 0.78rem;
}
.card-sm .suit {
  font-size: 0.72rem;
}

.card-slot {
  width: 40px;
  height: 56px;
  border-radius: 5px;
  border: 1px dashed rgba(255, 255, 255, 0.14);
}

.card-back {
  width: 28px;
  height: 39px;
  border-radius: 4px;
  background: repeating-linear-gradient(45deg, #1e3a8a, #1e3a8a 3px, #172f6e 3px, #172f6e 6px);
  border: 1px solid #2a4a9e;
}

.seat {
  position: absolute;
  transform: translate(-50%, -50%);
  min-width: 108px;
  padding: 7px 10px;
  border-radius: var(--radius);
  background: rgba(7, 13, 20, 0.84);
  border: 1px solid var(--border-strong);
  text-align: center;
  transition:
    border-color 180ms ease,
    box-shadow 180ms ease;
}

.seat-empty {
  background: rgba(7, 13, 20, 0.4);
  border-style: dashed;
}

.seat-turn {
  border-color: var(--gold);
  box-shadow: 0 0 0 3px var(--gold-glow);
}

.seat-folded {
  opacity: 0.45;
}

.seat-mine {
  border-color: var(--teal);
}

.seat-head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.seat-name {
  font-size: 0.8rem;
  font-weight: 650;
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dealer {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #f8fafc;
  color: #0f172a;
  font-size: 0.6rem;
  font-weight: 800;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.seat-stack {
  display: block;
  font-size: 0.82rem;
  color: var(--gold);
  font-weight: 650;
}

.hole {
  display: flex;
  gap: 3px;
  justify-content: center;
  margin-top: 5px;
}

.committed {
  display: block;
  font-size: 0.72rem;
  color: var(--teal);
  margin-top: 4px;
}

.tiny-badge {
  font-size: 0.56rem;
  padding: 1px 5px;
  margin-top: 4px;
}

.result {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.actions {
  position: sticky;
  bottom: 12px;
}

.action-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.raise-slider {
  flex: 1;
  min-width: 120px;
  accent-color: var(--gold);
}

.waiting {
  margin: 0;
}

.action-foot {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

@media (max-width: 720px) {
  .felt {
    aspect-ratio: 3 / 4;
    min-height: 440px;
    border-radius: 120px / 150px;
  }

  .centre {
    width: 86%;
  }

  .card-face {
    width: 31px;
    height: 44px;
  }

  .card-slot {
    width: 31px;
    height: 44px;
  }

  .seat {
    min-width: 88px;
    padding: 5px 7px;
  }
}
</style>
