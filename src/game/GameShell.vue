<script setup lang="ts">
/**
 * The embeddable game shell.
 *
 * Deliberately not the main site's slot page. This one has no router, no Pinia, no header,
 * no navigation - it is one game and nothing else, because it renders inside someone else's
 * layout and anything extra would fight with it.
 *
 * It reuses `ReelRenderer` unchanged. That reuse is the whole reason the renderer takes a
 * config and a set of stops rather than reaching for a store.
 *
 * Session handling: the shell redeems its launch ticket once on mount, holds the resulting
 * game-scoped token in memory, and tells the host what is happening over `postMessage`. It
 * never holds a player access token, so there is nothing here worth stealing beyond the
 * ability to spin one game.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import {
  chipsFromJson,
  EMBED_PROTOCOL,
  formatChips,
  type Brand,
  type GameSession,
  type SlotConfig,
  type SlotSpinResult,
} from "@luck-cays/shared";
import { ReelRenderer } from "@/games/slots/ReelRenderer";
import { exchangeTicket, gameGet, gamePost, setGameToken } from "./gameClient";
import { listenToHost, postToHost } from "./hostBridge";

const params = new URLSearchParams(window.location.search);
/** Used only to paint the right colours before the ticket is redeemed. Never trusted. */
const brandHint = (params.get("brand") ?? "luck-cays") as Brand;

const session = ref<GameSession | null>(null);
const config = shallowRef<SlotConfig | null>(null);
const canvasHost = ref<HTMLElement | null>(null);
let renderer: ReelRenderer | null = null;

const loading = ref(true);
const fatal = ref<string | null>(null);
const error = ref<string | null>(null);
const spinning = ref(false);

const balance = ref("0");
const bet = ref(100);
const lastResult = ref<SlotSpinResult | null>(null);
const freeSpinsRemaining = ref(0);
const showPaytable = ref(false);
/** Set by the host. No audio in this build, so it is recorded and surfaced, not acted on. */
const muted = ref(false);

let stopListening: (() => void) | null = null;

const lineBet = computed(() =>
  config.value ? Math.floor(bet.value / config.value.paylines.length) : 0,
);

const canSpin = computed(
  () =>
    !spinning.value &&
    config.value !== null &&
    (freeSpinsRemaining.value > 0 || chipsFromJson(balance.value) >= BigInt(bet.value)),
);

const lastWin = computed(() => (lastResult.value ? chipsFromJson(lastResult.value.totalWin) : 0n));

/** Tell the host how tall we are, so it can size the iframe and avoid an inner scrollbar. */
let resizeObserver: ResizeObserver | null = null;

function reportHeight(): void {
  postToHost({
    protocol: EMBED_PROTOCOL,
    type: "resize",
    height: Math.ceil(document.documentElement.scrollHeight),
  });
}

onMounted(async () => {
  const token = params.get("token");
  if (!token) {
    fatal.value = "This game was opened without a launch link.";
    loading.value = false;
    return;
  }

  try {
    // One shot. If this fails the ticket is spent, expired or from the wrong origin, and the
    // host has to mint a new one - which is exactly what we tell it below.
    const redeemed = await exchangeTicket(token);
    setGameToken(redeemed.sessionToken);
    session.value = redeemed;
    balance.value = redeemed.balance;

    // Scrub the ticket out of the address bar now it is spent, so it does not sit in the
    // iframe's history or get picked up by anything reading location.
    window.history.replaceState({}, "", window.location.pathname);

    const loaded = await gameGet<{ config: SlotConfig }>(`/slots/${redeemed.gameSlug}`);
    config.value = loaded.config;

    const affordable = loaded.config.betLevels.filter(
      (level) => chipsFromJson(balance.value) >= BigInt(level),
    );
    bet.value = affordable[Math.min(1, affordable.length - 1)] ?? loaded.config.betLevels[0] ?? 20;

    // Resume an interrupted free-spin run.
    const free = await gameGet<{ freeSpins: { remaining: number; bet: string } | null }>(
      `/slots/${redeemed.gameSlug}/free-spins`,
    ).catch(() => ({ freeSpins: null }));

    if (free.freeSpins) {
      freeSpinsRemaining.value = free.freeSpins.remaining;
      bet.value = Number(free.freeSpins.bet);
    }

    loading.value = false;

    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (canvasHost.value) {
      renderer = new ReelRenderer(canvasHost.value, loaded.config);
      await renderer.init();
    }

    postToHost({ protocol: EMBED_PROTOCOL, type: "ready", gameSlug: redeemed.gameSlug });
    postToHost({ protocol: EMBED_PROTOCOL, type: "balance", balance: balance.value });

    resizeObserver = new ResizeObserver(reportHeight);
    resizeObserver.observe(document.body);
    reportHeight();

    /**
     * The host can hand us a fresh ticket after our session expires, and can mute us. It
     * cannot do anything that touches money - the protocol has no message for it.
     */
    stopListening = listenToHost((message) => {
      if (message.type === "mute") {
        muted.value = message.muted;
        return;
      }

      if (message.type === "resume") {
        void exchangeTicket(message.token)
          .then((renewed) => {
            setGameToken(renewed.sessionToken);
            balance.value = renewed.balance;
            error.value = null;
            postToHost({ protocol: EMBED_PROTOCOL, type: "balance", balance: renewed.balance });
          })
          .catch(() => {
            error.value = "That session could not be renewed.";
          });
      }
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "This game could not be started.";
    fatal.value = message;
    loading.value = false;
    postToHost({ protocol: EMBED_PROTOCOL, type: "error", code: "LAUNCH_FAILED", message });
  }
});

onBeforeUnmount(() => {
  stopListening?.();
  resizeObserver?.disconnect();
  renderer?.destroy();
  renderer = null;
});

async function spin(): Promise<void> {
  if (!config.value || !session.value) return;

  spinning.value = true;
  error.value = null;

  try {
    // Server settles first; the reels only ever animate to a result already paid.
    const result = await gamePost<SlotSpinResult>("/slots/spin", {
      gameSlug: session.value.gameSlug,
      bet: String(bet.value),
      idempotencyKey: `embed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
    });

    await renderer?.spinTo(result.stops);

    lastResult.value = result;
    freeSpinsRemaining.value = result.freeSpinsRemaining;
    balance.value = result.balanceAfter;

    if (result.lineWins.length > 0 || result.scatterWin) {
      renderer?.highlightWins(result.lineWins, result.scatterWin);
    }

    postToHost({ protocol: EMBED_PROTOCOL, type: "balance", balance: result.balanceAfter });
    postToHost({
      protocol: EMBED_PROTOCOL,
      type: "round",
      bet: result.bet,
      win: result.totalWin,
      freeSpinsAwarded: result.freeSpinsAwarded,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "That spin could not be placed.";
    error.value = message;

    // An expired session is the host's problem to fix, so say so rather than failing quietly.
    if (/session/i.test(message)) {
      postToHost({
        protocol: EMBED_PROTOCOL,
        type: "error",
        code: "GAME_SESSION_EXPIRED",
        message,
      });
    }
  } finally {
    spinning.value = false;
  }
}

function adjustBet(direction: 1 | -1): void {
  const levels = config.value?.betLevels ?? [];
  const index = levels.indexOf(bet.value);
  const next = levels[Math.max(0, Math.min(levels.length - 1, index + direction))];
  if (next !== undefined) bet.value = next;
}

function exit(): void {
  postToHost({ protocol: EMBED_PROTOCOL, type: "exit" });
}
</script>

<template>
  <div class="shell" :data-brand="session?.brand ?? brandHint">
    <div v-if="loading" class="state">Starting game&hellip;</div>

    <div v-else-if="fatal" class="state state-error">
      <p class="bold">{{ fatal }}</p>
      <p class="tiny faint">Close this and open the game again from the lobby.</p>
    </div>

    <template v-else-if="config">
      <!-- Compact header: the game identifies itself and shows the balance, because the host
           page may be showing neither. -->
      <header class="bar">
        <span class="title">{{ config.name }}</span>
        <span v-if="freeSpinsRemaining > 0" class="badge">
          {{ freeSpinsRemaining }} free spins
        </span>
        <span class="spacer"></span>
        <span class="balance chips">{{ formatChips(balance) }} LC</span>
        <button v-if="muted" class="icon" title="Muted by the host page" disabled>M</button>
        <button class="icon" title="Paytable" @click="showPaytable = !showPaytable">i</button>
        <button class="icon" title="Close" @click="exit">&times;</button>
      </header>

      <div ref="canvasHost" class="reels"></div>

      <div class="readout" :class="{ win: lastWin > 0n }">
        <template v-if="lastResult && lastWin > 0n">
          <span class="win-amount chips">+{{ formatChips(lastResult.totalWin) }} LC</span>
          <span v-if="lastResult.freeSpinsAwarded > 0" class="badge">
            +{{ lastResult.freeSpinsAwarded }} free spins
          </span>
        </template>
        <span v-else-if="error" class="err">{{ error }}</span>
        <span v-else-if="lastResult" class="faint tiny">No win</span>
        <span v-else class="faint tiny">
          {{ config.paylines.length }} lines &middot; line bet
          {{ formatChips(String(lineBet)) }}
        </span>
      </div>

      <footer class="controls">
        <div class="bet">
          <button
            class="step"
            :disabled="spinning || freeSpinsRemaining > 0"
            aria-label="Lower bet"
            @click="adjustBet(-1)"
          >
            &minus;
          </button>
          <span class="bet-value chips">{{ formatChips(String(bet)) }}</span>
          <button
            class="step"
            :disabled="spinning || freeSpinsRemaining > 0"
            aria-label="Raise bet"
            @click="adjustBet(1)"
          >
            +
          </button>
        </div>

        <button class="spin" :disabled="!canSpin" @click="spin">
          <span v-if="spinning">&hellip;</span>
          <span v-else-if="freeSpinsRemaining > 0">Free spin</span>
          <span v-else-if="!canSpin">Low balance</span>
          <span v-else>Spin</span>
        </button>
      </footer>

      <!-- Paytable as an overlay: there is no room for a side panel in an embed. -->
      <div v-if="showPaytable" class="sheet" @click.self="showPaytable = false">
        <div class="sheet-inner">
          <div class="sheet-head">
            <strong>Paytable</strong>
            <button class="icon" @click="showPaytable = false">&times;</button>
          </div>
          <p class="tiny faint">
            Multiples of the line bet ({{ formatChips(String(lineBet)) }} LC), left to right. Target
            RTP {{ (config.rtpTarget * 100).toFixed(1) }}%.
          </p>
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>3</th>
                <th>4</th>
                <th>5</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="symbol in config.symbols" :key="symbol.id">
                <template v-if="config.paytable[symbol.id]">
                  <td>{{ symbol.name }}</td>
                  <td>{{ config.paytable[symbol.id]?.["3"] ?? "—" }}</td>
                  <td>{{ config.paytable[symbol.id]?.["4"] ?? "—" }}</td>
                  <td>{{ config.paytable[symbol.id]?.["5"] ?? "—" }}</td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * Self-contained styling. The shell cannot rely on the main site's stylesheet, because it is
 * a separate entry point that may be embedded anywhere, so the tokens live here.
 *
 * Brands re-point the accent only. Keeping the layout identical across brands means a game
 * behaves the same everywhere it is embedded.
 */
.shell {
  --bg: #070d14;
  --surface: #131f2c;
  --border: #23374b;
  --text: #e8f0f7;
  --faint: #7f93a7;
  --accent: #f5c358;
  --accent-ink: #241a05;
  --win: #4ade80;
  --loss: #f87171;

  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 100vh;
  padding: 10px;
  background: var(--bg);
  color: var(--text);
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    sans-serif;
  font-size: 14px;
  box-sizing: border-box;
}

.shell[data-brand="reef"] {
  --accent: #2fd4b4;
  --accent-ink: #04231d;
}
.shell[data-brand="abyss"] {
  --accent: #60a5fa;
  --accent-ink: #061a33;
}
.shell[data-brand="temple"] {
  --accent: #4ade80;
  --accent-ink: #052e16;
}

.chips {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.bold {
  font-weight: 650;
}
.faint {
  color: var(--faint);
}
.tiny {
  font-size: 0.78rem;
}
.spacer {
  flex: 1;
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 60vh;
  color: var(--faint);
  text-align: center;
  padding: 20px;
}

.state-error {
  color: var(--loss);
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title {
  font-weight: 700;
  letter-spacing: -0.01em;
}

.balance {
  color: var(--accent);
  font-weight: 650;
}

.badge {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
  white-space: nowrap;
}

.icon {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--faint);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.icon:hover {
  color: var(--text);
}

.reels {
  width: 100%;
  border-radius: 10px;
  overflow: hidden;
  background: #0b141d;
  min-height: 150px;
}

.readout {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 34px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
}

.readout.win {
  border-color: var(--win);
  background: color-mix(in srgb, var(--win) 9%, var(--surface));
}

.win-amount {
  color: var(--win);
  font-weight: 700;
  font-size: 1.05rem;
}

.err {
  color: var(--loss);
  font-size: 0.82rem;
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}

.bet {
  display: flex;
  align-items: center;
  gap: 5px;
}

.step {
  width: 36px;
  height: 40px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 1.05rem;
  cursor: pointer;
}

.step:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.bet-value {
  min-width: 62px;
  text-align: center;
  color: var(--accent);
  font-weight: 700;
}

.spin {
  flex: 1;
  min-height: 44px;
  border-radius: 8px;
  border: 0;
  background: var(--accent);
  color: var(--accent-ink);
  font: inherit;
  font-weight: 750;
  font-size: 1.02rem;
  cursor: pointer;
}

.spin:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sheet {
  position: fixed;
  inset: 0;
  background: rgba(7, 13, 20, 0.82);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 12px;
}

.sheet-inner {
  width: 100%;
  max-width: 420px;
  max-height: 78vh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px;
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
  margin-top: 8px;
}

th {
  text-align: right;
  color: var(--faint);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
}

th:first-child {
  text-align: left;
}

td {
  text-align: right;
  padding: 4px 6px;
  border-bottom: 1px solid rgba(35, 55, 75, 0.5);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

td:first-child {
  text-align: left;
  font-family: inherit;
}

/* Side by side once there is room for it. */
@media (min-width: 720px) {
  .shell {
    padding: 14px;
  }
}
</style>
