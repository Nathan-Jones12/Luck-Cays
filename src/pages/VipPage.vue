<script setup lang="ts">
/**
 * VIP: the tier ladder, the player's position on it, and the daily lossback each tier pays.
 *
 * The ladder is public so it can be read before signing up; progress only appears when there is
 * someone to show progress for.
 */
import { computed, onMounted, ref } from "vue";
import { formatBasisPoints, formatChips, type VipProgress, type VipTier } from "@luck-cays/shared";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const tiers = ref<VipTier[]>([]);
const progress = ref<VipProgress | null>(null);
const loading = ref(true);

const currentTierId = computed(() => progress.value?.tier.id ?? null);

/** The next payout in the viewer's own timezone, e.g. "Mon 2:00 PM". */
const nextPayout = computed(() =>
  progress.value
    ? new Date(progress.value.nextPayoutAt).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "",
);

onMounted(async () => {
  const requests: Array<Promise<unknown>> = [
    api.get<{ tiers: VipTier[] }>("/vip/tiers").then((result) => {
      tiers.value = result.tiers;
    }),
  ];

  if (auth.isSignedIn) {
    requests.push(
      api.get<VipProgress>("/vip/me").then((result) => {
        progress.value = result;
      }),
    );
  }

  await Promise.allSettled(requests);
  loading.value = false;
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>VIP rewards</h1>
        <p>
          Every chip you wager earns points &mdash; one point per 100 chips, on slots, sports and
          poker alike. Points never reset, so your tier only moves one way.
        </p>
      </div>
    </div>

    <!-- Current standing -->
    <section v-if="progress" class="card standing">
      <div class="standing-head">
        <div>
          <span class="tiny faint">Your tier</span>
          <h2 class="tier-name">{{ progress.tier.name }}</h2>
        </div>
        <div class="right">
          <span class="tiny faint">Lifetime points</span>
          <p class="chips points">{{ progress.lifetimePoints.toLocaleString() }}</p>
        </div>
      </div>

      <div
        class="progress"
        role="progressbar"
        :aria-valuenow="Math.round(progress.tierProgress * 100)"
      >
        <div class="progress-fill" :style="{ width: `${progress.tierProgress * 100}%` }"></div>
      </div>

      <p v-if="progress.nextTier" class="small muted">
        <strong class="chips">{{ progress.pointsToNextTier.toLocaleString() }}</strong> more points
        to reach <strong>{{ progress.nextTier.name }}</strong
        >, where lossback rises to
        <strong class="chips-sunset">{{ formatBasisPoints(progress.nextTier.lossbackBp) }}</strong>.
      </p>
      <p v-else class="small muted">
        You are at {{ progress.tier.name }}, the top tier. Nothing left to climb.
      </p>

      <hr class="divider" />

      <div class="perks">
        <div class="perk">
          <span class="tiny faint">Daily lossback</span>
          <p class="perk-value">{{ formatBasisPoints(progress.tier.lossbackBp) }}</p>
        </div>
        <div class="perk">
          <span class="tiny faint">Wagered since last payout</span>
          <p class="perk-value chips">{{ formatChips(progress.periodWagered) }}</p>
        </div>
        <div class="perk">
          <span class="tiny faint">Won since last payout</span>
          <p class="perk-value chips">{{ formatChips(progress.periodWon) }}</p>
        </div>
        <div class="perk">
          <span class="tiny faint">Lossback at {{ nextPayout }}</span>
          <p class="perk-value chips chips-sunset">{{ formatChips(progress.pendingLossback) }}</p>
        </div>
      </div>

      <p class="tiny faint lossback-note">
        Lossback is paid automatically every day at 2pm Bahamas time: your tier's rate on what you
        wagered minus what you won on slots and sports since the last payout. A winning day pays
        nothing and does not carry a deficit forward.
      </p>
    </section>

    <section v-else-if="!auth.isSignedIn" class="alert alert-info">
      <RouterLink to="/signup">Create an account</RouterLink> to start earning points. Everyone
      begins at {{ tiers[0]?.name ?? "the first tier" }}.
    </section>

    <!-- The ladder -->
    <section>
      <div class="page-head">
        <h2>The {{ tiers.length || "" }} tiers</h2>
      </div>

      <div v-if="loading" class="empty">Loading tiers&hellip;</div>

      <div v-else class="table-scroll card">
        <table class="table">
          <thead>
            <tr>
              <th>Tier</th>
              <th class="right">Points needed</th>
              <th class="right">Daily lossback</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="tier in tiers"
              :key="tier.id"
              :class="{ 'row-current': tier.id === currentTierId }"
            >
              <td>
                <span class="tier-cell">
                  <span class="dot" :class="`dot-${tier.name.toLowerCase()}`"></span>
                  {{ tier.name }}
                  <span v-if="tier.id === currentTierId" class="badge badge-sunset tiny-badge">
                    You
                  </span>
                </span>
              </td>
              <td class="right mono">{{ tier.minPoints.toLocaleString() }}</td>
              <td class="right mono">
                {{ tier.lossbackBp === 0 ? "—" : formatBasisPoints(tier.lossbackBp) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="tiny faint ladder-note">
        Points are awarded on settled wagers only, and a rejected bet earns nothing. Lossback is
        paid daily at 2pm Bahamas time on slots and sports.
      </p>
    </section>
  </div>
</template>

<style scoped>
.standing {
  margin-bottom: 30px;
}

.standing-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 12px;
}

.tier-name {
  margin: 2px 0 0;
  color: var(--sunset);
}

.points {
  margin: 2px 0 0;
  font-size: 1.3rem;
  font-weight: 700;
}

.progress {
  height: 9px;
  background: var(--surface-3);
  border-radius: var(--radius-pill);
  overflow: hidden;
  margin-bottom: 10px;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--sunset-dim), var(--sunset));
  border-radius: var(--radius-pill);
  transition: width 420ms ease;
}

.perks {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px;
}

.perk-value {
  margin: 2px 0 0;
  font-size: 1.12rem;
  font-weight: 700;
}

.lossback-note {
  margin: 14px 0 0;
}

.tier-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* One colour per fish, rising from sand-grey to the sunset at Shark. */
.dot-grunt {
  background: #a7b0ba;
}
.dot-snapper {
  background: #e0715c;
}
.dot-bonefish {
  background: #d6dde4;
}
.dot-grouper {
  background: #a3825f;
}
.dot-jack {
  background: #8db4d4;
}
.dot-mahi {
  background: #7ccf9a;
}
.dot-marlin {
  background: #4f86d6;
}
.dot-shark {
  background: var(--sunset);
  box-shadow: 0 0 8px var(--sunset-glow);
}

.row-current {
  background: rgba(242, 165, 65, 0.07);
}

.tiny-badge {
  font-size: 0.6rem;
  padding: 1px 6px;
}

.ladder-note {
  margin-top: 12px;
}
</style>
