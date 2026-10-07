/**
 * The wallet store: the balance, the ledger, and the bonus state.
 *
 * The balance is the single source of truth for every "can I afford this" check in the UI,
 * and it is only ever set from a server response. The UI never decrements it optimistically -
 * the server decides what a spin costs, and guessing would let the displayed balance drift
 * from the real one.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { chipsFromJson, formatChips, type BonusStatus, type LedgerEntry } from "@luck-cays/shared";
import { api, idempotencyKey } from "@/api/client";

export const useWalletStore = defineStore("wallet", () => {
  /** Chips, as a decimal string. Parsed to bigint for comparisons, never to a number. */
  const balance = ref("0");
  const ledger = ref<LedgerEntry[]>([]);
  const ledgerCursor = ref<string | null>(null);
  const bonuses = ref<BonusStatus | null>(null);
  const loading = ref(false);

  const balanceChips = computed(() => chipsFromJson(balance.value));
  const formatted = computed(() => formatChips(balance.value));

  function setBalance(next: string): void {
    balance.value = next;
  }

  function canAfford(amount: string | bigint): boolean {
    const needed = typeof amount === "bigint" ? amount : chipsFromJson(amount);
    return balanceChips.value >= needed;
  }

  async function refresh(): Promise<void> {
    const result = await api.get<{ balance: string }>("/wallet");
    balance.value = result.balance;
  }

  async function loadBonuses(): Promise<void> {
    bonuses.value = await api.get<BonusStatus>("/wallet/bonuses");
  }

  async function claimDaily(): Promise<string> {
    const result = await api.post<{ amount: string; balance: string }>("/wallet/bonuses/claim", {
      bonusType: "daily",
      idempotencyKey: idempotencyKey("daily"),
    });
    balance.value = result.balance;
    await loadBonuses();
    return result.amount;
  }

  async function loadLedger(reset = true): Promise<void> {
    loading.value = true;
    try {
      const query = new URLSearchParams({ limit: "30" });
      if (!reset && ledgerCursor.value) query.set("cursor", ledgerCursor.value);

      const page = await api.get<{ entries: LedgerEntry[]; nextCursor: string | null }>(
        `/wallet/ledger?${query.toString()}`,
      );

      ledger.value = reset ? page.entries : [...ledger.value, ...page.entries];
      ledgerCursor.value = page.nextCursor;
    } finally {
      loading.value = false;
    }
  }

  function reset(): void {
    balance.value = "0";
    ledger.value = [];
    ledgerCursor.value = null;
    bonuses.value = null;
  }

  return {
    balance,
    balanceChips,
    formatted,
    ledger,
    ledgerCursor,
    bonuses,
    loading,
    setBalance,
    canAfford,
    refresh,
    loadBonuses,
    claimDaily,
    loadLedger,
    reset,
  };
});
