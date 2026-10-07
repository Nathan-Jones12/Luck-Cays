<script setup lang="ts">
/**
 * The back office.
 *
 * Support can look; only admins can change anything, and every change demands a reason that goes
 * into the audit log. The player detail view surfaces the wallet consistency check, because an
 * inconsistent wallet means something wrote a balance outside the wallet service and that needs
 * to be visible rather than buried.
 */
import { computed, onMounted, ref, watch } from "vue";
import { formatChips } from "@luck-cays/shared";
import { api, ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();

interface PlayerRow {
  id: string;
  email: string;
  username: string;
  role: string;
  status: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  balance: string;
  vipTier: string;
  vipPoints: number;
  createdAt: string;
}

interface PlayerDetail {
  player: PlayerRow & {
    failedLoginCount: number;
    lockedUntil: string | null;
    weekNetLoss: string;
  };
  walletConsistent: boolean;
  ledgerSum: string;
  counts: { slotRounds: number; sportsBets: number; bonusClaims: number };
  recentLedger: Array<{
    id: string;
    amount: string;
    type: string;
    refType: string | null;
    balanceAfter: string;
    createdAt: string;
  }>;
}

interface AuditRow {
  id: string;
  actorUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: unknown;
  ip: string | null;
  createdAt: string;
}

interface AdminGame {
  slug: string;
  name: string;
  isActive: boolean;
  rtpTarget: number;
  betLevels: number[];
  freeSpinMultiplier: number;
  updatedAt: string;
}

const tab = ref<"players" | "games" | "audit" | "jobs">("players");

const players = ref<PlayerRow[]>([]);
const search = ref("");
const selected = ref<PlayerDetail | null>(null);
const audit = ref<AuditRow[]>([]);
const games = ref<AdminGame[]>([]);

const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

// Chip adjustment form
const adjustAmount = ref(0);
const adjustReason = ref("");

// Granting free spins, so the bonus can be demonstrated without touching a game odds.
const fsGame = ref("");
const fsSpins = ref(10);
const fsBet = ref(0);
const fsReason = ref("Demonstrating the free-spin feature");

const selectedGame = computed(() => games.value.find((game) => game.slug === fsGame.value) ?? null);
const betLevels = computed(() => selectedGame.value?.betLevels ?? []);

// Picking a game picks a valid bet with it, and drops one that the new game does not offer.
watch(selectedGame, (game) => {
  if (!game) return;
  if (!game.betLevels.includes(fsBet.value)) fsBet.value = game.betLevels[0] ?? 0;
});

const canWrite = computed(() => auth.isAdmin);

// Sequential, not parallel: every loader shares the one busy/notice/error trio, so two in
// flight at once would overwrite each others state.
onMounted(async () => {
  await loadPlayers();
  // The free-spin form needs the game list to offer valid bets, and the Games tab wants it too.
  await loadGames();
});

async function run(work: () => Promise<void>, successMessage?: string): Promise<void> {
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await work();
    if (successMessage) notice.value = successMessage;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : "That action failed.";
  } finally {
    busy.value = false;
  }
}

async function loadPlayers(): Promise<void> {
  await run(async () => {
    const query = new URLSearchParams({ limit: "25" });
    if (search.value.trim()) query.set("q", search.value.trim());
    const result = await api.get<{ players: PlayerRow[] }>(`/admin/players?${query.toString()}`);
    players.value = result.players;
  });
}

async function openPlayer(id: string): Promise<void> {
  await run(async () => {
    selected.value = await api.get<PlayerDetail>(`/admin/players/${id}`);
    adjustAmount.value = 0;
    adjustReason.value = "";
  });
}

async function adjustChips(): Promise<void> {
  const player = selected.value?.player;
  if (!player || adjustAmount.value === 0) return;

  await run(async () => {
    await api.post("/admin/players/chips", {
      userId: player.id,
      amount: String(adjustAmount.value),
      reason: adjustReason.value,
    });
    await openPlayer(player.id);
    await loadPlayers();
  }, "Chips adjusted and written to the audit log.");
}

async function setStatus(status: string): Promise<void> {
  const player = selected.value?.player;
  if (!player) return;

  await run(async () => {
    await api.post("/admin/players/status", {
      userId: player.id,
      status,
      reason: adjustReason.value || `Status set to ${status} from the back office`,
    });
    await openPlayer(player.id);
    await loadPlayers();
  }, `Status set to ${status}. Sessions revoked.`);
}

async function loadGames(): Promise<void> {
  await run(async () => {
    const result = await api.get<{ games: AdminGame[] }>("/admin/slots");
    games.value = result.games;
  });
}

async function toggleGame(game: AdminGame): Promise<void> {
  await run(
    async () => {
      await api.patch("/admin/slots", { slug: game.slug, isActive: !game.isActive });
      await loadGames();
    },
    `${game.name} is now ${game.isActive ? "inactive" : "active"}.`,
  );
}

/**
 * Grant free spins to the selected player.
 *
 * This is here rather than in a game config because a bonus cannot be made more frequent
 * without wrecking the RTP - on 242 Wild Harbour, nudging the scatter weight from 3 to 5 takes
 * the return from 95.6% to 121%. Granting spins directly leaves the odds alone.
 */
async function grantFreeSpins(): Promise<void> {
  const player = selected.value?.player;
  if (!player || !fsGame.value) return;

  await run(async () => {
    const grant = await api.post<{ remaining: number; bet: string; multiplier: number }>(
      "/admin/slots/free-spins",
      {
        userId: player.id,
        gameSlug: fsGame.value,
        spins: fsSpins.value,
        bet: String(fsBet.value),
        reason: fsReason.value,
      },
    );
    notice.value =
      player.username +
      " now has " +
      grant.remaining +
      " free spins on " +
      fsGame.value +
      " at " +
      formatChips(grant.bet) +
      " LC, paying x" +
      grant.multiplier +
      ". Written to the audit log.";
  });
}

async function loadAudit(): Promise<void> {
  await run(async () => {
    const result = await api.get<{ entries: AuditRow[] }>("/admin/audit?limit=40");
    audit.value = result.entries;
  });
}

async function runJob(path: string, label: string): Promise<void> {
  await run(async () => {
    const result = await api.post<Record<string, unknown>>(path);
    notice.value = `${label}: ${JSON.stringify(result)}`;
  });
}

function switchTab(next: typeof tab.value): void {
  tab.value = next;
  if (next === "games" && games.value.length === 0) void loadGames();
  if (next === "audit" && audit.value.length === 0) void loadAudit();
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Back office</h1>
        <p class="small">
          Signed in as <strong>{{ auth.user?.username }}</strong> ({{ auth.role }}).
          <span v-if="!canWrite" class="badge badge-muted">Read only</span>
        </p>
      </div>
    </div>

    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="alert alert-ok">{{ notice }}</div>

    <nav class="tabs" aria-label="Back office sections">
      <button class="tab" :class="{ 'tab-on': tab === 'players' }" @click="switchTab('players')">
        Players
      </button>
      <button class="tab" :class="{ 'tab-on': tab === 'games' }" @click="switchTab('games')">
        Games
      </button>
      <button class="tab" :class="{ 'tab-on': tab === 'audit' }" @click="switchTab('audit')">
        Audit log
      </button>
      <button class="tab" :class="{ 'tab-on': tab === 'jobs' }" @click="switchTab('jobs')">
        Jobs
      </button>
    </nav>

    <!-- Players -->
    <section v-if="tab === 'players'" class="split">
      <div class="card">
        <form class="search" @submit.prevent="loadPlayers">
          <input v-model="search" placeholder="Search email or username" />
          <button class="btn btn-sm" type="submit" :disabled="busy">Search</button>
        </form>

        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Player</th>
                <th class="right">Balance</th>
                <th>Tier</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="player in players" :key="player.id">
                <td>
                  <span class="bold">{{ player.username }}</span>
                  <span class="badge badge-muted tiny-badge">{{ player.role }}</span>
                  <span v-if="player.status !== 'active'" class="badge badge-loss tiny-badge">
                    {{ player.status }}
                  </span>
                  <br />
                  <span class="tiny faint">{{ player.email }}</span>
                </td>
                <td class="right chips">{{ formatChips(player.balance) }}</td>
                <td class="tiny">{{ player.vipTier }}</td>
                <td>
                  <button class="btn btn-sm btn-ghost" @click="openPlayer(player.id)">Open</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="players.length === 0 && !busy" class="empty">No players found.</div>
      </div>

      <!-- Player detail -->
      <div v-if="selected" class="card detail">
        <div class="row-between">
          <h2>{{ selected.player.username }}</h2>
          <span
            class="badge"
            :class="selected.walletConsistent ? 'badge-win' : 'badge-loss'"
            :title="`Ledger sums to ${selected.ledgerSum}`"
          >
            {{ selected.walletConsistent ? "Wallet consistent" : "LEDGER MISMATCH" }}
          </span>
        </div>

        <dl class="facts">
          <div>
            <dt class="tiny faint">Balance</dt>
            <dd class="chips chips-gold">{{ formatChips(selected.player.balance) }}</dd>
          </div>
          <div>
            <dt class="tiny faint">VIP</dt>
            <dd>
              {{ selected.player.vipTier }} ({{ selected.player.vipPoints.toLocaleString() }})
            </dd>
          </div>
          <div>
            <dt class="tiny faint">Spins / bets</dt>
            <dd>{{ selected.counts.slotRounds }} / {{ selected.counts.sportsBets }}</dd>
          </div>
          <div>
            <dt class="tiny faint">2FA</dt>
            <dd>{{ selected.player.totpEnabled ? "Enabled" : "Off" }}</dd>
          </div>
        </dl>

        <template v-if="canWrite">
          <hr class="divider" />
          <h3>Adjust chips</h3>
          <p class="tiny faint">
            Positive adds, negative removes. Goes through the wallet as an
            <code>adjustment</code> ledger entry, never a direct balance write.
          </p>

          <div class="adjust">
            <div class="field">
              <label for="amount">Amount</label>
              <input id="amount" v-model.number="adjustAmount" type="number" />
            </div>
            <div class="field grow">
              <label for="reason">Reason (required, audited)</label>
              <input id="reason" v-model="adjustReason" minlength="5" />
            </div>
          </div>

          <button
            class="btn btn-primary btn-sm"
            :disabled="busy || adjustAmount === 0 || adjustReason.trim().length < 5"
            @click="adjustChips"
          >
            Apply adjustment
          </button>

          <hr class="divider" />
          <h3>Status</h3>
          <div class="row">
            <button
              class="btn btn-sm"
              :disabled="busy || selected.player.status === 'active'"
              @click="setStatus('active')"
            >
              Reinstate
            </button>
            <button
              class="btn btn-sm btn-danger"
              :disabled="busy || selected.player.status === 'banned'"
              @click="setStatus('banned')"
            >
              Ban
            </button>
            <button
              class="btn btn-sm btn-ghost"
              :disabled="busy || selected.player.status === 'self_excluded'"
              @click="setStatus('self_excluded')"
            >
              Self-exclude
            </button>
          </div>

          <hr class="divider" />
          <h3>Grant free spins</h3>
          <p class="tiny faint">
            A game's bonus cannot be made more frequent without wrecking its RTP &mdash; on 242 Wild
            Harbour, moving the scatter weight from 3 to 5 takes the return from 95.6% to 121%. So
            the feature is demonstrated and supported from here instead, leaving the odds and the
            published figures alone. Free spins pay at their locked bet with no stake, so this is
            real value and it is audited like a chip adjustment.
          </p>

          <div class="adjust">
            <div class="field">
              <label for="fs-game">Game</label>
              <select id="fs-game" v-model="fsGame">
                <option value="" disabled>Choose&hellip;</option>
                <option v-for="game in games" :key="game.slug" :value="game.slug">
                  {{ game.name }}
                </option>
              </select>
            </div>
            <div class="field">
              <label for="fs-spins">Spins</label>
              <input id="fs-spins" v-model.number="fsSpins" type="number" min="1" max="100" />
            </div>
            <div class="field">
              <label for="fs-bet">Bet (LC)</label>
              <!-- Only the game's own levels: the API rejects anything else, so offering a
                   free number box would just invite a plausible entry that fails. -->
              <select id="fs-bet" v-model.number="fsBet" :disabled="!fsGame">
                <option v-for="level in betLevels" :key="level" :value="level">
                  {{ level.toLocaleString("en-US") }}
                </option>
              </select>
            </div>
          </div>

          <div class="field">
            <label for="fs-reason">Reason (required, audited)</label>
            <input id="fs-reason" v-model="fsReason" minlength="5" />
          </div>

          <button
            class="btn btn-teal btn-sm"
            :disabled="busy || !fsGame || !fsBet || fsSpins < 1 || fsReason.trim().length < 5"
            @click="grantFreeSpins"
          >
            Grant {{ fsSpins }} free spins
          </button>
          <p v-if="selectedGame" class="tiny faint">
            {{ selectedGame.name }} pays free spins at
            <strong>&times;{{ selectedGame.freeSpinMultiplier }}</strong
            >. {{ fsSpins }} spins at {{ fsBet.toLocaleString("en-US") }} LC is
            {{ (fsSpins * fsBet).toLocaleString("en-US") }} LC of turnover the player does not
            stake.
          </p>
        </template>

        <hr class="divider" />
        <h3>Recent ledger</h3>
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th class="right">Amount</th>
                <th class="right">After</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in selected.recentLedger" :key="entry.id">
                <td class="tiny faint nowrap">{{ when(entry.createdAt) }}</td>
                <td class="tiny">{{ entry.type }}</td>
                <td
                  class="right chips"
                  :class="BigInt(entry.amount) > 0n ? 'chips-win' : 'chips-loss'"
                >
                  {{ BigInt(entry.amount) > 0n ? "+" : "" }}{{ formatChips(entry.amount) }}
                </td>
                <td class="right chips tiny">{{ formatChips(entry.balanceAfter) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-else class="card empty-detail">
        <p class="faint small">Select a player to see their wallet and history.</p>
      </div>
    </section>

    <!-- Games -->
    <section v-else-if="tab === 'games'" class="card">
      <p class="small muted">
        A game must not be set active until its RTP has been signed off. The measured figures live
        in <code>docs/rtp/</code> and are regenerated with <code>npm run rtp</code>.
      </p>

      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>Game</th>
              <th class="right">Target RTP</th>
              <th>Status</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="game in games" :key="game.slug">
              <td>
                <span class="bold">{{ game.name }}</span>
                <br /><span class="tiny faint mono">{{ game.slug }}</span>
              </td>
              <td class="right mono">{{ (game.rtpTarget * 100).toFixed(2) }}%</td>
              <td>
                <span class="badge" :class="game.isActive ? 'badge-win' : 'badge-muted'">
                  {{ game.isActive ? "Active" : "Inactive" }}
                </span>
              </td>
              <td class="tiny faint nowrap">{{ when(game.updatedAt) }}</td>
              <td>
                <button
                  class="btn btn-sm btn-ghost"
                  :disabled="!canWrite || busy"
                  @click="toggleGame(game)"
                >
                  {{ game.isActive ? "Deactivate" : "Activate" }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Audit -->
    <section v-else-if="tab === 'audit'" class="card">
      <div class="row-between">
        <p class="small muted">Every staff action and security event, newest first. Append-only.</p>
        <button class="btn btn-sm btn-ghost" :disabled="busy" @click="loadAudit">Refresh</button>
      </div>

      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in audit" :key="entry.id">
              <td class="tiny faint nowrap">{{ when(entry.createdAt) }}</td>
              <td class="tiny mono">{{ entry.action }}</td>
              <td class="tiny">{{ entry.actorUsername ?? "—" }}</td>
              <td class="tiny faint">{{ entry.targetType ?? "—" }}</td>
              <td class="tiny faint details">
                {{ entry.details ? JSON.stringify(entry.details) : "—" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="audit.length === 0 && !busy" class="empty">No audit entries.</div>
    </section>

    <!-- Jobs -->
    <section v-else class="card">
      <h2>Run a scheduled job now</h2>
      <p class="small muted">
        These run on a cron schedule automatically. Triggering one by hand is for demos and
        debugging; every job is idempotent, so running it twice is harmless.
      </p>

      <div class="jobs">
        <button
          class="btn"
          :disabled="!canWrite || busy"
          @click="runJob('/admin/sports/sync', 'Fixture sync')"
        >
          Sync fixtures
        </button>
        <button
          class="btn"
          :disabled="!canWrite || busy"
          @click="runJob('/admin/jobs/settle', 'Settlement')"
        >
          Settle resolved bets
        </button>
        <button
          class="btn"
          :disabled="!canWrite || busy"
          @click="runJob('/admin/jobs/cashback', 'Cashback')"
        >
          Pay weekly cashback
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

.tab {
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font: inherit;
  font-weight: 650;
  font-size: 0.92rem;
  padding: 9px 14px;
  cursor: pointer;
  white-space: nowrap;
}

.tab-on {
  color: var(--gold);
  border-bottom-color: var(--gold);
}

.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.search {
  display: flex;
  gap: 7px;
  margin-bottom: 12px;
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 12px;
  margin: 12px 0 0;
}

.facts dd {
  margin: 2px 0 0;
  font-weight: 650;
}

.adjust {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.grow {
  flex: 1;
}

.tiny-badge {
  font-size: 0.58rem;
  padding: 1px 5px;
  margin-left: 5px;
}

.details {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-detail {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
}

.jobs {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
}

code {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--teal);
}

@media (max-width: 980px) {
  .split {
    grid-template-columns: 1fr;
  }
}
</style>
