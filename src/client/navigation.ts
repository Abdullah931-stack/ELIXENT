import { useParams, useNavigate } from "@tanstack/react-router";

export type RouterNavigator = {
  navigate: (opts: { to: string; replace?: boolean }) => Promise<unknown>;
};

let activeRouter: RouterNavigator | null = null;

/**
 * Registers an active TanStack router instance for imperative navigation outside React components.
 */
export function registerRouter(router: RouterNavigator | null): void {
  activeRouter = router;
}

/**
 * Retrieves the currently registered router instance, if any.
 */
export function getActiveRouter(): RouterNavigator | null {
  return activeRouter;
}

/**
 * Returns parameters from the active route (such as fileId in /workspace/editor/$fileId).
 * Falls back to window.location.pathname regex matching if invoked outside RouterProvider
 * or during isolated unit testing.
 */
export function useAppParams(): { fileId?: string } {
  try {
    const params = useParams({ strict: false }) as Record<string, string | undefined>;
    if (params && typeof params.fileId === "string" && params.fileId.length > 0) {
      return { fileId: params.fileId };
    }
  } catch {
    // Router context is absent (e.g., in unit tests or outside RouterProvider)
  }

  if (typeof window !== "undefined" && window.location?.pathname) {
    const match = window.location.pathname.match(/\/workspace\/editor\/([^/?#]+)/);
    if (match?.[1]) {
      return { fileId: decodeURIComponent(match[1]) };
    }
  }

  return {};
}

/**
 * Hook providing a navigation function compatible with both TanStack Router
 * and standard browser history events.
 */
export function useAppNavigate(): (path: string, options?: { replace?: boolean }) => void {
  let routerNavigate: ((opts: { to: string; replace?: boolean }) => Promise<unknown>) | null = null;
  try {
    routerNavigate = useNavigate();
  } catch {
    // Router context is absent
  }

  return (path: string, options?: { replace?: boolean }) => {
    if (routerNavigate) {
      try {
        void routerNavigate({ to: path, replace: options?.replace });
        return;
      } catch {
        // Fall back to navigateTo if router navigation fails
      }
    }

    navigateTo(path, options);
  };
}

interface WindowWithRouter extends Window {
  __APP_ROUTER__?: RouterNavigator;
}

/**
 * Imperative navigation helper.
 * Integrates cleanly with TanStack Router when active,
 * with standard browser navigation and fallback for external URLs and standalone test environments.
 */
export function navigateTo(path: string, options?: { replace?: boolean }): void {
  if (typeof window === "undefined") {
    return;
  }

  if (path.startsWith("http://") || path.startsWith("https://")) {
    window.location.assign(path);
    return;
  }

  const router =
    activeRouter ??
    (window as unknown as WindowWithRouter).__APP_ROUTER__;
  if (router && typeof router.navigate === "function") {
    void router.navigate({ to: path, replace: options?.replace });
    return;
  }

  if (options?.replace) {
    window.history.replaceState({}, "", path);
  } else {
    window.history.pushState({}, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}
