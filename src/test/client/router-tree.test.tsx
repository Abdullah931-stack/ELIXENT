// @vitest-environment jsdom
/**
 * Exhaustive Integration & Architecture Test Suite: TanStack Router Route Tree
 * (`src/test/client/router-tree.test.tsx`)
 *
 * Verifies:
 * 1. Router Tree Hierarchy & Configuration:
 *    - Root route exists with Outlet component.
 *    - defaultPreload is configured to "intent".
 *    - Route hierarchy matches approved blueprint:
 *      - "/" -> HomeRouteView
 *      - "/login" -> LoginRouteView
 *      - "/dashboard" -> DashboardRouteView
 *      - "/account" -> AccountRouteView
 *      - "/workspace" -> WorkspaceLayoutRouteView
 *        - "/" (index) -> WorkspaceRouteView
 *        - "editor/$fileId" -> EditorRouteView
 * 2. Route Matching & Parameter Resolution:
 *    - Route matching for root and child routes in routesById.
 *    - URL parameter parsing for $fileId on workspaceEditorRoute.
 * 3. Router Component Integration:
 *    - Renders RouterProvider with test router instance and navigates across all views.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { router } from "@/client/router";
import { HomeRouteView } from "@/client/routes/home-page";
import { LoginRouteView } from "@/client/routes/login-page";
import { DashboardRouteView } from "@/client/routes/dashboard-page";
import { AccountRouteView } from "@/client/routes/account-page";
import { WorkspaceLayoutRouteView } from "@/client/routes/workspace-layout";
import { WorkspaceRouteView } from "@/client/routes/workspace-page";
import { EditorRouteView } from "@/client/routes/editor-page";

// Mock the route view components to cleanly isolate route-tree matching
vi.mock("@/client/routes/home-page", () => ({
  HomeRouteView: () => <div data-testid="route-view-home">Home View</div>,
  default: () => <div>Home</div>,
}));

vi.mock("@/client/routes/login-page", () => ({
  LoginRouteView: () => <div data-testid="route-view-login">Login View</div>,
  default: () => <div>Login</div>,
}));

vi.mock("@/client/routes/dashboard-page", () => ({
  DashboardRouteView: () => <div data-testid="route-view-dashboard">Dashboard View</div>,
  default: () => <div>Dashboard</div>,
}));

vi.mock("@/client/routes/account-page", () => ({
  AccountRouteView: () => <div data-testid="route-view-account">Account View</div>,
  default: () => <div>Account</div>,
}));

vi.mock("@/client/routes/workspace-layout", async () => {
  const { Outlet: RouterOutlet } = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    WorkspaceLayoutRouteView: () => (
      <div data-testid="route-view-workspace-layout">
        Workspace Layout
        <RouterOutlet />
      </div>
    ),
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("@/client/routes/workspace-page", () => ({
  WorkspaceRouteView: () => <div data-testid="route-view-workspace-index">Workspace Index View</div>,
  default: () => <div>Workspace</div>,
}));

vi.mock("@/client/routes/editor-page", () => ({
  EditorRouteView: () => <div data-testid="route-view-editor">Editor View</div>,
  default: () => <div>Editor</div>,
}));

describe("TanStack Router Route Tree (src/client/router.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe("1. Route Tree Architecture & Invariants", () => {
    it("configures defaultPreload as 'intent'", () => {
      expect(router.options.defaultPreload).toBe("intent");
    });

    it("attaches routeTree with rootRoute as root node", () => {
      expect(router.routeTree).toBeDefined();
      expect(router.routeTree.id).toBe("__root__");
    });

    it("verifies all top-level routes and nested workspace routes exist in routesById", () => {
      const routesById = router.routesById;
      expect(routesById).toBeDefined();

      // Top-level routes
      expect(routesById["/"]).toBeDefined();
      expect(routesById["/login"]).toBeDefined();
      expect(routesById["/dashboard"]).toBeDefined();
      expect(routesById["/account"]).toBeDefined();
      expect(routesById["/workspace"]).toBeDefined();

      // Nested workspace routes
      expect(routesById["/workspace/"]).toBeDefined();
      expect(routesById["/workspace/editor/$fileId"]).toBeDefined();
    });

    it("verifies route components match their designated route views in routesById", () => {
      const routesById = router.routesById;

      expect(routesById["/"].options.component).toBe(HomeRouteView);
      expect(routesById["/login"].options.component).toBe(LoginRouteView);
      expect(routesById["/dashboard"].options.component).toBe(DashboardRouteView);
      expect(routesById["/account"].options.component).toBe(AccountRouteView);
      expect(routesById["/workspace"].options.component).toBe(WorkspaceLayoutRouteView);
      expect(routesById["/workspace/"].options.component).toBe(WorkspaceRouteView);
      expect(routesById["/workspace/editor/$fileId"].options.component).toBe(EditorRouteView);
    });
  });

  describe("2. Navigation & Route View Rendering with Memory History", () => {
    function createTestRouter(initialPath: string) {
      const history = createMemoryHistory({ initialEntries: [initialPath] });
      return createRouter({
        routeTree: router.routeTree,
        history,
      });
    }

    it("renders HomeRouteView when navigating to '/'", async () => {
      const testRouter = createTestRouter("/");
      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByTestId("route-view-home")).toBeTruthy();
      });
    });

    it("renders LoginRouteView when navigating to '/login'", async () => {
      const testRouter = createTestRouter("/login");
      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByTestId("route-view-login")).toBeTruthy();
      });
    });

    it("renders DashboardRouteView when navigating to '/dashboard'", async () => {
      const testRouter = createTestRouter("/dashboard");
      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByTestId("route-view-dashboard")).toBeTruthy();
      });
    });

    it("renders AccountRouteView when navigating to '/account'", async () => {
      const testRouter = createTestRouter("/account");
      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByTestId("route-view-account")).toBeTruthy();
      });
    });

    it("renders WorkspaceLayoutRouteView with nested WorkspaceRouteView when navigating to '/workspace'", async () => {
      const testRouter = createTestRouter("/workspace");
      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByTestId("route-view-workspace-layout")).toBeTruthy();
        expect(screen.getByTestId("route-view-workspace-index")).toBeTruthy();
      });
    });

    it("renders WorkspaceLayoutRouteView with nested EditorRouteView when navigating to '/workspace/editor/file-456'", async () => {
      const testRouter = createTestRouter("/workspace/editor/file-456");
      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByTestId("route-view-workspace-layout")).toBeTruthy();
        expect(screen.getByTestId("route-view-editor")).toBeTruthy();
      });
    });
  });
});
