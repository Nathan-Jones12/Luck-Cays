<script setup lang="ts">
/**
 * One slot game: reels, bet selector, autoplay, paytable and spin history.
 *
 * The spin loop is deliberately ordered: the server settles the round first, THEN the reels
 * animate to the stops it returned. Animating first and reconciling after would mean showing a
 * result the server had not agreed to, and a failed request would have to be un-shown.
 *
 * Autoplay is a client-side loop over the same endpoint. The server has no autoplay mode, so a
 * stop condition can never influence an outcome - it only decides whether to ask for another
 * spin.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute } from "vue-router";
import {
  chipsFromJson,
  formatChips,
  type SlotConfig,
  type SlotSpinResult,
} from "@luck-cays/shared";
import { api, ApiError, idempotencyKey } from "@/api/client";
import { useWalletStore } from "@/stores/wallet";
import { ReelRenderer } from "@/games/slots/ReelRenderer";

const route = useRoute();
const wallet = useWalletStore();

const slug = String(route.params["slug"]);

const config = shallowRef<SlotConfig | null>(null);
const canvasHost = ref<HTMLElement | null>(null);
let renderer: ReelRenderer | null = null;

const loading = ref(true);
const error = ref<string | null>(null);
const spinning = ref(false);

const bet = ref(100);
const lastResult = ref<SlotSpinResult | null>(null);
const freeSpinsRemaining = ref(0);
const history = ref<Array<{ bet: string; win: string; free: boolean }>>([]);

// Autoplay
const autoplayRemaining = ref(0);
const autoSpins = ref(25);
const stopOnFreeSpins = ref(true);
const stopOnBigWin = ref(true);
const turbo = ref(false);
/** Set when a stop condition fires, so the player is told why autoplay ended. */
const autoStopReason = ref<string | null>(null);

const showPaytable = ref(false);
const soundOn = ref(false);

const lineBet = computed(() =>
  config.value ? Math.floor(bet.value / config.value.paylines.length) : 0,
);

const canSpin = computed(
  () =>
    !spinning.value &&
    config.value !== null &&
    (freeSpinsRemaining.value > 0 || wallet.canAfford(String(bet.value))),
);

const lastWin = computed(() => (lastResult.value ? chipsFromJson(lastResult.value.totalWin) : 0n));

/** Paying symbols, biggest first, for the paytable. */
const paySymbols = computed(() => {
  const cfg = config.value;
  if (!cfg) return [];
  return cfg.symbols
    .filter((symbol) => cfg.paytable[symbol.id] !== undefined)
    .map((symbol) => ({
      ...symbol,
      pays: cfg.paytable[symbol.id] as Record<string, number>,
    }))
    .sort((a, b) => (b.pays["5"] ?? 0) - (a.pays["5"] ?? 0));
});

onMounted(async () => {
  try {
    const [gameResult, freeSpinResult] = await Promise.all([
      api.get<{ config: SlotConfig }>(`/slots/${slug}`),
      api
        .get<{ freeSpins: { remaining: number; bet: string } | null }>(`/slots/${slug}/free-spins`)
        .catch(() => ({ freeSpins: null })),
    ]);

    config.value = gameResult.config;

    // Default to a bet the player can actually afford: the mid-ladder level if possible.
    const affordable = gameResult.config.betLevels.filter((level) =>
      wallet.canAfford(String(level)),
    );
    bet.value =
      affordable[Math.min(1, affordable.length - 1)] ?? gameResult.config.betLevels[0] ?? 20;

    // An interrupted free-spin run is resumed, at the bet it was locked to.
    if (freeSpinResult.freeSpins) {
      freeSpinsRemaining.value = freeSpinResult.freeSpins.remaining;
      bet.value = Number(freeSpinResult.freeSpins.bet);
    }

    loading.value = false;

    // Wait for the canvas host to exist before building the renderer.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (canvasHost.value) {
      renderer = new ReelRenderer(canvasHost.value, gameResult.config);
      await renderer.init();
    }
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : "Could not load this game.";
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  autoplayRemaining.value = 0;
  renderer?.destroy();
  renderer = null;
});

function remember(result: SlotSpinResult): void {
  history.value.unshift({ bet: result.bet, win: result.totalWin, free: result.isFreeSpin });
  if (history.value.length > 12) history.value.pop();
}

async function spinOnce(): Promise<SlotSpinResult | null> {
  if (!config.value) return null;

  spinning.value = true;
  error.value = null;

  try {
    // The server settles the whole round before anything animates.
    const result = await api.post<SlotSpinResult>("/slots/spin", {
      gameSlug: slug,
      bet: String(bet.value),
      idempotencyKey: idempotencyKey("spin"),
    });

    await renderer?.spinTo(result.stops, { quick: turbo.value });

    lastResult.value = result;
    freeSpinsRemaining.value = result.freeSpinsRemaining;
    wallet.setBalance(result.balanceAfter);
    remember(result);

    if (result.lineWins.length > 0 || result.scatterWin) {
      renderer?.highlightWins(result.lineWins, result.scatterWin);
    }

    return result;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : "That spin could not be placed.";
    // Any failure stops autoplay: continuing to hammer a failing endpoint is never right.
    autoplayRemaining.value = 0;
    return null;
  } finally {
    spinning.value = false;
  }
}

async function spin(): Promise<void> {
  autoplayRemaining.value = 0;
  autoStopReason.value = null;
  await spinOnce();
}

function startAutoplay(): void {
  autoStopReason.value = null;
  autoplayRemaining.value = autoSpins.value;
  void runAutoplay();
}

function stopAutoplay(): void {
  autoplayRemaining.value = 0;
  autoStopReason.value = "Stopped.";
}

async function runAutoplay(): Promise<void> {
  while (autoplayRemaining.value > 0) {
    if (!canSpin.value && freeSpinsRemaining.value === 0) {
      autoStopReason.value = "Out of chips for that bet.";
      break;
    }

    const result = await spinOnce();
    if (!result) break;

    // A free spin is a gift, not one of the player's purchased autoplay spins.
    if (!result.isFreeSpin) autoplayRemaining.value -= 1;

    if (stopOnFreeSpins.value && result.freeSpinsAwarded > 0) {
      autoStopReason.value = `Bonus won: ${result.freeSpinsAwarded} free spins.`;
      autoplayRemaining.value = 0;
      break;
    }

    // "Big" is relative to the stake, which is the only definition that holds at every bet
    // level - a fixed chip threshold would be meaningless at 20 LC and unreachable at 5,000.
    if (stopOnBigWin.value && chipsFromJson(result.totalWin) >= BigInt(bet.value) * 20n) {
      autoStopReason.value = `Big win: ${formatChips(result.totalWin)} LC.`;
      autoplayRemaining.value = 0;
      break;
    }

    // A breath between spins, so autoplay is watchable rather than a blur.
    await new Promise((resolve) => setTimeout(resolve, turbo.value ? 120 : 320));
  }
}

function adjustBet(direction: 1 | -1): void {
  const levels = config.value?.betLevels ?? [];
  const index = levels.indexOf(bet.value);
  const next = levels[Math.max(0, Math.min(levels.length - 1, index + direction))];
  if (next !== undefined) bet.value = next;
}
</script>

<template>
  <div class="page">
    <div v-if="loading" class="empty">Loading game&hellip;</div>

    <div v-else-if="!config" class="alert alert-error">
      {{ error ?? "This game could not be loaded." }}
    </div>

    <template v-else>
      <div class="page-head">
        <div>
          <h1>{{ config.name }}</h1>
          <p class="small">
            {{ config.paylines.length }} lines &middot; {{ (config.rtpTarget * 100).toFixed(1) }}%
            target RTP &middot; line bet
            <span class="chips">{{ formatChips(String(lineBet)) }}</span> LC
          </p>
        </div>
        <RouterLink to="/slots" class="btn btn-ghost btn-sm">All slots</RouterLink>
      </div>

      <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>

      <!-- Free-spin banner -->
      <div v-if="freeSpinsRemaining > 0" class="alert alert-warn free-banner">
        <strong>{{ freeSpinsRemaining }} free spins remaining</strong> at
        <span class="chips">{{ formatChips(String(bet)) }}</span> LC, with wins multiplied &times;{{
          config.scatter.freeSpinMultiplier
        }}. The bet is locked for the run.
      </div>

      <div class="layout">
        <!-- Reels + controls -->
        <section>
          <div class="machine card">
            <div ref="canvasHost" class="canvas-host"></div>

            <!-- Win readout -->
            <div class="readout" :class="{ 'readout-win': lastWin > 0n }">
              <template v-if="lastResult && lastWin > 0n">
                <span class="readout-label">Win</span>
                <span class="chips chips-win readout-amount">
                  +{{ formatChips(lastResult.totalWin) }} LC
                </span>
                <span v-if="lastResult.scatterWin" class="badge badge-teal">
                  {{ lastResult.scatterWin.count }} scatters
                </span>
                <span v-if="lastResult.freeSpinsAwarded > 0" class="badge badge-gold">
                  +{{ lastResult.freeSpinsAwarded }} free spins
                </span>
              </template>
              <template v-else-if="lastResult">
                <span class="readout-label faint">No win on that spin</span>
              </template>
              <template v-else>
                <span class="readout-label faint">Place a bet to spin</span>
              </template>
            </div>

            <!-- Controls -->
            <div class="controls">
              <div class="bet">
                <label>Bet</label>
                <div class="bet-stepper">
                  <button
                    class="btn btn-sm"
                    :disabled="spinning || freeSpinsRemaining > 0 || bet === config.betLevels[0]"
                    aria-label="Lower bet"
                    @click="adjustBet(-1)"
                  >
                    &minus;
                  </button>
                  <span class="chips bet-value">{{ formatChips(String(bet)) }}</span>
                  <button
                    class="btn btn-sm"
                    :disabled="
                      spinning ||
                      freeSpinsRemaining > 0 ||
                      bet === config.betLevels[config.betLevels.length - 1]
                    "
                    aria-label="Raise bet"
                    @click="adjustBet(1)"
                  >
                    +
                  </button>
                </div>
              </div>

              <button
                class="btn btn-primary spin-btn"
                :disabled="!canSpin || autoplayRemaining > 0"
                @click="spin"
              >
                <span v-if="spinning" class="spinner"></span>
                <span v-else-if="freeSpinsRemaining > 0">Free spin</span>
                <span v-else>Spin</span>
              </button>

              <button v-if="autoplayRemaining > 0" class="btn btn-danger" @click="stopAutoplay">
                Stop ({{ autoplayRemaining }})
              </button>
              <button v-else class="btn btn-teal" :disabled="!canSpin" @click="startAutoplay">
                Auto &times;{{ autoSpins }}
              </button>
            </div>

            <div v-if="autoStopReason" class="alert alert-info auto-note">
              {{ autoStopReason }}
            </div>

            <!-- Autoplay settings and toggles -->
            <details class="auto-settings">
              <summary>Autoplay &amp; options</summary>
              <div class="auto-grid">
                <div class="field">
                  <label for="spins">Number of spins</label>
                  <select id="spins" v-model.number="autoSpins">
                    <option :value="10">10</option>
                    <option :value="25">25</option>
                    <option :value="50">50</option>
                    <option :value="100">100</option>
                  </select>
                </div>

                <label class="toggle">
                  <input v-model="stopOnFreeSpins" type="checkbox" />
                  <span>Stop when a bonus is won</span>
                </label>

                <label class="toggle">
                  <input v-model="stopOnBigWin" type="checkbox" />
                  <span>Stop on a win of 20&times; the bet or more</span>
                </label>

                <label class="toggle">
                  <input v-model="turbo" type="checkbox" />
                  <span>Turbo spins</span>
                </label>

                <label class="toggle">
                  <input v-model="soundOn" type="checkbox" />
                  <span>
                    Sound
                    <span class="tiny faint">(no audio in this build)</span>
                  </span>
                </label>
              </div>
            </details>
          </div>
        </section>

        <!-- Side: history + paytable -->
        <aside class="stack">
          <div class="card card-tight">
            <div class="row-between">
              <h3>Recent spins</h3>
              <span class="tiny faint">{{ history.length }}</span>
            </div>

            <div v-if="history.length === 0" class="tiny faint">Nothing yet.</div>

            <ul v-else class="history">
              <li v-for="(round, index) in history" :key="index" class="history-row">
                <span class="tiny faint">
                  {{ round.free ? "Free" : formatChips(round.bet) }}
                </span>
                <span class="chips tiny" :class="Number(round.win) > 0 ? 'chips-win' : 'faint'">
                  {{ Number(round.win) > 0 ? `+${formatChips(round.win)}` : "—" }}
                </span>
              </li>
            </ul>
          </div>

          <div class="card card-tight">
            <button class="paytable-toggle" @click="showPaytable = !showPaytable">
              <h3>Paytable</h3>
              <span class="faint">{{ showPaytable ? "−" : "+" }}</span>
            </button>

            <template v-if="showPaytable">
              <p class="tiny faint">
                Multiples of the line bet ({{ formatChips(String(lineBet)) }} LC), paid left to
                right. Scatters pay on the total bet from anywhere.
              </p>

              <table class="table paytable">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th class="right">3</th>
                    <th class="right">4</th>
                    <th class="right">5</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="symbol in paySymbols" :key="symbol.id">
                    <td>
                      <span class="sym-name">{{ symbol.name }}</span>
                      <span v-if="symbol.kind === 'wild'" class="badge badge-gold tiny-badge">
                        Wild
                      </span>
                    </td>
                    <td class="right mono">{{ symbol.pays["3"] ?? "—" }}</td>
                    <td class="right mono">{{ symbol.pays["4"] ?? "—" }}</td>
                    <td class="right mono">{{ symbol.pays["5"] ?? "—" }}</td>
                  </tr>
                </tbody>
              </table>

              <hr class="divider" />

              <h4 class="scatter-head">
                Scatter &mdash;
                {{ config.symbols.find((s) => s.id === config?.scatter.symbol)?.name }}
              </h4>
              <table class="table paytable">
                <thead>
                  <tr>
                    <th>Scatters</th>
                    <th class="right">Pays</th>
                    <th class="right">Free spins</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="count in ['3', '4', '5']" :key="count">
                    <td>{{ count }}</td>
                    <td class="right mono">
                      {{ config.scatter.pays[count] ? `${config.scatter.pays[count]}× bet` : "—" }}
                    </td>
                    <td class="right mono">{{ config.scatter.freeSpins[count] ?? "—" }}</td>
                  </tr>
                </tbody>
              </table>
              <p class="tiny faint">
                Free-spin wins are multiplied by &times;{{ config.scatter.freeSpinMultiplier }}.
              </p>
            </template>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 290px;
  gap: 18px;
  align-items: start;
}

.machine {
  padding: 14px;
}

.canvas-host {
  width: 100%;
  border-radius: var(--radius);
  overflow: hidden;
  /* Reserves height before Pixi reports a size, so the layout does not jump on load. */
  min-height: 180px;
  background: #0b141d;
}

.free-banner {
  margin-bottom: 14px;
}

.readout {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-height: 44px;
  padding: 9px 12px;
  margin-top: 12px;
  border-radius: var(--radius);
  background: var(--bg);
  border: 1px solid var(--border);
  transition: border-color 220ms ease;
}

.readout-win {
  border-color: var(--win-dim);
  background: rgba(74, 222, 128, 0.07);
}

.readout-label {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.readout-amount {
  font-size: 1.25rem;
  font-weight: 700;
}

.controls {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.bet label {
  margin-bottom: 4px;
}

.bet-stepper {
  display: flex;
  align-items: center;
  gap: 7px;
}

.bet-value {
  min-width: 68px;
  text-align: center;
  font-weight: 700;
  color: var(--gold);
}

.spin-btn {
  flex: 1;
  min-width: 130px;
  min-height: 44px;
  font-size: 1.05rem;
}

.auto-note {
  margin: 12px 0 0;
}

.auto-settings {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.auto-settings summary {
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 650;
  color: var(--text-muted);
}

.auto-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 0.86rem;
  font-weight: 400;
  color: var(--text-muted);
  text-transform: none;
  letter-spacing: 0;
  margin: 0;
  cursor: pointer;
}

.history {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.history-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  border-bottom: 1px solid rgba(35, 55, 75, 0.4);
}

.paytable-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  padding: 0;
  cursor: pointer;
}

.paytable-toggle h3 {
  margin: 0;
}

.paytable {
  font-size: 0.82rem;
  margin-top: 8px;
}

.paytable th,
.paytable td {
  padding: 5px 6px;
}

.sym-name {
  font-weight: 600;
}

.tiny-badge {
  margin-left: 6px;
  font-size: 0.6rem;
  padding: 1px 6px;
}

.scatter-head {
  font-size: 0.9rem;
  margin: 0 0 4px;
}

@media (max-width: 920px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .controls {
    gap: 8px;
  }

  .spin-btn {
    order: -1;
    width: 100%;
    flex: 1 1 100%;
  }
}
</style>
