<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Button from "primevue/button";
import { useAuthStore } from "@/stores/auth";

// Branded login screen. Credentials are checked server-side (MongoDB + bcrypt)
// and a signed HttpOnly session cookie is set; on success we route to the
// originally-requested page (?redirect=) or the app root.

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const email = ref("");
const password = ref("");

const redirectTarget = () => {
  const r = route.query.redirect;
  return typeof r === "string" && r.startsWith("/") ? r : "/";
};

// Set by /api/auth/launch when a nicupicu.nl lesson link didn't work.
const launchMessage =
  route.query.launch === "invalid"
    ? "This lesson link is invalid or has expired. Please reopen it from nicupicu.nl."
    : route.query.launch === "error"
      ? "The lesson could not be opened right now. Please try again later."
      : null;

// If an existing cookie already authenticates us, skip the form.
onMounted(async () => {
  if (!auth.ready) await auth.fetchMe();
  if (auth.isAuthenticated) router.replace(redirectTarget());
});

async function submit() {
  if (!email.value || !password.value || auth.status === "loading") return;
  const ok = await auth.login(email.value.trim(), password.value);
  if (ok) router.replace(redirectTarget());
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4 bg-surface-950">
    <div
      class="w-full max-w-sm flex flex-col gap-6 rounded-xl border border-surface-700 bg-surface-900 px-7 py-8 shadow-lg"
    >
      <div class="flex flex-col items-center gap-3">
        <img
          src="/logo/explain-labs-logo.svg"
          alt="Explain Labs"
          class="h-16 w-auto"
        />
        <h1 class="text-lg font-medium text-surface-100">Sign in</h1>
      </div>

      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <div class="flex flex-col gap-1.5">
          <label for="email" class="text-sm text-surface-300">Email</label>
          <InputText
            id="email"
            v-model="email"
            type="email"
            autocomplete="username"
            placeholder="you@example.com"
            class="w-full"
            :disabled="auth.status === 'loading'"
            autofocus
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="password" class="text-sm text-surface-300">Password</label>
          <Password
            input-id="password"
            v-model="password"
            :feedback="false"
            toggle-mask
            input-class="w-full"
            class="w-full"
            :input-props="{ autocomplete: 'current-password' }"
            :disabled="auth.status === 'loading'"
          />
        </div>

        <p v-if="launchMessage && !auth.error" class="text-sm text-amber-400" role="alert">
          {{ launchMessage }}
        </p>
        <p v-if="auth.error" class="text-sm text-red-400" role="alert">
          {{ auth.error }}
        </p>

        <Button
          type="submit"
          label="Sign in"
          class="w-full"
          :loading="auth.status === 'loading'"
          :disabled="!email || !password"
        />
      </form>

      <p class="text-center text-sm text-surface-400">
        Don't have an account?
        <RouterLink to="/register" class="text-primary-400 hover:underline">
          Create one
        </RouterLink>
      </p>
    </div>
  </div>
</template>
