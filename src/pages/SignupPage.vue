<script setup lang="ts">
/**
 * Create an account.
 *
 * Client-side validation is a courtesy, not a gate - the server re-checks everything, including
 * the password blocklist it alone holds. Field errors from the API are mapped back onto the
 * inputs so a rejection lands next to the field that caused it.
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { formatChips } from "@luck-cays/shared";
import { ApiError } from "@/api/client";
import { connectSocket } from "@/api/socket";
import { useAuthStore } from "@/stores/auth";
import { useWalletStore } from "@/stores/wallet";

const auth = useAuthStore();
const wallet = useWalletStore();
const router = useRouter();

const email = ref("");
const username = ref("");
const password = ref("");
const confirmAdult = ref(false);

const submitting = ref(false);
const error = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const bonus = ref<string | null>(null);

const passwordTooShort = computed(() => password.value.length > 0 && password.value.length < 10);

const canSubmit = computed(
  () =>
    email.value.includes("@") &&
    username.value.length >= 3 &&
    password.value.length >= 10 &&
    confirmAdult.value &&
    !submitting.value,
);

async function submit(): Promise<void> {
  submitting.value = true;
  error.value = null;
  fieldErrors.value = {};

  try {
    const result = await auth.signup({
      email: email.value.trim().toLowerCase(),
      username: username.value.trim(),
      password: password.value,
      confirmAdult: true,
    });

    bonus.value = result.signupBonus;
    await wallet.refresh();
    connectSocket();

    // A beat on the confirmation, so the bonus registers before the lobby appears.
    setTimeout(() => void router.push("/slots"), 1600);
  } catch (caught) {
    if (caught instanceof ApiError) {
      fieldErrors.value = caught.fieldErrors;
      error.value = Object.keys(caught.fieldErrors).length > 0 ? null : caught.message;
    } else {
      error.value = "Could not create the account. Please try again.";
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page narrow">
    <div v-if="bonus" class="card center welcome">
      <div class="welcome-mark" aria-hidden="true"></div>
      <h1>You are in</h1>
      <p class="chips chips-gold welcome-amount">+{{ formatChips(bonus) }} LC</p>
      <p class="muted">Your signup bonus has landed. Taking you to the slots&hellip;</p>
    </div>

    <div v-else class="card">
      <h1>Create an account</h1>
      <p class="muted small">
        Free, instant, and we will add
        <strong class="chips chips-gold">{{ formatChips("10000") }} LC</strong> to your wallet.
        Already have one? <RouterLink to="/login">Sign in</RouterLink>.
      </p>

      <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>

      <form @submit.prevent="submit">
        <div class="field">
          <label for="email">Email</label>
          <input id="email" v-model="email" type="email" autocomplete="email" required />
          <p v-if="fieldErrors['email']" class="field-error">{{ fieldErrors["email"] }}</p>
        </div>

        <div class="field">
          <label for="username">Username</label>
          <input
            id="username"
            v-model="username"
            autocomplete="username"
            minlength="3"
            maxlength="20"
            required
          />
          <p v-if="fieldErrors['username']" class="field-error">{{ fieldErrors["username"] }}</p>
          <p v-else class="hint">3 to 20 characters. Letters, numbers and underscore.</p>
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            autocomplete="new-password"
            minlength="10"
            required
          />
          <p v-if="fieldErrors['password']" class="field-error">{{ fieldErrors["password"] }}</p>
          <p v-else-if="passwordTooShort" class="field-error">
            At least 10 characters ({{ 10 - password.length }} to go).
          </p>
          <p v-else class="hint">
            At least 10 characters. A passphrase beats a short password with symbols in it.
          </p>
        </div>

        <div class="field adult">
          <label class="checkbox">
            <input v-model="confirmAdult" type="checkbox" required />
            <span>
              I confirm I am 18 or over, and I understand Luck-Cays Chips have no cash value and
              cannot be withdrawn.
            </span>
          </label>
          <p v-if="fieldErrors['confirmAdult']" class="field-error">
            {{ fieldErrors["confirmAdult"] }}
          </p>
        </div>

        <button class="btn btn-primary btn-block btn-lg" type="submit" :disabled="!canSubmit">
          <span v-if="submitting" class="spinner"></span>
          <span v-else>Create account &amp; claim chips</span>
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.narrow {
  max-width: 460px;
}

.checkbox {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 0.86rem;
  font-weight: 400;
  color: var(--text-muted);
  text-transform: none;
  letter-spacing: 0;
  margin: 0;
  cursor: pointer;
}

.checkbox input {
  margin-top: 3px;
  flex-shrink: 0;
}

.adult {
  margin: 18px 0;
}

.welcome {
  padding: 44px 24px;
}

.welcome-mark {
  width: 56px;
  height: 56px;
  margin: 0 auto 18px;
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
  border: 2px solid var(--gold-dim);
  box-shadow: 0 0 26px var(--gold-glow);
  animation: pop 500ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.welcome-amount {
  font-size: 2.2rem;
  font-weight: 750;
  margin: 4px 0 10px;
}

@keyframes pop {
  from {
    transform: scale(0.4);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
</style>
