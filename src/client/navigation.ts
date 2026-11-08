import { useParams, useNavigate } from "@tanstack/react-router";

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
export function useAppNavigate(): (path: string) => void {
  let routerNavigate: ((opts: { to: string }) => Promise<unknown>) | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- intentional defensive fallback when rendered outside RouterProvider
    routerNavigate = useNavigate();
  } catch {
    // Router context is absent
  }

  return (path: string) => {
    if (routerNavigate) {
      try {
        routerNavigate({ to: path });
        return;
      } catch {
        // Fall back to window history if router navigation fails
      }
    }

    navigateTo(path);
  };
}

/**
 * Imperative navigation helper.
 * Uses window.history.pushState and dispatches a popstate event for local SPA navigation,
 * or window.location.assign for external URLs.
 */
export function navigateTo(path: string): void {
  if (typeof window === "undefined") {
    return;
  }

  if (path.startsWith("http://") || path.startsWith("https://")) {
    window.location.assign(path);
    return;
  }

  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
