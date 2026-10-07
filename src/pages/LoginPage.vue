<script setup lang="ts">
/**
 * Sign in, with the two-factor step.
 *
 * The 2FA field only appears after the server says it is needed, so a player without 2FA never
 * sees it. We cannot know in advance without telling an attacker which accounts have it.
 */
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError } from "@/api/client";
import { connectSocket } from "@/api/socket";
import { useAuthStore } from "@/stores/auth";
import { useWalletStore } from "@/stores/wallet";

const auth = useAuthStore();
const wallet = useWalletStore();
const router = useRouter();
const route = useRoute();

const email = ref("");
const password = ref("");
const totp = ref("");
const backupCode = ref("");
const useBackupCode = ref(false);

/** Set once the server has told us this account needs a second factor. */
const needsSecondFactor = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);

async function submit(): Promise<void> {
  submitting.value = true;
  error.value = null;

  try {
    await auth.login({
      email: email.value.trim(),
      password: password.value,
      ...(needsSecondFactor.value && !useBackupCode.value && totp.value
        ? { totp: totp.value }
        : {}),
      ...(needsSecondFactor.value && useBackupCode.value && backupCode.value
        ? { backupCode: backupCode.value }
        : {}),
    });

    await wallet.refresh();
    connectSocket();

    const next = typeof route.query["next"] === "string" ? route.query["next"] : "/";
    await router.push(next);
  } catch (caught) {
    if (caught instanceof ApiError) {
      // These codes mean the password was right and only the second factor is outstanding.
      if (caught.code === "TOTP_REQUIRED") {
        needsSecondFactor.value = true;
        error.value = "Enter the six-digit code from your authenticator app.";
      } else if (caught.code === "TOTP_INVALID" || caught.code === "BACKUP_CODE_INVALID") {
        needsSecondFactor.value = true;
        error.value = caught.message;
      } else if (caught.code === "TOTP_REQUIRED_FOR_ADMIN") {
        error.value =
          "Administrators must have two-factor authentication enabled. Enrol it on the account first.";
      } else {
        error.value = caught.message;
      }
    } else {
      error.value = "Could not sign in. Please try again.";
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page narrow">
    <div class="card">
      <h1>Sign in</h1>
      <p class="muted small">
        No account? <RouterLink to="/signup">Create one</RouterLink> and we will add 10,000 chips.
      </p>

      <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>

      <form @submit.prevent="submit">
        <div class="field">
          <label for="email">Email</label>
          <input
            id="email"
            v-model="email"
            type="email"
            autocomplete="email"
            required
            :disabled="needsSecondFactor"
          />
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            :disabled="needsSecondFactor"
          />
        </div>

        <template v-if="needsSecondFactor">
          <div v-if="!useBackupCode" class="field">
            <label for="totp">Authenticator code</label>
            <input
              id="totp"
              v-model="totp"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              pattern="\d{6}"
              placeholder="000000"
              class="mono"
              required
            />
            <button type="button" class="link-btn" @click="useBackupCode = true">
              Use a backup code instead
            </button>
          </div>

          <div v-else class="field">
            <label for="backup">Backup code</label>
            <input
              id="backup"
              v-model="backupCode"
              class="mono"
              placeholder="XXXXX-XXXXX"
              required
            />
            <button type="button" class="link-btn" @click="useBackupCode = false">
              Use my authenticator app
            </button>
          </div>
        </template>

        <button class="btn btn-primary btn-block btn-lg" type="submit" :disabled="submitting">
          <span v-if="submitting" class="spinner"></span>
          <span v-else>Sign in</span>
        </button>
      </form>

      <hr class="divider" />

      <details class="demo">
        <summary>Demo credentials</summary>
        <p class="tiny faint">
          The seeded player account is <code>player@luck-cays.test</code> with the password
          <code>luckcays-demo-2026</code>. The admin account uses the same password but requires the
          authenticator secret printed when you ran <code>npm run db:seed</code>.
        </p>
      </details>
    </div>
  </div>
</template>

<style scoped>
.narrow {
  max-width: 440px;
}

.link-btn {
  background: none;
  border: 0;
  color: var(--teal);
  font: inherit;
  font-size: 0.82rem;
  padding: 0;
  margin-top: 7px;
  cursor: pointer;
  text-decoration: underline;
}

.demo summary {
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--text-muted);
  font-weight: 600;
}

.demo p {
  margin: 8px 0 0;
}

code {
  font-family: var(--font-mono);
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
}
</style>
