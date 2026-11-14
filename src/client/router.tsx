import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";

import { AppLink } from "@/components/ui/app-link";
import { registerRouter } from "@/client/navigation";
import { HomeRouteView } from "./routes/home-page";
import { LoginRouteView } from "./routes/login-page";
import { DashboardRouteView } from "./routes/dashboard-page";
import { AccountRouteView } from "./routes/account-page";
import { WorkspaceLayoutRouteView } from "./routes/workspace-layout";
import { WorkspaceRouteView } from "./routes/workspace-page";
import { EditorRouteView } from "./routes/editor-page";

export type LoginSearch = {
  redirectTo?: string;
};

export type DashboardSearch = {
  session_id?: string;
};

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4 text-center">
      <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Page Not Found</h1>
      <p className="text-zinc-400 mb-6 text-sm">The requested page does not exist or has been moved.</p>
      <AppLink to="/" className="text-sm text-indigo-400 hover:text-indigo-300 underline">
        Return to Home
      </AppLink>
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRouteView,
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirectTo: typeof search.redirectTo === "string" && search.redirectTo.length > 0 ? search.redirectTo : undefined,
  }),
  component: LoginRouteView,
});

export const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    session_id: typeof search.session_id === "string" && search.session_id.length > 0 ? search.session_id : undefined,
  }),
  component: DashboardRouteView,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountRouteView,
});

const workspaceLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspace",
  component: WorkspaceLayoutRouteView,
});

const workspaceIndexRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/",
  component: WorkspaceRouteView,
});

export const workspaceEditorRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "editor/$fileId",
  component: EditorRouteView,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  dashboardRoute,
  accountRoute,
  workspaceLayoutRoute.addChildren([
    workspaceIndexRoute,
    workspaceEditorRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export type AppRouter = typeof router;
registerRouter(router);
export default router;
