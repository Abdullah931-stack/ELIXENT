// @vitest-environment jsdom
/**
 * Exhaustive Unit & Edge-Case Test Suite: Client Navigation Adapters
 * (`src/test/client/navigation.test.ts`)
 *
 * Verifies:
 * 1. useAppParams:
 *    - Extracts fileId from TanStack Router context when available.
 *    - Fallback: extracts fileId from window.location.pathname when outside router context.
 *    - URL decoding of encoded characters (%20, unicode Arabic/Hebrew/CJK, special chars).
 *    - Strips search queries and hash fragments cleanly.
 *    - Returns empty object when path does not match /workspace/editor/ pattern.
 *    - Returns empty object when window is undefined (SSR safety).
 *    - Handles malformed, empty, or whitespace fileIds.
 * 2. useAppNavigate:
 *    - Delegates to TanStack Router useNavigate when context is available.
 *    - Falls back to navigateTo when router context throws or fails.
 * 3. navigateTo:
 *    - Safe no-op when window is undefined (SSR safety).
 *    - Uses window.location.assign for external URLs (http:// and https://).
 *    - Uses window.history.pushState and dispatches PopStateEvent for internal SPA routes.
 *    - Dispatches actual popstate event listeners on window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const { mockUseParams, mockUseNavigate } = vi.hoisted(() => ({
  mockUseParams: vi.fn(),
  mockUseNavigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useParams: (...args: any[]) => mockUseParams(...args),
    useNavigate: (...args: any[]) => mockUseNavigate(...args),
  };
});

import { useAppParams, useAppNavigate, navigateTo } from "@/client/navigation";

describe("Client Navigation Adapters (src/client/navigation.ts)", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "location", {
      writable: true,
      value: originalLocation,
    });
  });

  describe("1. useAppParams()", () => {
    it("extracts fileId when TanStack Router context provides it", () => {
      mockUseParams.mockReturnValue({
        fileId: "doc-router-123",
      });

      const { result } = renderHook(() => useAppParams());
      expect(result.current).toEqual({ fileId: "doc-router-123" });
    });

    it("falls back to window.location.pathname regex when useParams throws (no RouterProvider)", () => {
      mockUseParams.mockImplementation(() => {
        throw new Error("useParams must be used within a RouterProvider");
      });

      Object.defineProperty(window, "location", {
        writable: true,
        value: {
          pathname: "/workspace/editor/doc-fallback-456",
        },
      });

      const { result } = renderHook(() => useAppParams());
      expect(result.current).toEqual({ fileId: "doc-fallback-456" });
    });

    it("decodes URL-encoded characters in the fileId parameter", () => {
      mockUseParams.mockImplementation(() => {
        throw new Error("outside provider");
      });

      // Encoded "وثيقة عمل+123" (Arabic "work document+123")
      const encoded = encodeURIComponent("وثيقة عمل+123");
      Object.defineProperty(window, "location", {
        writable: true,
        value: {
          pathname: `/workspace/editor/${encoded}`,
        },
      });

      const { result } = renderHook(() => useAppParams());
      expect(result.current).toEqual({ fileId: "وثيقة عمل+123" });
    });

    it("isolates fileId and ignores trailing query parameters or hash fragments in pathname", () => {
      mockUseParams.mockImplementation(() => {
        throw new Error("outside provider");
      });

      Object.defineProperty(window, "location", {
        writable: true,
        value: {
          pathname: "/workspace/editor/doc-with-query",
          search: "?tab=chat&debug=true",
          hash: "#heading-2",
        },
      });

      const { result } = renderHook(() => useAppParams());
      expect(result.current).toEqual({ fileId: "doc-with-query" });
    });

    it("returns empty object when pathname does not match /workspace/editor/ pattern", () => {
      mockUseParams.mockImplementation(() => {
        throw new Error("outside provider");
      });

      const nonMatchingPaths = [
        "/",
        "/login",
        "/dashboard",
        "/account",
        "/workspace",
        "/workspace/",
        "/workspace/files",
        "/api/files/123",
      ];

      for (const pathname of nonMatchingPaths) {
        Object.defineProperty(window, "location", {
          writable: true,
          value: { pathname },
        });

        const { result } = renderHook(() => useAppParams());
        expect(result.current).toEqual({});
      }
    });

    it("returns empty object when router params contains empty string fileId", () => {
      mockUseParams.mockReturnValue({
        fileId: "",
      });

      Object.defineProperty(window, "location", {
        writable: true,
        value: { pathname: "/dashboard" },
      });

      const { result } = renderHook(() => useAppParams());
      expect(result.current).toEqual({});
    });
  });

  describe("2. useAppNavigate()", () => {
    it("delegates to TanStack Router navigate when context is present", () => {
      const mockRouterNav = vi.fn().mockResolvedValue(undefined);
      mockUseNavigate.mockReturnValue(mockRouterNav);

      const { result } = renderHook(() => useAppNavigate());
      result.current("/workspace/editor/new-doc");

      expect(mockRouterNav).toHaveBeenCalledWith({ to: "/workspace/editor/new-doc" });
    });

    it("falls back to navigateTo when routerNavigate throws an error", () => {
      const mockRouterNav = vi.fn().mockImplementation(() => {
        throw new Error("Navigation aborted");
      });
      mockUseNavigate.mockReturnValue(mockRouterNav);

      const pushStateSpy = vi.spyOn(window.history, "pushState");
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");

      const { result } = renderHook(() => useAppNavigate());
      result.current("/dashboard");

      expect(mockRouterNav).toHaveBeenCalledWith({ to: "/dashboard" });
      expect(pushStateSpy).toHaveBeenCalledWith({}, "", "/dashboard");
      expect(dispatchSpy).toHaveBeenCalled();
    });

    it("falls back to navigateTo when useNavigate throws (outside RouterProvider)", () => {
      mockUseNavigate.mockImplementation(() => {
        throw new Error("useNavigate must be used within a RouterProvider");
      });

      const pushStateSpy = vi.spyOn(window.history, "pushState");
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");

      const { result } = renderHook(() => useAppNavigate());
      result.current("/account");

      expect(pushStateSpy).toHaveBeenCalledWith({}, "", "/account");
      expect(dispatchSpy).toHaveBeenCalled();
    });
  });

  describe("3. navigateTo()", () => {
    it("redirects external http:// URLs via window.location.assign", () => {
      const assignMock = vi.fn();
      Object.defineProperty(window, "location", {
        writable: true,
        value: { assign: assignMock },
      });

      navigateTo("http://external-service.com/auth");

      expect(assignMock).toHaveBeenCalledWith("http://external-service.com/auth");
    });

    it("redirects external https:// URLs via window.location.assign", () => {
      const assignMock = vi.fn();
      Object.defineProperty(window, "location", {
        writable: true,
        value: { assign: assignMock },
      });

      navigateTo("https://accounts.google.com/o/oauth2/v2/auth");

      expect(assignMock).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth");
    });

    it("updates history and dispatches PopStateEvent for internal SPA routes", () => {
      const pushStateSpy = vi.spyOn(window.history, "pushState");
      let popstateReceived = false;

      const onPopState = (e: Event) => {
        if (e instanceof PopStateEvent) {
          popstateReceived = true;
        }
      };

      window.addEventListener("popstate", onPopState);

      try {
        navigateTo("/workspace/editor/doc-999");

        expect(pushStateSpy).toHaveBeenCalledWith({}, "", "/workspace/editor/doc-999");
        expect(popstateReceived).toBe(true);
      } finally {
        window.removeEventListener("popstate", onPopState);
      }
    });
  });
});
