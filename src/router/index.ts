import { createRouter, createWebHistory } from "vue-router";
import MainPage from "@/pages/MainPage.vue";
import LoginPage from "@/pages/LoginPage.vue";
import RegisterPage from "@/pages/RegisterPage.vue";
import { useAuthStore } from "@/stores/auth";
import { hasLesson } from "@/lessons/index";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "main", component: MainPage, meta: { requiresAuth: true } },
    { path: "/login", name: "login", component: LoginPage },
    { path: "/register", name: "register", component: RegisterPage },
    {
      path: "/lesson/:id",
      name: "lesson",
      component: () => import("@/pages/LessonPage.vue"),
      meta: { requiresAuth: true },
    },
  ],
});

// Auth guard. On the first navigation we rehydrate the session from the HttpOnly
// cookie (server check). Unauthenticated users hitting a protected route are sent
// to /login with a ?redirect= back to where they were going; already-authed users
// visiting /login are bounced to the app. This is a UX gate — the cookie check on
// the server is the real security boundary.
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.fetchMe();

  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if ((to.name === "login" || to.name === "register") && auth.isAuthenticated) {
    return { name: "main" };
  }

  // Lessons. A nicupicu lesson account whose id has lesson content lands on its
  // lesson page (launch redirects to /, so this catches launches and reloads)
  // and stays there; accounts without content keep the MainPage fallback.
  const own = auth.lesson?.id;
  if (to.name === "main" && own && hasLesson(own)) {
    return { name: "lesson", params: { id: own } };
  }
  if (to.name === "lesson") {
    const id = String(to.params.id);
    if (own && id !== own) return hasLesson(own) ? { name: "lesson", params: { id: own } } : { name: "main" };
    if (!hasLesson(id)) return { name: "main" };
  }
  return true;
});

export default router;
