<script setup lang="ts">
/**
 * The app shell: header, routed page, footer.
 *
 * The footer carries the play-money disclaimer on every page, not just the lobby. It is the
 * single most important thing on the site to be unambiguous about, and burying it on one page
 * would be the wrong call.
 */
import AppHeader from "@/components/AppHeader.vue";
import MobileNav from "@/components/MobileNav.vue";
</script>

<template>
  <AppHeader />

  <main>
    <!-- Keyed on the full path so navigating between two slots remounts the renderer
         rather than trying to reuse a canvas bound to the previous game. -->
    <RouterView v-slot="{ Component, route }">
      <component :is="Component" :key="route.fullPath" />
    </RouterView>
  </main>

  <footer class="footer">
    <div class="footer-inner">
      <p class="footer-notice">
        <strong>Luck-Cays is play-money only.</strong> Luck-Cays Chips (LC) are a virtual currency
        with no cash value. They cannot be bought, sold, withdrawn or exchanged for anything. There
        is no deposit path and never will be.
      </p>
      <p class="tiny faint">
        18+. A prototype build &mdash; outcomes are decided server-side using
        <code>crypto.randomInt</code>, and every slot's return-to-player figure is published in the
        repository under <code>docs/rtp/</code>.
      </p>
    </div>
  </footer>

  <MobileNav />
</template>

<style scoped>
main {
  min-height: calc(100vh - var(--header-height) - 180px);
}

.footer {
  border-top: 1px solid var(--border);
  background: var(--surface-1);
  margin-top: 40px;
  /* Clears the fixed mobile nav so the last line of text is never hidden behind it. */
  padding-bottom: env(safe-area-inset-bottom);
}

.footer-inner {
  max-width: var(--page-max);
  margin: 0 auto;
  padding: 24px 16px;
}

.footer-notice {
  color: var(--text-muted);
  font-size: 0.88rem;
  max-width: 78ch;
  margin-bottom: 8px;
}

.footer-notice strong {
  color: var(--gold);
}

code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: 4px;
}

@media (max-width: 860px) {
  .footer {
    margin-bottom: 64px;
  }
}
</style>
