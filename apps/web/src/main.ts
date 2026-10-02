/**
 * Entry point.
 *
 * The session is restored before the app mounts, so the first render already knows whether
 * someone is signed in. Mounting first would flash the signed-out header on every reload.
 */
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { useAuthStore } from "./stores/auth";
import { useWalletStore } from "./stores/wallet";
import { connectSocket } from "./api/socket";
import "./styles/base.css";

const app = createApp(App);
app.use(createPinia());

const auth = useAuthStore();
const wallet = useWalletStore();

// Keep the balance live across tabs, and tear the socket down on sign-out.
auth.ready.then(() => {
  if (auth.isSignedIn) {
    void wallet.refresh();
    connectSocket();
  }
});

void auth.restore().finally(() => {
  app.use(router);
  app.mount("#app");
});
