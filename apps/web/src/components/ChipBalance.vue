<script setup lang="ts">
/**
 * The chip balance, with a brief flash when it changes.
 *
 * The flash colour says which direction it moved, which is the fastest possible feedback that
 * a spin paid. It watches the formatted string rather than animating a counter: the number is
 * a bigint and tweening one through a float is exactly how a balance display starts lying.
 */
import { computed, ref, watch } from "vue";
import { chipsFromJson } from "@luck-cays/shared";
import { useWalletStore } from "@/stores/wallet";

const wallet = useWalletStore();
const flash = ref<"up" | "down" | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => wallet.balance,
  (next, previous) => {
    if (previous === undefined) return;
    const delta = chipsFromJson(next) - chipsFromJson(previous);
    if (delta === 0n) return;

    flash.value = delta > 0n ? "up" : "down";
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      flash.value = null;
    }, 700);
  },
);

const label = computed(() => `Balance: ${wallet.formatted} Luck-Cays Chips`);
</script>

<template>
  <div class="balance" :class="flash ? `flash-${flash}` : ''" :aria-label="label" role="status">
    <span class="chip-dot" aria-hidden="true"></span>
    <span class="chips amount">{{ wallet.formatted }}</span>
    <span class="unit">LC</span>
  </div>
</template>

<style scoped>
.balance {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  font-weight: 650;
  transition:
    border-color 220ms ease,
    background 220ms ease;
  flex-shrink: 0;
}

.chip-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--gold);
  box-shadow: 0 0 7px var(--gold-glow);
  flex-shrink: 0;
}

.amount {
  color: var(--gold);
  font-size: 0.95rem;
}

.unit {
  color: var(--text-faint);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.flash-up {
  border-color: var(--win);
  background: rgba(74, 222, 128, 0.14);
}

.flash-down {
  border-color: var(--loss-dim);
  background: rgba(248, 113, 113, 0.1);
}

@media (max-width: 420px) {
  .balance {
    padding: 5px 9px;
  }
  .amount {
    font-size: 0.88rem;
  }
  .unit {
    display: none;
  }
}
</style>
