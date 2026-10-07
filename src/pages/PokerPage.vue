<script setup lang="ts">
/**
 * The poker lobby: the cash tables and their stakes.
 */
import { onMounted, ref } from "vue";
import { formatChips, type PokerTableSummary } from "@luck-cays/shared";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useWalletStore } from "@/stores/wallet";

const auth = useAuthStore();
const wallet = useWalletStore();

const tables = ref<PokerTableSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const result = await api.get<{ tables: PokerTableSummary[] }>("/poker/tables");
    tables.value = result.tables;
  } catch {
    error.value = "Could not load the tables.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Texas Hold'em</h1>
        <p>
          No-limit cash tables. The deck is shuffled server-side with Fisher-Yates over
          <code>crypto.randomInt</code>, and you only ever receive your own hole cards &mdash; the
          server builds a separate view for every player at the table.
        </p>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div v-if="loading" class="empty">Loading tables&hellip;</div>

    <div v-else class="grid grid-cards">
      <article v-for="table in tables" :key="table.id" class="card table-card">
        <div class="row-between">
          <h3>{{ table.name }}</h3>
          <span class="badge badge-teal"> {{ table.seatedCount }}/{{ table.maxSeats }} </span>
        </div>

        <dl class="stakes">
          <div>
            <dt class="tiny faint">Blinds</dt>
            <dd class="chips">
              {{ formatChips(table.smallBlind) }} / {{ formatChips(table.bigBlind) }}
            </dd>
          </div>
          <div>
            <dt class="tiny faint">Buy-in</dt>
            <dd class="chips">
              {{ formatChips(table.minBuyin) }}&ndash;{{ formatChips(table.maxBuyin) }}
            </dd>
          </div>
        </dl>

        <p v-if="table.maxSeats === 2" class="tiny faint">Heads-up only.</p>

        <RouterLink
          v-if="auth.isSignedIn"
          :to="`/poker/${table.id}`"
          class="btn btn-block"
          :class="wallet.canAfford(table.minBuyin) ? 'btn-primary' : 'btn-ghost'"
        >
          {{ wallet.canAfford(table.minBuyin) ? "Take a seat" : "Not enough chips" }}
        </RouterLink>
        <RouterLink v-else to="/login" class="btn btn-ghost btn-block">Sign in to play</RouterLink>
      </article>
    </div>

    <section class="card notes">
      <h2>How a hand runs</h2>
      <div class="grid notes-grid">
        <div>
          <h3>Server-dealt</h3>
          <p class="small muted">
            The state machine runs deal, pre-flop, flop, turn, river and showdown on the server.
            Your browser receives a view of the table, not the deck.
          </p>
        </div>
        <div>
          <h3>Twenty seconds to act</h3>
          <p class="small muted">
            Out of time, you check if it is free and fold if it is not, then sit out. Lose your
            connection and your seat is held for thirty seconds before the hand folds it.
          </p>
        </div>
        <div>
          <h3>Chips move through the wallet</h3>
          <p class="small muted">
            A buy-in debits your wallet and credits the seat; leaving reverses it. The split is
            recorded in your ledger, so table chips are never created or lost.
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.table-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.table-card h3 {
  margin: 0;
}

.stakes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 0;
  flex: 1;
}

.stakes dd {
  margin: 2px 0 0;
  font-weight: 650;
  font-size: 0.92rem;
}

.notes {
  margin-top: 28px;
}

.notes-grid {
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 20px;
}

.notes-grid p {
  margin: 0;
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
