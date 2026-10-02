<script setup lang="ts">
/**
 * The sportsbook: fixtures, a bet slip, and open bets.
 *
 * Odds are locked at placement. The slip remembers the price the player clicked, and if the
 * server says it has moved it returns `ODDS_CHANGED` with the current price - we then show both
 * and make them confirm, rather than quietly placing the bet at a worse number.
 */
import { computed, onMounted, ref } from "vue";
import {
  formatChips,
  type BetStatus,
  type Selection,
  type SportsBet,
  type SportsEvent,
} from "@luck-cays/shared";
import { api, ApiError, idempotencyKey } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useWalletStore } from "@/stores/wallet";

const auth = useAuthStore();
const wallet = useWalletStore();

const events = ref<SportsEvent[]>([]);
const sports = ref<Array<{ sport: string; leagues: string[]; count: number }>>([]);
const activeSport = ref<string | null>(null);
const bets = ref<SportsBet[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

/** The pick currently in the slip. One at a time: v1 has no accumulators. */
interface SlipPick {
  eventId: string;
  marketId: string;
  marketType: string;
  line: string | null;
  selection: Selection;
  home: string;
  away: string;
}

const slip = ref<SlipPick | null>(null);
const stake = ref(500);
const placing = ref(false);
const slipError = ref<string | null>(null);
/** Set when the server reports the odds moved; holds the new price to confirm. */
const newOdds = ref<string | null>(null);
const placed = ref<SportsBet | null>(null);

const filtered = computed(() =>
  activeSport.value === null
    ? events.value
    : events.value.filter((event) => event.sport === activeSport.value),
);

const potentialReturn = computed(() => {
  if (!slip.value) return 0n;
  const odds = Number(newOdds.value ?? slip.value.selection.odds);
  // Mirrors the server: scaled integer arithmetic, floored.
  return (BigInt(stake.value) * BigInt(Math.round(odds * 100))) / 100n;
});

const openBets = computed(() => bets.value.filter((bet) => bet.status === "open"));
const settledBets = computed(() => bets.value.filter((bet) => bet.status !== "open"));

onMounted(async () => {
  try {
    const [eventResult, sportResult] = await Promise.all([
      api.get<{ events: SportsEvent[] }>("/sports/events?limit=50"),
      api.get<{ sports: Array<{ sport: string; leagues: string[]; count: number }> }>(
        "/sports/sports",
      ),
    ]);
    events.value = eventResult.events;
    sports.value = sportResult.sports;
  } catch {
    error.value = "Could not load fixtures.";
  } finally {
    loading.value = false;
  }

  if (auth.isSignedIn) await loadBets();
});

async function loadBets(): Promise<void> {
  try {
    const result = await api.get<{ bets: SportsBet[] }>("/sports/bets?limit=25");
    bets.value = result.bets;
  } catch {
    // The book is still usable without the bet list.
  }
}

function pick(
  event: SportsEvent,
  market: SportsEvent["markets"][number],
  selection: Selection,
): void {
  slip.value = {
    eventId: event.id,
    marketId: market.id,
    marketType: market.type,
    line: market.line,
    selection,
    home: event.home,
    away: event.away,
  };
  slipError.value = null;
  newOdds.value = null;
  placed.value = null;
}

function isPicked(marketId: string, key: string): boolean {
  return slip.value?.marketId === marketId && slip.value.selection.key === key;
}

function clearSlip(): void {
  slip.value = null;
  slipError.value = null;
  newOdds.value = null;
}

async function place(): Promise<void> {
  const pickValue = slip.value;
  if (!pickValue) return;

  placing.value = true;
  slipError.value = null;

  try {
    const bet = await api.post<SportsBet>("/sports/bets", {
      marketId: pickValue.marketId,
      selection: pickValue.selection.key,
      // If the odds moved, send the new price and accept it - the player has just confirmed it.
      odds: newOdds.value ?? pickValue.selection.odds,
      stake: String(stake.value),
      idempotencyKey: idempotencyKey("bet"),
      acceptOddsChange: newOdds.value !== null,
    });

    placed.value = bet;
    slip.value = null;
    newOdds.value = null;
    await Promise.all([wallet.refresh(), loadBets()]);
  } catch (caught) {
    if (caught instanceof ApiError && caught.code === "ODDS_CHANGED") {
      const details = caught.details as { currentOdds?: string } | undefined;
      newOdds.value = details?.currentOdds ?? null;
      slipError.value = `The price moved to ${newOdds.value}. Confirm to place at the new odds.`;
    } else {
      slipError.value = caught instanceof ApiError ? caught.message : "Could not place that bet.";
    }
  } finally {
    placing.value = false;
  }
}

function marketLabel(type: string, line: string | null): string {
  if (type === "moneyline") return "Match result";
  if (type === "spread") return `Spread ${line ?? ""}`.trim();
  return `Total ${line ?? ""}`.trim();
}

function statusClass(status: BetStatus): string {
  if (status === "won") return "badge-win";
  if (status === "lost") return "badge-loss";
  if (status === "open") return "badge-teal";
  return "badge-muted";
}

function kickoff(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  });
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Sports betting</h1>
        <p>
          Pre-match moneyline, spreads and totals. Your price is locked the moment the bet is
          accepted, and settlement runs automatically once a result is in.
        </p>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div v-if="placed" class="alert alert-ok">
      Bet placed: <strong>{{ placed.selectionLabel }}</strong> at {{ placed.odds }} for
      <span class="chips">{{ formatChips(placed.stake) }}</span> LC, returning
      <span class="chips">{{ formatChips(placed.potentialWin) }}</span> LC if it wins.
    </div>

    <div class="layout">
      <section>
        <!-- Sport filter -->
        <div v-if="sports.length" class="filters">
          <button
            class="filter"
            :class="{ 'filter-on': activeSport === null }"
            @click="activeSport = null"
          >
            All
          </button>
          <button
            v-for="entry in sports"
            :key="entry.sport"
            class="filter"
            :class="{ 'filter-on': activeSport === entry.sport }"
            @click="activeSport = entry.sport"
          >
            {{ entry.sport }}
            <span class="faint">{{ entry.count }}</span>
          </button>
        </div>

        <div v-if="loading" class="empty">Loading fixtures&hellip;</div>

        <div v-else-if="filtered.length === 0" class="empty">
          No upcoming fixtures. The sync job seeds demo fixtures every 15 minutes.
        </div>

        <article v-for="event in filtered" :key="event.id" class="card event">
          <div class="event-head">
            <div>
              <span class="badge badge-muted">{{ event.league }}</span>
              <h3 class="teams">{{ event.home }} <span class="faint">v</span> {{ event.away }}</h3>
            </div>
            <span class="tiny faint nowrap">{{ kickoff(event.startsAt) }}</span>
          </div>

          <div v-for="market in event.markets" :key="market.id" class="market">
            <span class="market-label tiny faint">
              {{ marketLabel(market.type, market.line) }}
            </span>
            <div class="odds-row">
              <button
                v-for="selection in market.selections"
                :key="selection.key"
                class="odds"
                :class="{ 'odds-on': isPicked(market.id, selection.key) }"
                :disabled="!auth.isSignedIn"
                @click="pick(event, market, selection)"
              >
                <span class="odds-label">{{ selection.label }}</span>
                <span class="odds-price mono">{{ selection.odds }}</span>
              </button>
            </div>
          </div>
        </article>
      </section>

      <!-- Bet slip and bets -->
      <aside class="stack side">
        <div class="card bet-slip">
          <h3>Bet slip</h3>

          <template v-if="!auth.isSignedIn">
            <p class="small muted"><RouterLink to="/login">Sign in</RouterLink> to place a bet.</p>
          </template>

          <template v-else-if="!slip">
            <p class="small faint">Pick a price to start a bet.</p>
          </template>

          <template v-else>
            <p class="slip-match tiny faint">{{ slip.home }} v {{ slip.away }}</p>
            <p class="slip-pick">{{ slip.selection.label }}</p>
            <div class="row-between slip-meta">
              <span class="tiny faint">{{ marketLabel(slip.marketType, slip.line) }}</span>
              <span class="mono">
                <span v-if="newOdds" class="old-odds">{{ slip.selection.odds }}</span>
                {{ newOdds ?? slip.selection.odds }}
              </span>
            </div>

            <div class="field">
              <label for="stake">Stake (LC)</label>
              <input id="stake" v-model.number="stake" type="number" min="1" step="100" />
            </div>

            <div class="quick-stakes">
              <button
                v-for="amount in [100, 500, 1000, 5000]"
                :key="amount"
                class="btn btn-sm"
                @click="stake = amount"
              >
                {{ formatChips(String(amount)) }}
              </button>
            </div>

            <div class="row-between returns">
              <span class="small muted">Potential return</span>
              <span class="chips chips-gold bold">{{ formatChips(potentialReturn) }} LC</span>
            </div>

            <div v-if="slipError" class="alert alert-warn tiny">{{ slipError }}</div>

            <button
              class="btn btn-block"
              :class="newOdds ? 'btn-teal' : 'btn-primary'"
              :disabled="placing || stake < 1 || !wallet.canAfford(String(stake))"
              @click="place"
            >
              <span v-if="placing" class="spinner"></span>
              <span v-else-if="newOdds">Confirm at {{ newOdds }}</span>
              <span v-else-if="!wallet.canAfford(String(stake))">Not enough chips</span>
              <span v-else>Place bet</span>
            </button>

            <button class="btn btn-ghost btn-sm btn-block clear" @click="clearSlip">Clear</button>
          </template>
        </div>

        <div v-if="auth.isSignedIn" class="card card-tight">
          <h3>
            Open bets <span class="faint tiny">{{ openBets.length }}</span>
          </h3>

          <div v-if="openBets.length === 0" class="tiny faint">No open bets.</div>

          <div v-for="bet in openBets" :key="bet.id" class="bet-row">
            <div class="row-between">
              <span class="small bold">{{ bet.selectionLabel }}</span>
              <span class="badge" :class="statusClass(bet.status)">{{ bet.status }}</span>
            </div>
            <p class="tiny faint slip-match">{{ bet.event.home }} v {{ bet.event.away }}</p>
            <div class="row-between tiny">
              <span class="faint">
                <span class="chips">{{ formatChips(bet.stake) }}</span> at {{ bet.odds }}
              </span>
              <span class="chips chips-gold">{{ formatChips(bet.potentialWin) }} LC</span>
            </div>
          </div>
        </div>

        <div v-if="settledBets.length" class="card card-tight">
          <h3>Settled</h3>
          <div v-for="bet in settledBets.slice(0, 8)" :key="bet.id" class="bet-row">
            <div class="row-between">
              <span class="small">{{ bet.selectionLabel }}</span>
              <span class="badge" :class="statusClass(bet.status)">{{ bet.status }}</span>
            </div>
            <div class="row-between tiny">
              <span v-if="bet.event.result" class="faint">
                {{ bet.event.result.homeScore }}&ndash;{{ bet.event.result.awayScore }}
              </span>
              <span class="chips" :class="bet.status === 'won' ? 'chips-win' : 'faint'">
                {{
                  bet.status === "won"
                    ? `+${formatChips(bet.potentialWin)}`
                    : `−${formatChips(bet.stake)}`
                }}
              </span>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 18px;
  align-items: start;
}

.filters {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.filter {
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  padding: 6px 13px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  display: inline-flex;
  gap: 6px;
}

.filter-on {
  background: rgba(245, 195, 88, 0.12);
  border-color: var(--gold-dim);
  color: var(--gold);
}

.event {
  margin-bottom: 12px;
}

.event-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}

.teams {
  margin: 6px 0 0;
  font-size: 1.02rem;
}

.market {
  margin-top: 9px;
}

.market-label {
  display: block;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 700;
}

.odds-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 6px;
}

.odds {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  background: var(--surface-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 7px 10px;
  color: var(--text);
  font: inherit;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease;
  text-align: left;
}

.odds:hover:not(:disabled) {
  border-color: var(--teal-dim);
  background: var(--surface-2);
}

.odds:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.odds-on {
  border-color: var(--gold);
  background: rgba(245, 195, 88, 0.1);
}

.odds-label {
  font-size: 0.76rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.odds-price {
  font-weight: 700;
  color: var(--gold);
}

.side {
  position: sticky;
  top: calc(var(--header-height) + 16px);
}

.slip-match {
  margin: 0;
}

.slip-pick {
  font-weight: 650;
  margin: 2px 0 6px;
}

.slip-meta {
  margin-bottom: 12px;
}

.old-odds {
  text-decoration: line-through;
  color: var(--text-faint);
  margin-right: 6px;
  font-size: 0.85em;
}

.quick-stakes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
  margin-bottom: 12px;
}

.quick-stakes .btn {
  padding: 5px 2px;
  font-size: 0.74rem;
}

.returns {
  padding: 9px 0;
  border-top: 1px solid var(--border);
  margin-bottom: 10px;
}

.clear {
  margin-top: 7px;
}

.bet-row {
  padding: 9px 0;
  border-bottom: 1px solid rgba(35, 55, 75, 0.45);
}

.bet-row:last-child {
  border-bottom: 0;
}

@media (max-width: 920px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .side {
    position: static;
    order: -1;
  }
}
</style>
