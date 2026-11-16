/**
 * The embeddable game's entry point.
 *
 * No router and no Pinia: one game, one screen, nothing to navigate. Keeping them out means
 * the game bundle does not pull in the whole site's state layer.
 */
import { createApp } from "vue";
import GameShell from "./GameShell.vue";

createApp(GameShell).mount("#game");
