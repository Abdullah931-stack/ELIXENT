import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";

import { HomeRouteView } from "./routes/home-page";
import { LoginRouteView } from "./routes/login-page";
import { DashboardRouteView } from "./routes/dashboard-page";
import { AccountRouteView } from "./routes/account-page";
import { WorkspaceLayoutRouteView } from "./routes/workspace-layout";
import { WorkspaceRouteView } from "./routes/workspace-page";
import { EditorRouteView } from "./routes/editor-page";

const rootRoute = createRootRoute({
  component: Outlet,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRouteView,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRouteView,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
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

const workspaceEditorRoute = createRoute({
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
export default router;
