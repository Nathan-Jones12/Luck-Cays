<script setup lang="ts">
/**
 * The slots lobby.
 *
 * Each card shows the game's target RTP, because a player deciding what to play deserves to know
 * the number before they stake anything rather than after.
 */
import { onMounted, ref } from "vue";
import type { SlotGameSummary } from "@luck-cays/shared";
import { api } from "@/api/client";
import { formatChips } from "@luck-cays/shared";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const games = ref<SlotGameSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

/** Volatility is not in the API, so it is described from the theme the config declares. */
const THEME_NOTES: Record<string, { tag: string; note: string }> = {
  caribbean: {
    tag: "Medium volatility",
    note: "The house game. Steady hits, a doubling free-spin round on three chests.",
  },
  abyss: {
    tag: "High volatility",
    note: "Rarer wins, a tripled bonus and the biggest top line of the three.",
  },
  temple: {
    tag: "Low volatility",
    note: "Hits most often, with an extra wild on every reel and a gentler ceiling.",
  },
  harbour: {
    tag: "Coin collect",
    note: "Collect five or more coins to bank every value on the grid. A rare but generous bonus.",
  },
};

onMounted(async () => {
  try {
    const result = await api.get<{ games: SlotGameSummary[] }>("/slots");
    games.value = result.games;
  } catch {
    error.value = "Could not load the games.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Slots</h1>
        <p>
          Five reels, three rows, twenty fixed lines. Stops are drawn on the server from
          <code>crypto.randomInt</code> &mdash; your browser only animates to the result.
        </p>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div v-if="loading" class="empty">Loading games&hellip;</div>

    <div v-else-if="games.length === 0" class="empty">
      No games are live. Run <code>npm run db:seed</code> to populate them.
    </div>

    <div v-else class="grid grid-cards">
      <RouterLink
        v-for="game in games"
        :key="game.slug"
        :to="auth.isSignedIn ? `/slots/${game.slug}` : '/login'"
        class="card card-interactive game"
      >
        <!-- A procedural reel strip stands in for cover art. -->
        <div class="art" :class="`art-${game.theme}`" aria-hidden="true">
          <span v-for="n in 5" :key="n" class="art-cell"></span>
        </div>

        <div class="row-between">
          <h3>{{ game.name }}</h3>
          <span class="badge badge-gold">{{ (game.rtpTarget * 100).toFixed(1) }}% RTP</span>
        </div>

        <p class="small muted note">
          {{ THEME_NOTES[game.theme]?.note ?? "Five reels, twenty lines." }}
        </p>

        <div class="meta">
          <span class="badge badge-muted">
            {{ THEME_NOTES[game.theme]?.tag ?? game.theme }}
          </span>
          <span class="tiny faint">
            {{ formatChips(String(game.betLevels[0] ?? 20)) }}&ndash;{{
              formatChips(String(game.betLevels[game.betLevels.length - 1] ?? 5000))
            }}
            LC
          </span>
        </div>

        <span class="go">{{ auth.isSignedIn ? "Play" : "Sign in to play" }} &rarr;</span>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.game {
  display: flex;
  flex-direction: column;
  gap: 9px;
  text-decoration: none;
  color: inherit;
}

.game:hover {
  text-decoration: none;
}

.game h3 {
  margin: 0;
}

.note {
  margin: 0;
  flex: 1;
}

.art {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
  height: 78px;
  padding: 7px;
  border-radius: var(--radius);
  background: var(--bg);
  border: 1px solid var(--border);
  margin-bottom: 4px;
}

.art-cell {
  border-radius: 5px;
  background: var(--surface-3);
}

/* Each theme gets its own colour run, so the three cards are told apart at a glance. */
.art-caribbean .art-cell:nth-child(1) {
  background: linear-gradient(180deg, #f5c358, #c89a3c);
}
.art-caribbean .art-cell:nth-child(2) {
  background: linear-gradient(180deg, #2fd4b4, #1d9f87);
}
.art-caribbean .art-cell:nth-child(3) {
  background: linear-gradient(180deg, #f87171, #b84343);
}
.art-caribbean .art-cell:nth-child(4) {
  background: linear-gradient(180deg, #fb923c, #c2652a);
}
.art-caribbean .art-cell:nth-child(5) {
  background: linear-gradient(180deg, #a78bfa, #7c5cd6);
}

.art-abyss .art-cell:nth-child(1) {
  background: linear-gradient(180deg, #60a5fa, #2f6fc4);
}
.art-abyss .art-cell:nth-child(2) {
  background: linear-gradient(180deg, #a78bfa, #7c5cd6);
}
.art-abyss .art-cell:nth-child(3) {
  background: linear-gradient(180deg, #2fd4b4, #1d9f87);
}
.art-abyss .art-cell:nth-child(4) {
  background: linear-gradient(180deg, #334e68, #1f3448);
}
.art-abyss .art-cell:nth-child(5) {
  background: linear-gradient(180deg, #f5c358, #c89a3c);
}

.art-temple .art-cell:nth-child(1) {
  background: linear-gradient(180deg, #f5c358, #c89a3c);
}
.art-temple .art-cell:nth-child(2) {
  background: linear-gradient(180deg, #4ade80, #1f9d52);
}
.art-temple .art-cell:nth-child(3) {
  background: linear-gradient(180deg, #fb923c, #c2652a);
}
.art-temple .art-cell:nth-child(4) {
  background: linear-gradient(180deg, #f87171, #b84343);
}
.art-temple .art-cell:nth-child(5) {
  background: linear-gradient(180deg, #2fd4b4, #1d9f87);
}

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.go {
  color: var(--teal);
  font-weight: 650;
  font-size: 0.88rem;
}

code {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--teal);
}
</style>
