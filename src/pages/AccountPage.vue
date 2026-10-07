<script setup lang="ts">
/**
 * Account: the wallet ledger, spin history, and two-factor setup.
 *
 * The ledger is shown in full because it is the player's own audit trail - every chip movement
 * with the balance it produced. If the figures here did not add up, that would be a bug worth
 * finding, and hiding them would only hide the bug.
 */
import { computed, onMounted, ref } from "vue";
import { formatChips } from "@luck-cays/shared";
import { api, ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useWalletStore } from "@/stores/wallet";

const auth = useAuthStore();
const wallet = useWalletStore();

const tab = ref<"ledger" | "spins" | "security">("ledger");

const spins = ref<
  Array<{
    roundId: string;
    gameSlug: string;
    bet: string;
    win: string;
    isFreeSpin: boolean;
    createdAt: string;
  }>
>([]);

// Two-factor enrolment
const totpSetup = ref<{ secret: string; uri: string } | null>(null);
const totpCode = ref("");
const backupCodes = ref<string[]>([]);
const securityError = ref<string | null>(null);
const securityBusy = ref(false);

const LEDGER_LABELS: Record<string, string> = {
  bet: "Bet",
  win: "Win",
  bonus: "Bonus",
  vip_reward: "VIP reward",
  refund: "Refund",
  adjustment: "Adjustment",
  poker_buyin: "Poker buy-in",
  poker_cashout: "Poker cash-out",
};

const ledgerTotal = computed(() =>
  wallet.ledger.reduce((sum, entry) => sum + BigInt(entry.amount), 0n),
);

onMounted(async () => {
  await Promise.allSettled([wallet.loadLedger(), loadSpins()]);
});

async function loadSpins(): Promise<void> {
  const result = await api.get<{ rounds: typeof spins.value }>("/slots/history/rounds?limit=30");
  spins.value = result.rounds;
}

async function beginTotp(): Promise<void> {
  securityBusy.value = true;
  securityError.value = null;
  try {
    totpSetup.value = await api.post<{ secret: string; uri: string }>("/auth/totp/begin");
  } catch (caught) {
    securityError.value = caught instanceof ApiError ? caught.message : "Could not start setup.";
  } finally {
    securityBusy.value = false;
  }
}

async function confirmTotp(): Promise<void> {
  securityBusy.value = true;
  securityError.value = null;
  try {
    const result = await api.post<{ backupCodes: string[] }>("/auth/totp/confirm", {
      totp: totpCode.value,
    });
    backupCodes.value = result.backupCodes;
    totpSetup.value = null;
    totpCode.value = "";
    await auth.loadMe();
  } catch (caught) {
    securityError.value =
      caught instanceof ApiError ? caught.message : "That code was not accepted.";
  } finally {
    securityBusy.value = false;
  }
}

async function disableTotp(): Promise<void> {
  securityBusy.value = true;
  securityError.value = null;
  try {
    await api.post("/auth/totp/disable", { totp: totpCode.value });
    totpCode.value = "";
    backupCodes.value = [];
    await auth.loadMe();
  } catch (caught) {
    securityError.value = caught instanceof ApiError ? caught.message : "Could not turn 2FA off.";
  } finally {
    securityBusy.value = false;
  }
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
        <h1>Account</h1>
        <p class="small">
          {{ auth.user?.username }} &middot; {{ auth.user?.email }}
          <span v-if="!auth.user?.emailVerified" class="badge badge-muted">Email unverified</span>
        </p>
      </div>
      <div class="right">
        <span class="tiny faint">Balance</span>
        <p class="chips chips-gold balance">{{ wallet.formatted }} LC</p>
      </div>
    </div>

    <nav class="tabs" aria-label="Account sections">
      <button class="tab" :class="{ 'tab-on': tab === 'ledger' }" @click="tab = 'ledger'">
        Chip ledger
      </button>
      <button class="tab" :class="{ 'tab-on': tab === 'spins' }" @click="tab = 'spins'">
        Spin history
      </button>
      <button class="tab" :class="{ 'tab-on': tab === 'security' }" @click="tab = 'security'">
        Security
      </button>
    </nav>

    <!-- Ledger -->
    <section v-if="tab === 'ledger'" class="card">
      <p class="small muted">
        Every chip movement on your account, newest first. Each row carries the balance it produced,
        so the column reads as a running total.
      </p>

      <div v-if="wallet.ledger.length === 0" class="empty">No movements yet.</div>

      <div v-else class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Reference</th>
              <th class="right">Amount</th>
              <th class="right">Balance after</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in wallet.ledger" :key="entry.id">
              <td class="tiny nowrap faint">{{ when(entry.createdAt) }}</td>
              <td>
                <span
                  class="badge"
                  :class="BigInt(entry.amount) > 0n ? 'badge-win' : 'badge-muted'"
                >
                  {{ LEDGER_LABELS[entry.type] ?? entry.type }}
                </span>
              </td>
              <td class="tiny faint">{{ entry.refType ?? "—" }}</td>
              <td
                class="right chips"
                :class="BigInt(entry.amount) > 0n ? 'chips-win' : 'chips-loss'"
              >
                {{ BigInt(entry.amount) > 0n ? "+" : "" }}{{ formatChips(entry.amount) }}
              </td>
              <td class="right chips">{{ formatChips(entry.balanceAfter) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="row-between ledger-foot">
        <span class="tiny faint">
          Showing {{ wallet.ledger.length }} movements, summing to
          <span class="chips">{{ formatChips(ledgerTotal) }}</span> LC.
        </span>
        <button
          v-if="wallet.ledgerCursor"
          class="btn btn-ghost btn-sm"
          :disabled="wallet.loading"
          @click="wallet.loadLedger(false)"
        >
          Load more
        </button>
      </div>
    </section>

    <!-- Spins -->
    <section v-else-if="tab === 'spins'" class="card">
      <div v-if="spins.length === 0" class="empty">No spins yet.</div>

      <div v-else class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Game</th>
              <th class="right">Bet</th>
              <th class="right">Win</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="round in spins" :key="round.roundId">
              <td class="tiny nowrap faint">{{ when(round.createdAt) }}</td>
              <td>
                {{ round.gameSlug }}
                <span v-if="round.isFreeSpin" class="badge badge-gold tiny-badge">Free</span>
              </td>
              <td class="right chips">{{ round.isFreeSpin ? "—" : formatChips(round.bet) }}</td>
              <td class="right chips" :class="Number(round.win) > 0 ? 'chips-win' : 'faint'">
                {{ Number(round.win) > 0 ? `+${formatChips(round.win)}` : "—" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Security -->
    <section v-else class="card">
      <h2>Two-factor authentication</h2>

      <div v-if="securityError" class="alert alert-error">{{ securityError }}</div>

      <template v-if="backupCodes.length">
        <div class="alert alert-ok">
          Two-factor authentication is on. <strong>Save these backup codes now</strong> &mdash; they
          are shown once and each works a single time.
        </div>
        <div class="codes">
          <code v-for="code in backupCodes" :key="code">{{ code }}</code>
        </div>
      </template>

      <template v-else-if="auth.user?.totpEnabled">
        <p class="small muted">
          Two-factor authentication is <strong class="on">enabled</strong>. You have
          {{ auth.backupCodesRemaining }} unused backup codes.
        </p>

        <div class="field narrow-field">
          <label for="disable-code">Enter a current code to turn it off</label>
          <input
            id="disable-code"
            v-model="totpCode"
            class="mono"
            maxlength="6"
            inputmode="numeric"
          />
        </div>
        <button
          class="btn btn-danger"
          :disabled="securityBusy || totpCode.length !== 6"
          @click="disableTotp"
        >
          Turn off two-factor
        </button>
        <p class="tiny faint">
          Administrators cannot turn this off &mdash; the platform requires it for staff accounts.
        </p>
      </template>

      <template v-else-if="totpSetup">
        <p class="small muted">
          Add this secret to an authenticator app, then enter the six-digit code it shows.
          Two-factor is not switched on until a code is confirmed, so a mistyped secret cannot lock
          you out.
        </p>

        <div class="secret-box">
          <span class="tiny faint">Secret</span>
          <code class="secret">{{ totpSetup.secret }}</code>
        </div>

        <div class="field narrow-field">
          <label for="confirm-code">Six-digit code</label>
          <input
            id="confirm-code"
            v-model="totpCode"
            class="mono"
            maxlength="6"
            inputmode="numeric"
            placeholder="000000"
          />
        </div>

        <button
          class="btn btn-primary"
          :disabled="securityBusy || totpCode.length !== 6"
          @click="confirmTotp"
        >
          Confirm &amp; enable
        </button>
      </template>

      <template v-else>
        <p class="small muted">
          Two-factor authentication adds a code from your phone to every sign-in. Optional for
          players, mandatory for staff.
        </p>
        <button class="btn btn-primary" :disabled="securityBusy" @click="beginTotp">
          Set up two-factor
        </button>
      </template>
    </section>
  </div>
</template>

<style scoped>
.balance {
  margin: 2px 0 0;
  font-size: 1.35rem;
  font-weight: 700;
}

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

.ledger-foot {
  margin-top: 12px;
}

.tiny-badge {
  font-size: 0.6rem;
  padding: 1px 6px;
  margin-left: 5px;
}

.on {
  color: var(--win);
}

.narrow-field {
  max-width: 190px;
}

.secret-box {
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 12px;
  margin: 12px 0;
}

.secret {
  display: block;
  font-family: var(--font-mono);
  font-size: 1.05rem;
  letter-spacing: 0.1em;
  color: var(--gold);
  margin-top: 4px;
  word-break: break-all;
}

.codes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 7px;
  margin: 12px 0;
}

.codes code {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  font-family: var(--font-mono);
  font-size: 0.9rem;
  text-align: center;
  color: var(--gold);
}
</style>
