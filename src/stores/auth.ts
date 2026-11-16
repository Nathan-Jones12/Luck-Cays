/**
 * The session store.
 *
 * `restore()` runs once at startup and attempts a refresh. That is how a page reload stays
 * signed in without the access token ever being written to storage: the httpOnly cookie
 * survives the reload, and the token is minted fresh from it.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AuthSession, PublicUser, Role } from "@luck-cays/shared";
import { api, onSessionExpired, setAccessToken } from "@/api/client";

export const useAuthStore = defineStore("auth", () => {
  const user = ref<PublicUser | null>(null);
  const backupCodesRemaining = ref(0);
  /** True until the initial refresh attempt settles, so routes can wait rather than bounce. */
  const restoring = ref(true);

  /**
   * Resolves once the startup refresh has settled. The router awaits this, so a reload on a
   * protected page waits for the real answer rather than bouncing to the login screen for the
   * split second before the refresh returns.
   */
  let readyResolve: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const isSignedIn = computed(() => user.value !== null);
  const role = computed<Role | null>(() => user.value?.role ?? null);
  const isStaff = computed(() => role.value === "admin" || role.value === "support");
  const isAdmin = computed(() => role.value === "admin");

  function adopt(session: AuthSession): void {
    setAccessToken(session.accessToken);
    user.value = session.user;
  }

  function clear(): void {
    setAccessToken(null);
    user.value = null;
    backupCodesRemaining.value = 0;
  }

  async function restore(): Promise<void> {
    restoring.value = true;
    try {
      // The refresh cookie is the only thing that survives a reload; if it is gone or
      // revoked this throws and we are simply signed out.
      const session = await api.post<AuthSession>("/auth/refresh");
      adopt(session);
      await loadMe();
    } catch {
      clear();
    } finally {
      restoring.value = false;
      readyResolve();
    }
  }

  async function loadMe(): Promise<void> {
    const result = await api.get<{ user: PublicUser; backupCodesRemaining: number }>("/auth/me");
    user.value = result.user;
    backupCodesRemaining.value = result.backupCodesRemaining;
  }

  interface SignupResult extends AuthSession {
    signupBonus: string;
    verificationToken?: string;
  }

  async function signup(input: {
    email: string;
    username: string;
    password: string;
    confirmAdult: true;
  }): Promise<SignupResult> {
    const result = await api.post<SignupResult>("/auth/signup", input);
    adopt(result);
    return result;
  }

  async function login(input: {
    email: string;
    password: string;
    totp?: string;
    backupCode?: string;
  }): Promise<void> {
    const session = await api.post<AuthSession>("/auth/login", input);
    adopt(session);
  }

  async function logout(): Promise<void> {
    try {
      await api.post("/auth/logout");
    } finally {
      // Clear locally even if the call failed - the user asked to be signed out.
      clear();
    }
  }

  // A failed refresh mid-session means the session is genuinely over.
  onSessionExpired(clear);

  return {
    user,
    backupCodesRemaining,
    restoring,
    ready,
    isSignedIn,
    role,
    isStaff,
    isAdmin,
    restore,
    loadMe,
    signup,
    login,
    logout,
    clear,
  };
});
