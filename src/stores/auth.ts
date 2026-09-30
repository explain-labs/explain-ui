import { defineStore } from "pinia";
import { ref, computed } from "vue";

// Authenticated session state. Credentials are verified server-side against
// MongoDB (see server/auth.mjs); the session itself is an HttpOnly cookie that
// JS cannot read, so we never hold a token here — we only mirror the public user
// fields the server hands back, and rely on `fetchMe()` to rehydrate on reload.

export interface AuthUser {
  email: string;
  name: string;
  admin: boolean;
  institution: string;
  modelDeveloper: boolean;
  defaultState: string | null;
  defaultLocalState: string | null;
  // Set only for a nicupicu.nl lesson account (entered via /api/auth/launch).
  lesson?: LessonProfile | null;
}

export interface LessonProfile {
  id: string;
  title: string;
  scenario: string | null; // bundled scenario to start from, or
  stateId: string | null; // an admin-curated cloud state (takes precedence)
  allowScenarioSwitch: boolean;
  readonly: boolean;
}

type Status = "idle" | "loading" | "authed" | "error";

// In dev (`npm run dev`) we skip MongoDB auth entirely and auto-login as a local
// `developer` account, so engine/model work doesn't require an IP-whitelisted Atlas
// connection. A production build (`import.meta.env.DEV === false`) always uses the real
// MongoDB login below. The developer's chosen default scenario is persisted per-device
// in localStorage (mirrors the cloud `defaultLocalState` field).
const DEV = import.meta.env.DEV;
// Whether a MongoDB backend is available. Always true in production; in dev only
// when .env.local sets MONGODB_URI. Without it, `npm run dev` is "local mode":
// DB-backed features (cloud states, admin, lesson launch) are hidden, so model
// developers need neither a DB nor an SSH tunnel.
const HAS_DB = !DEV || __EXPLAIN_DEV_DB__;
const LOCAL_DEFAULT_KEY = "explain.model.defaultLocalState";

function makeDevUser(): AuthUser {
  return {
    email: "developer@localhost",
    name: "developer",
    admin: true, // so admin-only UI doesn't error; harmless on a local-only account
    institution: "local",
    modelDeveloper: true, // unlocks the scenario picker + star toggle
    defaultState: null,
    defaultLocalState: localStorage.getItem(LOCAL_DEFAULT_KEY) || null,
  };
}

export const useAuthStore = defineStore("auth", () => {
  const user = ref<AuthUser | null>(null);
  const status = ref<Status>("idle");
  const error = ref<string | null>(null);
  // Whether we've completed the initial cookie check (used by the router guard).
  const ready = ref(false);

  const isAuthenticated = computed(() => user.value !== null);
  const lesson = computed(() => user.value?.lesson ?? null);

  // Dev-only: persist the developer's chosen startup scenario to localStorage so this
  // device reloads it. Pass null to clear (falls back to the bundled term_neonate).
  function setDefaultLocalState(name: string | null) {
    if (name) localStorage.setItem(LOCAL_DEFAULT_KEY, name);
    else localStorage.removeItem(LOCAL_DEFAULT_KEY);
    if (user.value) user.value.defaultLocalState = name;
  }

  async function login(email: string, password: string): Promise<boolean> {
    status.value = "loading";
    error.value = null;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        user.value = null;
        status.value = "error";
        error.value = data?.error ?? "login failed";
        return false;
      }
      user.value = data.user as AuthUser;
      status.value = "authed";
      ready.value = true;
      return true;
    } catch (e) {
      user.value = null;
      status.value = "error";
      error.value = `network error: ${String(e)}`;
      return false;
    }
  }

  async function register(fields: {
    name: string;
    email: string;
    institution: string;
    password: string;
  }): Promise<boolean> {
    status.value = "loading";
    error.value = null;
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(fields),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        user.value = null;
        status.value = "error";
        error.value = data?.error ?? "registration failed";
        return false;
      }
      // Server signs us in on success (sets the session cookie).
      user.value = data.user as AuthUser;
      status.value = "authed";
      ready.value = true;
      return true;
    } catch (e) {
      user.value = null;
      status.value = "error";
      error.value = `network error: ${String(e)}`;
      return false;
    }
  }

  // Rehydrate the session from the HttpOnly cookie. Safe to call repeatedly;
  // the router guard calls it once before the first protected navigation.
  async function fetchMe(): Promise<boolean> {
    // Dev bypass: auto-login as the local developer, never touch MongoDB — unless a
    // lesson launch (/api/auth/launch) just set a real session, so launches can be
    // tested under `npm run dev`. Any other real session is ignored in dev.
    if (DEV) {
      if (!HAS_DB) {
        user.value = makeDevUser();
        status.value = "authed";
        ready.value = true;
        return true;
      }
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        const data = res.ok ? await res.json() : null;
        if (data?.user?.lesson) {
          user.value = data.user as AuthUser;
          status.value = "authed";
          ready.value = true;
          return true;
        }
      } catch {
        /* no Mongo in dev — fall through to the local developer */
      }
      user.value = makeDevUser();
      status.value = "authed";
      ready.value = true;
      return true;
    }
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        user.value = data.user as AuthUser;
        status.value = "authed";
      } else {
        user.value = null;
        status.value = "idle";
      }
    } catch {
      user.value = null;
      status.value = "idle";
    } finally {
      ready.value = true;
    }
    return isAuthenticated.value;
  }

  // --- Admin-only ---
  // List all users (admin). Returns the array (empty on failure).
  async function listUsers(): Promise<AuthUser[]> {
    try {
      const res = await fetch("/api/auth/users", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `list failed (${res.status})`);
      return (data.users ?? []) as AuthUser[];
    } catch (e) {
      error.value = String(e);
      return [];
    }
  }

  // Set a user's model-developer flag (admin). Returns the updated user or null.
  async function setModelDeveloper(
    email: string,
    value: boolean,
  ): Promise<AuthUser | null> {
    try {
      const res = await fetch("/api/auth/set-model-developer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, modelDeveloper: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `update failed (${res.status})`);
      return data.user as AuthUser;
    } catch (e) {
      error.value = String(e);
      return null;
    }
  }

  async function logout(): Promise<void> {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      /* clear client state regardless of network outcome */
    }
    user.value = null;
    status.value = "idle";
    error.value = null;
  }

  return {
    hasDb: HAS_DB,
    user,
    lesson,
    status,
    error,
    ready,
    isAuthenticated,
    login,
    register,
    fetchMe,
    logout,
    listUsers,
    setModelDeveloper,
    setDefaultLocalState,
  };
});
