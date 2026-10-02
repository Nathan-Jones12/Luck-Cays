<script setup lang="ts">
/**
 * The header: brand, primary navigation, balance, account menu.
 *
 * The balance sits here on every page because it is the number a player checks constantly, and
 * it updates from the socket, so it stays correct while a bet settles in another tab.
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useWalletStore } from "@/stores/wallet";
import { disconnectSocket } from "@/api/socket";
import ChipBalance from "./ChipBalance.vue";

const auth = useAuthStore();
const wallet = useWalletStore();
const router = useRouter();

const menuOpen = ref(false);

const links = computed(() => [
  { to: "/slots", label: "Slots" },
  { to: "/sports", label: "Sports" },
  { to: "/poker", label: "Poker" },
  { to: "/vip", label: "VIP" },
]);

async function signOut(): Promise<void> {
  menuOpen.value = false;
  disconnectSocket();
  wallet.reset();
  await auth.logout();
  await router.push("/");
}
</script>

<template>
  <header class="header">
    <div class="header-inner">
      <RouterLink to="/" class="brand" @click="menuOpen = false">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-text"> Luck<span class="brand-dash">-</span>Cays </span>
      </RouterLink>

      <nav class="nav" aria-label="Games">
        <RouterLink v-for="link in links" :key="link.to" :to="link.to" class="nav-link">
          {{ link.label }}
        </RouterLink>
      </nav>

      <div class="spacer"></div>

      <template v-if="auth.isSignedIn">
        <ChipBalance />

        <div class="account">
          <button
            class="btn btn-ghost btn-sm account-btn"
            :aria-expanded="menuOpen"
            aria-haspopup="menu"
            @click="menuOpen = !menuOpen"
          >
            {{ auth.user?.username }}
            <span class="caret" aria-hidden="true">▾</span>
          </button>

          <!-- Click-away via a full-screen backdrop: simpler and more reliable than a
               document listener that has to be added and removed. -->
          <template v-if="menuOpen">
            <div class="backdrop" @click="menuOpen = false"></div>
            <div class="menu" role="menu">
              <RouterLink to="/account" class="menu-item" role="menuitem" @click="menuOpen = false">
                Account &amp; history
              </RouterLink>
              <RouterLink to="/vip" class="menu-item" role="menuitem" @click="menuOpen = false">
                VIP progress
              </RouterLink>
              <RouterLink
                v-if="auth.isStaff"
                to="/admin"
                class="menu-item"
                role="menuitem"
                @click="menuOpen = false"
              >
                Back office
              </RouterLink>
              <hr class="menu-sep" />
              <button class="menu-item menu-danger" role="menuitem" @click="signOut">
                Sign out
              </button>
            </div>
          </template>
        </div>
      </template>

      <template v-else>
        <RouterLink to="/login" class="btn btn-ghost btn-sm">Sign in</RouterLink>
        <RouterLink to="/signup" class="btn btn-primary btn-sm"> Play free </RouterLink>
      </template>
    </div>
  </header>
</template>

<style scoped>
.header {
  position: sticky;
  top: 0;
  z-index: 40;
  height: var(--header-height);
  background: rgba(7, 13, 20, 0.86);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}

.header-inner {
  max-width: var(--page-max);
  height: 100%;
  margin: 0 auto;
  padding: 0 16px;
  display: flex;
  align-items: center;
  gap: 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  font-weight: 750;
  font-size: 1.1rem;
  letter-spacing: -0.02em;
  color: var(--text);
  text-decoration: none;
  flex-shrink: 0;
}

.brand:hover {
  text-decoration: none;
}

/* A chip, drawn rather than shipped as an asset: no image request, scales cleanly. */
.brand-mark {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%, var(--surface-1) 0 34%, transparent 35%),
    conic-gradient(
      var(--gold) 0 12.5%,
      var(--surface-3) 0 25%,
      var(--gold) 0 37.5%,
      var(--surface-3) 0 50%,
      var(--gold) 0 62.5%,
      var(--surface-3) 0 75%,
      var(--gold) 0 87.5%,
      var(--surface-3) 0
    );
  border: 1.5px solid var(--gold-dim);
  box-shadow: 0 0 10px var(--gold-glow);
}

.brand-dash {
  color: var(--gold);
}

.nav {
  display: flex;
  gap: 2px;
}

.nav-link {
  padding: 7px 12px;
  border-radius: var(--radius);
  color: var(--text-muted);
  font-weight: 600;
  font-size: 0.92rem;
  text-decoration: none;
  transition:
    color 120ms ease,
    background 120ms ease;
}

.nav-link:hover {
  color: var(--text);
  background: var(--surface-2);
  text-decoration: none;
}

.nav-link.router-link-active {
  color: var(--gold);
  background: rgba(245, 195, 88, 0.1);
}

.account {
  position: relative;
}

.account-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.caret {
  font-size: 0.7rem;
  color: var(--text-faint);
}

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 51;
  min-width: 206px;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  padding: 6px;
}

.menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  color: var(--text);
  font: inherit;
  font-size: 0.9rem;
  background: none;
  border: 0;
  cursor: pointer;
  text-decoration: none;
}

.menu-item:hover {
  background: var(--surface-raised);
  text-decoration: none;
}

.menu-danger {
  color: var(--loss);
}

.menu-sep {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 5px 0;
}

/* The primary nav moves to the bottom bar on small screens. */
@media (max-width: 860px) {
  .nav {
    display: none;
  }
}

@media (max-width: 420px) {
  .brand-text {
    display: none;
  }
}
</style>
