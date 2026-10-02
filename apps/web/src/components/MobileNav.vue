<script setup lang="ts">
/**
 * The bottom navigation bar for small screens.
 *
 * Mobile-first is a PRD requirement, and on a phone the four games need to be one thumb-reach
 * away rather than behind a hamburger. Hidden above 860px, where the header nav takes over.
 */
const items = [
  { to: "/", label: "Lobby", glyph: "◆" },
  { to: "/slots", label: "Slots", glyph: "🎰" },
  { to: "/sports", label: "Sports", glyph: "⚽" },
  { to: "/poker", label: "Poker", glyph: "♠" },
  { to: "/vip", label: "VIP", glyph: "★" },
];
</script>

<template>
  <nav class="mobile-nav" aria-label="Main">
    <RouterLink v-for="item in items" :key="item.to" :to="item.to" class="item">
      <span class="glyph" aria-hidden="true">{{ item.glyph }}</span>
      <span class="label">{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.mobile-nav {
  display: none;
}

@media (max-width: 860px) {
  .mobile-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 45;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    background: rgba(13, 22, 32, 0.96);
    backdrop-filter: blur(12px);
    border-top: 1px solid var(--border);
    /* Keeps the bar clear of the iOS home indicator. */
    padding-bottom: env(safe-area-inset-bottom);
  }

  .item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 8px 4px;
    color: var(--text-faint);
    text-decoration: none;
    font-size: 0.68rem;
    font-weight: 600;
  }

  .item:hover {
    text-decoration: none;
  }

  .item.router-link-active {
    color: var(--gold);
  }

  .glyph {
    font-size: 1.05rem;
    line-height: 1;
  }
}
</style>
