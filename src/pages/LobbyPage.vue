<script setup lang="ts">
/**
 * The lobby. The four launch features, the daily bonus, and the VIP teaser.
 *
 * Signed out, it is a pitch. Signed in, it is a hub - so the daily bonus and VIP progress
 * replace the sign-up call to action rather than sitting alongside it.
 */
import { onMounted, ref } from "vue";
import { formatChips, type SlotGameSummary, type VipProgress } from "@luck-cays/shared";
import { api, ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useWalletStore } from "@/stores/wallet";

const auth = useAuthStore();
const wallet = useWalletStore();

const games = ref<SlotGameSummary[]>([]);
const vip = ref<VipProgress | null>(null);
const claiming = ref(false);
const claimed = ref<string | null>(null);
const error = ref<string | null>(null);

const features = [
  {
    to: "/slots",
    title: "Slots",
    tag: "3 games",
    blurb:
      "Five reels, twenty lines, free-spin bonuses. Every outcome is drawn server-side and every game's measured return-to-player is published.",
    accent: "gold",
  },
  {
    to: "/sports",
    title: "Sports betting",
    tag: "Pre-match",
    blurb:
      "Moneyline, spreads and totals across football, basketball, tennis and more. Odds lock the moment you place a bet.",
    accent: "teal",
  },
  {
    to: "/poker",
    title: "Texas Hold'em",
    tag: "Live tables",
    blurb:
      "No-limit cash tables for two to six players. Real-time, server-dealt, with a tested hand evaluator settling every pot.",
    accent: "violet",
  },
  {
    to: "/vip",
    title: "VIP rewards",
    tag: "5 tiers",
    blurb:
      "Earn points on everything you wager. Climb from Bronze to Diamond for bigger daily bonuses, level-up chips and weekly cashback.",
    accent: "rose",
  },
];

onMounted(async () => {
  try {
    const result = await api.get<{ games: SlotGameSummary[] }>("/slots");
    games.value = result.games;
  } catch {
    // The lobby is still useful without the game count; no need to shout about it.
  }

  if (auth.isSignedIn) {
    await Promise.allSettled([
      wallet.loadBonuses(),
      api.get<VipProgress>("/vip/me").then((result) => {
        vip.value = result;
      }),
    ]);
  }
});

async function claimDaily(): Promise<void> {
  claiming.value = true;
  error.value = null;
  try {
    const amount = await wallet.claimDaily();
    claimed.value = amount;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : "Could not claim the bonus";
  } finally {
    claiming.value = false;
  }
}
</script>

<template>
  <div class="page">
    <!-- Hero -->
    <section class="hero">
      <div class="hero-copy">
        <span class="badge badge-gold">Play money &middot; no cash value</span>
        <h1>
          A casino where the only thing you can lose<br />
          is <span class="accent">imaginary</span>.
        </h1>
        <p class="lede">
          Slots, sports betting, poker and VIP rewards, all played with Luck-Cays Chips. Sign up and
          we will hand you
          <strong class="chips chips-gold">{{ formatChips("10000") }} LC</strong> to start, plus a
          free top-up every day. Nothing here costs real money, because nothing here can be bought.
        </p>

        <div class="hero-actions">
          <template v-if="!auth.isSignedIn">
            <RouterLink to="/signup" class="btn btn-primary btn-lg">
              Claim 10,000 free chips
            </RouterLink>
            <RouterLink to="/login" class="btn btn-ghost btn-lg">Sign in</RouterLink>
          </template>
          <template v-else>
            <RouterLink to="/slots" class="btn btn-primary btn-lg">Play slots</RouterLink>
            <RouterLink to="/poker" class="btn btn-ghost btn-lg">Find a poker table</RouterLink>
          </template>
        </div>
      </div>

      <!-- Signed-in side panel: bonus and VIP. -->
      <aside v-if="auth.isSignedIn" class="card hero-aside">
        <h3>Your daily top-up</h3>

        <div v-if="error" class="alert alert-error">{{ error }}</div>

        <template v-if="claimed">
          <div class="alert alert-ok">
            Claimed <span class="chips bold">{{ formatChips(claimed) }} LC</span>. Come back
            tomorrow.
          </div>
        </template>

        <template v-else-if="wallet.bonuses">
          <p class="aside-amount chips chips-gold">
            {{ formatChips(wallet.bonuses.daily.amount) }} LC
          </p>
          <p v-if="wallet.bonuses.daily.multiplier > 1" class="tiny faint">
            Includes your {{ wallet.bonuses.daily.multiplier }}&times; VIP multiplier on a
            {{ formatChips(wallet.bonuses.daily.baseAmount) }} base.
          </p>

          <button
            class="btn btn-primary btn-block"
            :disabled="!wallet.bonuses.daily.available || claiming"
            @click="claimDaily"
          >
            <span v-if="claiming" class="spinner"></span>
            <span v-else-if="wallet.bonuses.daily.available">Claim now</span>
            <span v-else>Already claimed today</span>
          </button>
        </template>

        <div v-else class="muted small">Loading&hellip;</div>

        <template v-if="vip">
          <hr class="divider" />
          <div class="row-between">
            <span class="small muted">VIP tier</span>
            <span class="badge badge-gold">{{ vip.tier.name }}</span>
          </div>
          <div
            class="progress"
            role="progressbar"
            :aria-valuenow="Math.round(vip.tierProgress * 100)"
          >
            <div class="progress-fill" :style="{ width: `${vip.tierProgress * 100}%` }"></div>
          </div>
          <p v-if="vip.nextTier" class="tiny faint">
            {{ vip.pointsToNextTier.toLocaleString() }} points to {{ vip.nextTier.name }}
          </p>
          <p v-else class="tiny faint">Diamond &mdash; the top tier.</p>
        </template>
      </aside>
    </section>

    <!-- Features -->
    <section>
      <div class="page-head">
        <div>
          <h2>Four ways to play</h2>
          <p>Every game shares one wallet, so chips move freely between them.</p>
        </div>
      </div>

      <div class="grid grid-cards">
        <RouterLink
          v-for="feature in features"
          :key="feature.to"
          :to="feature.to"
          class="card card-interactive feature"
          :class="`accent-${feature.accent}`"
        >
          <div class="row-between">
            <h3>{{ feature.title }}</h3>
            <span class="badge badge-muted">{{ feature.tag }}</span>
          </div>
          <p class="small muted">{{ feature.blurb }}</p>
          <span class="feature-go">Open &rarr;</span>
        </RouterLink>
      </div>
    </section>

    <!-- Fairness -->
    <section class="fairness card">
      <h2>How the games are decided</h2>
      <div class="grid fairness-grid">
        <div>
          <h3>The server decides, always</h3>
          <p class="small muted">
            Reel stops, shuffles and hand winners are computed on the server from
            <code>crypto.randomInt</code>. Your browser is told the result and animates to it. It
            never holds a deck or an unrevealed card.
          </p>
        </div>
        <div>
          <h3>Published return-to-player</h3>
          <p class="small muted">
            Each slot's RTP is calculated in closed form, not sampled, and checked against a
            million-round simulation. The figures live in the repository under
            <code>docs/rtp/</code>.
          </p>
        </div>
        <div>
          <h3>Every chip is accounted for</h3>
          <p class="small muted">
            One wallet service moves chips, and every movement writes an append-only ledger row.
            Your balance is reconstructable from your own history, which you can read on your
            account page.
          </p>
        </div>
      </div>
      <p v-if="games.length" class="tiny faint fairness-note">
        {{ games.length }} slot games live, all within 0.5% of their target RTP.
      </p>
    </section>
  </div>
</template>

<style scoped>
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(280px, 1fr);
  gap: 28px;
  align-items: start;
  padding: 18px 0 44px;
}

.hero-copy h1 {
  font-size: clamp(1.9rem, 5vw, 3rem);
  margin: 14px 0 16px;
  letter-spacing: -0.03em;
}

.accent {
  color: var(--gold);
}

.lede {
  color: var(--text-muted);
  font-size: 1.04rem;
  max-width: 56ch;
}

.lede strong {
  font-weight: 700;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 22px;
}

.hero-aside {
  position: sticky;
  top: calc(var(--header-height) + 16px);
}

.aside-amount {
  font-size: 1.7rem;
  font-weight: 700;
  margin: 6px 0 2px;
}

.progress {
  height: 7px;
  background: var(--surface-3);
  border-radius: var(--radius-pill);
  overflow: hidden;
  margin: 9px 0 6px;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--gold-dim), var(--gold));
  border-radius: var(--radius-pill);
  transition: width 400ms ease;
}

.feature {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-decoration: none;
  color: inherit;
  border-top: 2px solid var(--border);
}

.feature:hover {
  text-decoration: none;
}

.feature h3 {
  margin: 0;
}

.feature p {
  flex: 1;
  margin: 0;
}

.feature-go {
  color: var(--teal);
  font-weight: 650;
  font-size: 0.88rem;
}

.accent-gold {
  border-top-color: var(--gold);
}
.accent-teal {
  border-top-color: var(--teal);
}
.accent-violet {
  border-top-color: #a78bfa;
}
.accent-rose {
  border-top-color: #f87171;
}

.fairness {
  margin-top: 40px;
}

.fairness-grid {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 22px;
}

.fairness-grid p {
  margin: 0;
}

.fairness-note {
  margin: 18px 0 0;
}

code {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--teal);
}

@media (max-width: 900px) {
  .hero {
    grid-template-columns: 1fr;
    gap: 22px;
    padding-bottom: 30px;
  }

  .hero-aside {
    position: static;
  }
}
</style>
