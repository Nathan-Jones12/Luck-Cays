/**
 * Routes and the navigation guards.
 *
 * Pages are lazily imported so the slots bundle (which pulls in PixiJS) is not downloaded by
 * someone who only came to look at the sportsbook.
 *
 * The guard waits for `restoring` to settle before deciding. Without that wait, a reload on a
 * protected page would bounce to the login screen for the split second before the refresh
 * completed - the session is valid, we just have not asked yet.
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { useAuthStore } from "@/stores/auth";

declare module "vue-router" {
  interface RouteMeta {
    /** Requires a signed-in player. */
    auth?: boolean;
    /** Requires the admin or support role. */
    staff?: boolean;
    title?: string;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "lobby",
    component: () => import("@/pages/LobbyPage.vue"),
    meta: { title: "Lobby" },
  },
  {
    path: "/login",
    name: "login",
    component: () => import("@/pages/LoginPage.vue"),
    meta: { title: "Sign in" },
  },
  {
    path: "/signup",
    name: "signup",
    component: () => import("@/pages/SignupPage.vue"),
    meta: { title: "Create an account" },
  },
  {
    path: "/slots",
    name: "slots",
    component: () => import("@/pages/SlotsPage.vue"),
    meta: { title: "Slots" },
  },
  {
    path: "/slots/:slug",
    name: "slot",
    component: () => import("@/pages/SlotGamePage.vue"),
    meta: { auth: true, title: "Slots" },
  },
  {
    path: "/sports",
    name: "sports",
    component: () => import("@/pages/SportsPage.vue"),
    meta: { title: "Sports" },
  },
  {
    path: "/poker",
    name: "poker",
    component: () => import("@/pages/PokerPage.vue"),
    meta: { title: "Poker" },
  },
  {
    path: "/poker/:id",
    name: "poker-table",
    component: () => import("@/pages/PokerTablePage.vue"),
    meta: { auth: true, title: "Poker table" },
  },
  {
    path: "/vip",
    name: "vip",
    component: () => import("@/pages/VipPage.vue"),
    meta: { title: "VIP rewards" },
  },
  {
    path: "/account",
    name: "account",
    component: () => import("@/pages/AccountPage.vue"),
    meta: { auth: true, title: "Account" },
  },
  {
    path: "/admin",
    name: "admin",
    component: () => import("@/pages/AdminPage.vue"),
    meta: { auth: true, staff: true, title: "Back office" },
  },
  {
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: () => import("@/pages/NotFoundPage.vue"),
    meta: { title: "Not found" },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // Wait out the initial refresh so a reload on a protected page does not bounce.
  await auth.ready;

  if (to.meta.auth && !auth.isSignedIn) {
    // Remember where they were going, so signing in lands them there.
    return { name: "login", query: { next: to.fullPath } };
  }

  if (to.meta.staff && !auth.isStaff) {
    return { name: "lobby" };
  }

  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} - Luck-Cays` : "Luck-Cays";
});
