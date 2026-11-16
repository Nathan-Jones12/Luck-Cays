<script setup lang="ts">
/**
 * Embeds a game that ships its own client, inside the main site.
 *
 * Most slots are drawn by the shared PixiJS renderer, which animates a reel strip travelling
 * to a stop. A game with weighted reels has no strip and no stop, and one with a coin feature
 * has symbols the renderer does not know how to draw - "242 Wild Harbour" is both. Those games
 * come with their own page, and this mounts it.
 *
 * It reuses the embedding machinery rather than inventing a second path: mint a one-shot launch
 * ticket, iframe it, and relay `postMessage`. The main site is just another host page as far as
 * the game is concerned, which means the path players use is the same one our other front-ends
 * use, and gets exercised every time anybody plays.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { EMBED_PROTOCOL, gameToHostSchema, type LaunchTicket } from "@luck-cays/shared";
import { api, ApiError } from "@/api/client";
import { useWalletStore } from "@/stores/wallet";

const props = defineProps<{ gameSlug: string }>();
const emit = defineEmits<{ exit: []; ready: [] }>();

const wallet = useWalletStore();

const frame = ref<HTMLIFrameElement | null>(null);
const src = ref<string | null>(null);
const gameOrigin = ref<string | null>(null);
const height = ref(620);
const error = ref<string | null>(null);
const loading = ref(true);

async function mintTicket(): Promise<LaunchTicket> {
  return api.post<LaunchTicket>("/launch", {
    gameSlug: props.gameSlug,
    brand: "luck-cays",
    origin: window.location.origin,
  });
}

function onMessage(event: MessageEvent): void {
  // Only the game's own origin, and only our protocol. This window is shared with whatever
  // else the page runs.
  if (gameOrigin.value && event.origin !== gameOrigin.value) return;

  const payload = event.data as { protocol?: unknown } | null;
  if (!payload || payload.protocol !== EMBED_PROTOCOL) return;

  const parsed = gameToHostSchema.safeParse(event.data);
  if (!parsed.success) return;

  const message = parsed.data;

  switch (message.type) {
    case "ready":
      loading.value = false;
      emit("ready");
      break;

    case "balance":
      // The server is the authority; this only mirrors it into the header.
      wallet.setBalance(message.balance);
      break;

    case "resize":
      height.value = message.height;
      break;

    case "exit":
      emit("exit");
      break;

    case "error":
      // An expired session is recoverable: mint a fresh ticket and hand it over, so the player
      // keeps their place and any free-spin run continues rather than reloading the frame.
      if (message.code === "GAME_SESSION_EXPIRED") {
        void mintTicket()
          .then((ticket) => {
            const token = new URL(ticket.launchUrl).searchParams.get("token");
            if (!token || !frame.value?.contentWindow || !gameOrigin.value) return;
            frame.value.contentWindow.postMessage(
              { protocol: EMBED_PROTOCOL, type: "resume", token },
              gameOrigin.value,
            );
          })
          .catch(() => {
            error.value = "That game session expired and could not be renewed.";
          });
        return;
      }
      error.value = message.message;
      loading.value = false;
      break;
  }
}

onMounted(async () => {
  try {
    const ticket = await mintTicket();
    gameOrigin.value = new URL(ticket.launchUrl).origin;
    src.value = ticket.launchUrl;
    window.addEventListener("message", onMessage);
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : "Could not start this game.";
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
});
</script>

<template>
  <div class="embedded">
    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>

    <div v-if="loading && !error" class="loading">Starting game&hellip;</div>

    <!--
      Least privilege. The game needs scripts and same-origin for its own storage; it is
      explicitly NOT granted top-level navigation, so it cannot redirect the site around it.
    -->
    <iframe
      v-if="src"
      ref="frame"
      :src="src"
      :style="{ height: `${height}px` }"
      title="Game"
      class="frame"
      :class="{ hidden: loading }"
      scrolling="no"
      sandbox="allow-scripts allow-same-origin allow-forms"
      allow="autoplay"
    ></iframe>
  </div>
</template>

<style scoped>
.embedded {
  position: relative;
}

.loading {
  display: grid;
  place-items: center;
  min-height: 320px;
  color: var(--text-faint);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

.frame {
  display: block;
  width: 100%;
  border: 0;
  border-radius: var(--radius);
  background: #06122a;
  transition: opacity 200ms ease;
}

/* Kept in the DOM while loading so the iframe actually loads, just not shown mid-paint. */
.hidden {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
</style>
