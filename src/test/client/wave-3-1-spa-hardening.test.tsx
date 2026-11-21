// @vitest-environment jsdom
/**
 * Wave 3.1 Edge-Case & Integration Test Suite: SPA Routing, Search Params & Guard Hardening
 * (`src/test/client/wave-3-1-spa-hardening.test.tsx`)
 *
 * Covers Wave 3.1 production changes without overlapping Wave 3.2-owned suites:
 * 1. `router.tsx`: `rootRoute.notFoundComponent` rendering & Home recovery link,
 *    plus `HomePage` hash anchor vs TanStack route link handling inside `RouterProvider`.
 * 2. `LoginRouteView` & `LoginPage`: defensive `useSearch({ strict: false })` + `window.location.search`
 *    fallback, prop precedence, and direct `<Button type="button">` Google sign-in error/concurrency handling.
 * 3. `DashboardRouteView`, `DashboardPage` & `AccountPage`: defensive `useSearch` + fallback,
 *    non-string `session_id` rejection, and exclusive Hono RPC `signOut()` resilience.
 * 4. `WorkspacePage`: dual `<Button type="button">` document creation, error/dismiss & concurrency guard,
 *    and `<Link to=...>` target hrefs.
 * 5. `EditorPage`: SSR guard removal — `localStorage` direction pref sanitization (`test.each`)
 *    and `handleReturnToWorkspace` 400ms conditional fallback.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";

const {
    mockGetUser,
    mockSupabaseSignOut,
    mockUseEditorOrchestrator,
} = vi.hoisted(() => ({
    mockGetUser: vi.fn(),
    mockSupabaseSignOut: vi.fn(),
    mockUseEditorOrchestrator: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
    createClient: () => ({
        auth: {
            getUser: () => mockGetUser(),
            signOut: () => mockSupabaseSignOut(),
        },
    }),
}));

vi.mock("@/hooks/use-editor-orchestrator", () => ({
    useEditorOrchestrator: (...args: unknown[]) => mockUseEditorOrchestrator(...args),
}));

vi.mock("@/components/editor/markdown", () => ({
    MarkdownEditor: ({ dir, lockCodeBlocksLTR }: { dir?: string; lockCodeBlocksLTR?: boolean }) => (
        <div
            data-testid="mock-markdown-editor"
            data-dir={dir}
            data-lock-code={String(lockCodeBlocksLTR)}
        />
    ),
}));

vi.mock("@/components/editor/ai-toolbar", () => ({
    AIToolbar: () => <div data-testid="mock-ai-toolbar" />,
}));

vi.mock("@/components/editor/search-replace", () => ({
    SearchReplace: () => null,
}));

vi.mock("@/components/agent/chat-panel", () => ({
    AgentChatPanel: () => null,
}));

vi.mock("@/components/sync/sync-indicator", () => ({
    SyncIndicator: () => null,
}));

vi.mock("@/components/editor/ai-stream-status", () => ({
    AIStreamStatus: () => null,
}));

vi.mock("@/components/export/export-warning-modal", () => ({
    ExportWarningModal: () => null,
}));

vi.mock("@/components/sync/conflict-dialog", () => ({
    ConflictDialog: () => null,
}));

vi.mock("@/components/vault", () => ({
    VaultSecurityCard: ({ userId }: { userId: string }) => (
        <div data-testid="mock-vault-security-card" data-user-id={userId} />
    ),
    VaultUnlockModal: () => null,
}));

vi.mock("@/components/layout/ocr-settings-card", () => ({
    OcrSettingsCard: () => <div data-testid="mock-ocr-settings-card" />,
}));

vi.mock("@/components/layout/sidebar", () => ({
    Sidebar: ({ userId }: { userId?: string }) => (
        <aside data-testid="mock-sidebar" data-user-id={userId} />
    ),
}));

import { router } from "@/client/router";
import { registerRouter, type RouterNavigator } from "@/client/navigation";
import { setRpcClientFetch } from "@/client/rpc-client";
import { clearLocalClientUserId, persistLocalClientUserId } from "@/lib/auth/client-identity";
import { LoginRouteView } from "@/client/routes/login-page";
import DashboardPage, { DashboardRouteView } from "@/client/routes/dashboard-page";
import AccountPage from "@/client/routes/account-page";
import WorkspaceLayoutRouteView from "@/client/routes/workspace-layout";
import WorkspacePage from "@/client/routes/workspace-page";
import EditorPage from "@/client/routes/editor-page";

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function createSpyNavigator(): RouterNavigator & { navigate: ReturnType<typeof vi.fn> } {
    return {
        navigate: vi.fn().mockResolvedValue(undefined),
    };
}

function setupDefaultOrchestrator(overrides: Record<string, unknown> = {}) {
    mockUseEditorOrchestrator.mockReturnValue({
        title: "Spec Doc",
        hydration: "ready",
        aiStatus: "idle",
        aiError: null,
        agentGraphStage: "idle",
        activeQuestionQueue: [],
        masterDecisionLedger: [],
        activeGhostHunks: [],
        activeGhostHunksCount: 0,
        startAgentSession: vi.fn(),
        resumeAgentInterrupt: vi.fn(),
        stopAIOperation: vi.fn(),
        resetAI: vi.fn(),
        acceptGhostHunk: vi.fn(),
        rejectGhostHunk: vi.fn(),
        acceptAllGhostHunks: vi.fn(),
        rejectAllGhostHunks: vi.fn(),
        isCommitting: false,
        isAIActive: false,
        isAIConflict: false,
        isSaving: false,
        lastSaved: new Date(),
        error: null,
        setError: vi.fn(),
        activeConflict: null,
        isConflictDialogOpen: false,
        setIsConflictDialogOpen: vi.fn(),
        isResolvingConflict: false,
        handleResolveConflict: vi.fn(),
        syncHook: {
            status: "synced",
            connectionState: "online",
            pendingCount: 0,
            lastSyncResult: null,
            sync: vi.fn(),
        },
        handleEditorChange: vi.fn(),
        isEncrypted: false,
        allowAIOnEncryptedFiles: false,
        isVaultLocked: false,
        isUnlockModalOpen: false,
        setIsUnlockModalOpen: vi.fn(),
        handleVaultUnlocked: vi.fn(),
        ...overrides,
    });
}

describe("Wave 3.1 SPA Hardening & Edge Cases", () => {
    const originalLocation = window.location;

    beforeEach(() => {
        vi.clearAllMocks();
        registerRouter(null);
        setRpcClientFetch(undefined);
        clearLocalClientUserId();
        window.localStorage.clear();
        mockGetUser.mockResolvedValue({ data: { user: null } });
        mockSupabaseSignOut.mockResolvedValue({ error: null });
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        registerRouter(null);
        setRpcClientFetch(undefined);
        clearLocalClientUserId();
        window.localStorage.clear();
        Object.defineProperty(window, "location", {
            configurable: true,
            writable: true,
            value: originalLocation,
        });
        vi.restoreAllMocks();
    });

    describe("1. Router notFoundComponent & HomePage link handling", () => {
        it("renders notFoundComponent for unknown paths and recovers to HomePage on click", async () => {
            const memoryRouter = createRouter({
                routeTree: router.routeTree,
                history: createMemoryHistory({ initialEntries: ["/does-not-exist"] }),
            });

            render(<RouterProvider router={memoryRouter} />);

            await waitFor(() => {
                expect(screen.getByText("Page Not Found")).toBeTruthy();
            });
            expect(
                screen.getByText("The requested page does not exist or has been moved.")
            ).toBeTruthy();

            const homeLink = screen.getByRole("link", { name: /return to home/i });
            expect(homeLink.getAttribute("href")).toBe("/");

            fireEvent.click(homeLink);

            await waitFor(() => {
                expect(screen.getByText(/Transform Your Writing with/i)).toBeTruthy();
            });

            const featuresLink = screen.getByRole("link", { name: "Features" });
            expect(featuresLink.getAttribute("href")).toBe("#features");
            const loginLinks = screen.getAllByRole("link", { name: /sign in/i });
            expect(loginLinks[0].getAttribute("href")).toBe("/login");
        });
    });

    describe("2. LoginRouteView defensive search resolution & Google button behavior", () => {
        it("resolves redirectTo from TanStack useSearch inside RouterProvider and sends it in RPC payload", async () => {
            const capturedBodies: unknown[] = [];
            const mockFetch: typeof fetch = vi.fn(async (_input, init) => {
                capturedBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
                return jsonResponse({ success: false, error: "OAuth disabled in test" }, 400);
            });
            setRpcClientFetch(mockFetch);

            const memoryRouter = createRouter({
                routeTree: router.routeTree,
                history: createMemoryHistory({
                    initialEntries: ["/login?redirectTo=%2Fworkspace"],
                }),
            });

            render(<RouterProvider router={memoryRouter} />);

            const googleBtn = await screen.findByRole("button", { name: /continue with google/i });
            expect(googleBtn.getAttribute("type")).toBe("button");
            fireEvent.click(googleBtn);

            await waitFor(() => {
                expect(screen.getByText("OAuth disabled in test")).toBeTruthy();
            });
            expect(capturedBodies[0]).toEqual({ redirectTo: "/workspace" });
        });

        it("falls back to window.location.search when LoginRouteView renders outside RouterProvider", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: {
                    ...originalLocation,
                    search: "?redirectTo=%2Faccount",
                },
            });

            render(<LoginRouteView />);

            await waitFor(() => {
                expect(spyNav.navigate).toHaveBeenCalledWith({
                    to: "/account",
                    replace: undefined,
                });
            });
        });

        it("prefers direct redirectTo prop over searchParams and window.location.search", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: {
                    ...originalLocation,
                    search: "?redirectTo=%2Faccount",
                },
            });

            render(
                <LoginRouteView
                    redirectTo="/workspace"
                    searchParams={{ redirectTo: "/dashboard" }}
                />
            );

            await waitFor(() => {
                expect(spyNav.navigate).toHaveBeenCalledWith({
                    to: "/workspace",
                    replace: undefined,
                });
            });
        });

        it("displays network error message and blocks duplicate concurrent clicks during sign-in", async () => {
            let rejectFirstCall!: (reason?: unknown) => void;
            const pendingPromise = new Promise<Response>((_resolve, reject) => {
                rejectFirstCall = reject;
            });
            const mockFetch = vi.fn(() => pendingPromise);
            setRpcClientFetch(mockFetch as unknown as typeof fetch);

            render(<LoginRouteView />);

            const googleBtn = screen.getByRole("button", {
                name: /continue with google/i,
            }) as HTMLButtonElement;

            fireEvent.click(googleBtn);
            await waitFor(() => {
                expect(googleBtn.disabled).toBe(true);
            });
            fireEvent.click(googleBtn);
            expect(mockFetch).toHaveBeenCalledTimes(1);

            rejectFirstCall(new Error("Connection dropped"));

            await waitFor(() => {
                expect(screen.getByText("Connection dropped")).toBeTruthy();
                expect(googleBtn.disabled).toBe(false);
            });
        });
    });

    describe("3. DashboardRouteView search fallback & exclusive Hono RPC signOut", () => {
        function mockAuthenticatedRpc(options: { signOutFails?: boolean } = {}) {
            const rpcCalls: string[] = [];
            const mockFetch: typeof fetch = vi.fn(async (input) => {
                const url = typeof input === "string" ? input : (input as Request).url;
                rpcCalls.push(url);
                if (url.includes("/api/rpc/auth/profile")) {
                    return jsonResponse({
                        success: true,
                        data: { displayName: "Ada", email: "ada@example.com", tier: "pro" },
                    });
                }
                if (url.includes("/api/rpc/billing/credit-balance")) {
                    return jsonResponse({
                        success: true,
                        balanceMicro: "500000000",
                    });
                }
                if (url.includes("/api/rpc/auth/sign-out")) {
                    if (options.signOutFails) {
                        return jsonResponse({ error: "Server unavailable" }, 500);
                    }
                    return jsonResponse({ success: true, redirectUrl: "/" });
                }
                return jsonResponse({ success: true });
            });
            setRpcClientFetch(mockFetch);
            return rpcCalls;
        }

        it("reads session_id via TanStack useSearch inside RouterProvider", async () => {
            mockGetUser.mockResolvedValue({ data: { user: { id: "user-dash-1" } } });
            mockAuthenticatedRpc();

            const memoryRouter = createRouter({
                routeTree: router.routeTree,
                history: createMemoryHistory({
                    initialEntries: ["/dashboard?session_id=cs_router_session"],
                }),
            });

            render(<RouterProvider router={memoryRouter} />);

            await waitFor(() => {
                expect(screen.getByText("Payment Successful!")).toBeTruthy();
            });
        });

        it("falls back to window.location.search for session_id outside RouterProvider", async () => {
            mockGetUser.mockResolvedValue({ data: { user: { id: "user-dash-2" } } });
            mockAuthenticatedRpc();

            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: {
                    ...originalLocation,
                    search: "?session_id=cs_fallback_session",
                },
            });

            render(<DashboardRouteView />);

            await waitFor(() => {
                expect(screen.getByText("Payment Successful!")).toBeTruthy();
            });
        });

        it("ignores non-string or empty session_id values", async () => {
            mockGetUser.mockResolvedValue({ data: { user: { id: "user-dash-3" } } });
            mockAuthenticatedRpc();

            const memoryRouter = createRouter({
                routeTree: router.routeTree,
                history: createMemoryHistory({
                    initialEntries: ["/dashboard?session_id="],
                }),
            });

            render(<RouterProvider router={memoryRouter} />);

            await waitFor(() => {
                expect(screen.getByText(/Welcome back, Ada/i)).toBeTruthy();
            });
            expect(screen.queryByText("Payment Successful!")).toBeNull();
        });

        it.each([
            ["DashboardPage succeeds", false, "dashboard"],
            ["DashboardPage recovers on RPC error", true, "dashboard"],
            ["AccountPage succeeds", false, "account"],
            ["AccountPage recovers on RPC error", true, "account"],
        ] as const)(
            "calls Hono RPC signOut exclusively without supabase.auth.signOut when %s",
            async (_label, signOutFails, pageType) => {
                const spyNav = createSpyNavigator();
                registerRouter(spyNav);
                mockGetUser.mockResolvedValue({ data: { user: { id: "user-signout" } } });
                const rpcCalls = mockAuthenticatedRpc({ signOutFails });

                const { container } = render(
                    pageType === "dashboard" ? <DashboardPage /> : <AccountPage />
                );

                await waitFor(() => {
                    expect(
                        pageType === "dashboard"
                            ? screen.getByText(/Welcome back, Ada/i)
                            : screen.getByText("Account Settings")
                    ).toBeTruthy();
                });

                const signOutButton =
                    pageType === "account"
                        ? screen.getByRole("button", { name: /sign out/i })
                        : container.querySelector("svg.lucide-log-out")!.closest("button")!;

                expect(signOutButton.getAttribute("type")).toBe("button");
                fireEvent.click(signOutButton);

                await waitFor(() => {
                    expect(spyNav.navigate).toHaveBeenCalledWith({
                        to: "/",
                        replace: undefined,
                    });
                });

                expect(rpcCalls.some((u) => u.includes("/api/rpc/auth/sign-out"))).toBe(true);
                expect(mockSupabaseSignOut).not.toHaveBeenCalled();
            }
        );
    });

    describe("4. WorkspacePage direct button creation, error recovery & links", () => {
        it("renders file/folder links with correct hrefs and handles New Document creation error & dismiss", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            mockGetUser.mockResolvedValue({ data: { user: { id: "user-ws-1" } } });

            const mockFetch: typeof fetch = vi.fn(async (input) => {
                const url = typeof input === "string" ? input : (input as Request).url;
                if (url.includes("/api/rpc/files/list-root")) {
                    return jsonResponse({
                        success: true,
                        data: [
                            { id: "doc-42", title: "Draft.md", isFolder: false },
                            { id: "dir-7", title: "Notes", isFolder: true },
                        ],
                    });
                }
                if (url.includes("/api/rpc/files/create")) {
                    return jsonResponse({ success: false, error: "Storage limit reached" }, 400);
                }
                return jsonResponse({ success: true });
            });
            setRpcClientFetch(mockFetch);

            render(<WorkspacePage />);

            await waitFor(() => {
                expect(screen.getByText("Draft.md")).toBeTruthy();
            });

            expect(screen.getByText("Draft.md").closest("a")?.getAttribute("href")).toBe(
                "/workspace/editor/doc-42"
            );
            expect(screen.getByText("Notes").closest("a")?.getAttribute("href")).toBe(
                "/workspace?folderId=dir-7"
            );

            const newDocBtn = screen.getByRole("button", { name: /new document/i });
            expect(newDocBtn.getAttribute("type")).toBe("button");
            fireEvent.click(newDocBtn);

            await waitFor(() => {
                expect(screen.getByText("Storage limit reached")).toBeTruthy();
            });

            fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
            expect(screen.queryByText("Storage limit reached")).toBeNull();
        });

        it("blocks duplicate concurrent Create Document submissions in empty state", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            mockGetUser.mockResolvedValue({ data: { user: { id: "user-ws-2" } } });

            let resolveCreate!: (res: Response) => void;
            const createPromise = new Promise<Response>((resolve) => {
                resolveCreate = resolve;
            });
            let createCallCount = 0;

            const mockFetch: typeof fetch = vi.fn(async (input) => {
                const url = typeof input === "string" ? input : (input as Request).url;
                if (url.includes("/api/rpc/files/list-root")) {
                    return jsonResponse({ success: true, data: [] });
                }
                if (url.includes("/api/rpc/files/create")) {
                    createCallCount += 1;
                    return createPromise;
                }
                return jsonResponse({ success: true });
            });
            setRpcClientFetch(mockFetch);

            render(<WorkspacePage />);

            const createBtn = (await screen.findByRole("button", {
                name: /create document/i,
            })) as HTMLButtonElement;
            expect(createBtn.getAttribute("type")).toBe("button");

            fireEvent.click(createBtn);
            await waitFor(() => {
                expect(createBtn.disabled).toBe(true);
            });
            fireEvent.click(createBtn);
            expect(createCallCount).toBe(1);

            resolveCreate(jsonResponse({ success: true, data: { id: "created-99" } }));

            await waitFor(() => {
                expect(spyNav.navigate).toHaveBeenCalledWith({
                    to: "/workspace/editor/created-99",
                    replace: undefined,
                });
            });
        });
    });

    describe("5. EditorPage SSR guard removal & resilient fallbacks", () => {
        it.each([
            [
                "valid rtl and unlocked code blocks",
                JSON.stringify({ mode: "rtl", lockCodeBlocksLTR: false }),
                "rtl",
                "false",
            ],
            ["corrupted JSON falls back to defaults", "{not-valid-json", "auto", "true"],
            [
                "invalid mode and non-boolean lock fall back to defaults",
                JSON.stringify({ mode: "diagonal", lockCodeBlocksLTR: "yes" }),
                "auto",
                "true",
            ],
        ])("sanitizes directionSettings from localStorage (%s)", (_label, rawPref, expectedDir, expectedLock) => {
            setupDefaultOrchestrator();
            window.localStorage.setItem("editor_direction_pref", rawPref);

            render(<EditorPage />);

            const editor = screen.getByTestId("mock-markdown-editor");
            expect(editor.getAttribute("data-dir")).toBe(expectedDir);
            expect(editor.getAttribute("data-lock-code")).toBe(expectedLock);
        });

        it("falls back to default directionSettings when localStorage.getItem throws", () => {
            setupDefaultOrchestrator();
            vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
                throw new Error("SecurityError: storage denied");
            });

            render(<EditorPage />);

            const editor = screen.getByTestId("mock-markdown-editor");
            expect(editor.getAttribute("data-dir")).toBe("auto");
            expect(editor.getAttribute("data-lock-code")).toBe("true");
        });

        it("triggers window.location.assign('/workspace') after 400ms only if still on editor pathname", () => {
            vi.useFakeTimers();
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            setupDefaultOrchestrator({ hydration: "fatal" });

            const assignSpy = vi.fn();
            const locationStub = {
                ...originalLocation,
                pathname: "/workspace/editor/file-stuck",
                assign: assignSpy,
            };
            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: locationStub,
            });

            render(<EditorPage />);

            fireEvent.click(screen.getByRole("button", { name: /return to workspace/i }));
            expect(spyNav.navigate).toHaveBeenCalledWith({
                to: "/workspace",
                replace: undefined,
            });
            expect(assignSpy).not.toHaveBeenCalled();

            vi.advanceTimersByTime(400);
            expect(assignSpy).toHaveBeenCalledWith("/workspace");

            // Now verify no fallback assign occurs if pathname already transitioned
            assignSpy.mockClear();
            locationStub.pathname = "/workspace";
            fireEvent.click(screen.getByRole("button", { name: /return to workspace/i }));
            vi.advanceTimersByTime(400);
            expect(assignSpy).not.toHaveBeenCalled();
        });
    });

    describe("6. WorkspaceLayoutRouteView & EditorPage offline-first auth & redirectTo", () => {
        const originalOnLineDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");

        function renderWorkspaceLayoutInRouter() {
            const root = createRootRoute({
                component: WorkspaceLayoutRouteView,
            });
            const index = createRoute({
                getParentRoute: () => root,
                path: "/",
                component: () => <div data-testid="mock-workspace-child">Child</div>,
            });
            const testRouter = createRouter({
                routeTree: root.addChildren([index]),
                history: createMemoryHistory({ initialEntries: ["/"] }),
            });
            return render(<RouterProvider router={testRouter} />);
        }

        afterEach(() => {
            if (originalOnLineDescriptor) {
                Object.defineProperty(Navigator.prototype, "onLine", originalOnLineDescriptor);
            }
        });

        it("preserves redirectTo on WorkspaceLayoutRouteView when session is explicitly expired", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: {
                    ...originalLocation,
                    pathname: "/workspace/editor/doc-77",
                    search: "?view=split",
                },
            });
            mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

            renderWorkspaceLayoutInRouter();

            await waitFor(() => {
                expect(spyNav.navigate).toHaveBeenCalledWith({
                    to: "/login?redirectTo=%2Fworkspace%2Feditor%2Fdoc-77%3Fview%3Dsplit",
                    replace: undefined,
                });
            });
        });

        it("does NOT redirect to /login on transient network error and keeps workspace usable", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: {
                    ...originalLocation,
                    pathname: "/workspace",
                    search: "",
                },
            });
            mockGetUser.mockRejectedValue(new Error("Failed to fetch"));

            renderWorkspaceLayoutInRouter();

            await waitFor(() => {
                expect(screen.getByTestId("mock-sidebar")).toBeTruthy();
            });
            expect(spyNav.navigate).not.toHaveBeenCalled();
        });

        it("re-verifies offline session on window online event and redirects with redirectTo if server rejects", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            persistLocalClientUserId("offline-user-1");

            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: {
                    ...originalLocation,
                    pathname: "/workspace/editor/doc-offline",
                    search: "",
                },
            });

            let isOnline = false;
            Object.defineProperty(Navigator.prototype, "onLine", {
                configurable: true,
                get: () => isOnline,
            });

            mockGetUser.mockResolvedValue({
                data: { user: null },
                error: { status: 401, message: "Unauthorized", code: "session_expired" },
            });

            renderWorkspaceLayoutInRouter();

            await waitFor(() => {
                expect(screen.getByTestId("mock-sidebar").getAttribute("data-user-id")).toBe("offline-user-1");
            });
            expect(mockGetUser).not.toHaveBeenCalled();

            isOnline = true;
            window.dispatchEvent(new Event("online"));

            await waitFor(() => {
                expect(spyNav.navigate).toHaveBeenCalledWith({
                    to: "/login?redirectTo=%2Fworkspace%2Feditor%2Fdoc-offline",
                    replace: undefined,
                });
            });
        });

        it("preserves redirectTo on EditorPage when onSessionExpired fires", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            setupDefaultOrchestrator();
            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: {
                    ...originalLocation,
                    pathname: "/workspace/editor/file-99",
                    search: "",
                },
            });
            mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

            render(<EditorPage />);

            await waitFor(() => {
                expect(spyNav.navigate).toHaveBeenCalledWith({
                    to: "/login?redirectTo=%2Fworkspace%2Feditor%2Ffile-99",
                    replace: undefined,
                });
            });
        });

        it("removes window online listener and aborts verification when WorkspaceLayoutRouteView unmounts", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            persistLocalClientUserId("unmount-user-1");

            let isOnline = false;
            Object.defineProperty(Navigator.prototype, "onLine", {
                configurable: true,
                get: () => isOnline,
            });
            mockGetUser.mockResolvedValue({
                data: { user: null },
                error: { status: 401, message: "Unauthorized" },
            });

            const { unmount } = renderWorkspaceLayoutInRouter();

            await waitFor(() => {
                expect(screen.getByTestId("mock-sidebar").getAttribute("data-user-id")).toBe("unmount-user-1");
            });

            unmount();

            // Connectivity returns AFTER unmount -> listener MUST be cleaned up
            isOnline = true;
            window.dispatchEvent(new Event("online"));
            await new Promise((resolve) => setTimeout(resolve, 25));

            expect(mockGetUser).not.toHaveBeenCalled();
            expect(spyNav.navigate).not.toHaveBeenCalled();
        });

        it("keeps user in workspace on window online re-verification when server returns valid user or transient AbortError", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            persistLocalClientUserId("offline-user-keep");

            let isOnline = false;
            Object.defineProperty(Navigator.prototype, "onLine", {
                configurable: true,
                get: () => isOnline,
            });

            renderWorkspaceLayoutInRouter();
            await waitFor(() => {
                expect(screen.getByTestId("mock-sidebar").getAttribute("data-user-id")).toBe("offline-user-keep");
            });

            // 1. Transient AbortError on reconnect must NOT evict or redirect
            mockGetUser.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
            isOnline = true;
            window.dispatchEvent(new Event("online"));
            await waitFor(() => expect(mockGetUser).toHaveBeenCalledTimes(1));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(spyNav.navigate).not.toHaveBeenCalled();
            expect(window.localStorage.getItem("elixent_uid")).toBe("offline-user-keep");

            // 2. Valid user response on reconnect keeps workspace active
            mockGetUser.mockResolvedValueOnce({
                data: { user: { id: "offline-user-keep" } },
                error: null,
            });
            window.dispatchEvent(new Event("online"));
            await waitFor(() => expect(mockGetUser).toHaveBeenCalledTimes(2));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(spyNav.navigate).not.toHaveBeenCalled();
        });

        it("does NOT redirect EditorPage when offline, on transient AbortError, or after unmount", async () => {
            const spyNav = createSpyNavigator();
            registerRouter(spyNav);
            setupDefaultOrchestrator();
            persistLocalClientUserId("editor-offline-user");

            // 1. Offline mount skips network and never redirects
            let isOnline = false;
            Object.defineProperty(Navigator.prototype, "onLine", {
                configurable: true,
                get: () => isOnline,
            });

            const first = render(<EditorPage />);
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(mockGetUser).not.toHaveBeenCalled();
            expect(spyNav.navigate).not.toHaveBeenCalled();
            first.unmount();

            // 2. Online transient AbortError does not evict or redirect
            isOnline = true;
            mockGetUser.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
            const second = render(<EditorPage />);
            await waitFor(() => expect(mockGetUser).toHaveBeenCalledTimes(1));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(spyNav.navigate).not.toHaveBeenCalled();
            expect(window.localStorage.getItem("elixent_uid")).toBe("editor-offline-user");
            second.unmount();

            // 3. Unmount aborts in-flight cold-start auth check before 401/null triggers navigate
            window.localStorage.clear();
            document.cookie = "elixent_uid=; Path=/; Max-Age=0";
            let resolveInFlight!: (val: unknown) => void;
            mockGetUser.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveInFlight = resolve;
                    })
            );
            const third = render(<EditorPage />);
            await waitFor(() => expect(mockGetUser).toHaveBeenCalledTimes(2));
            third.unmount();
            resolveInFlight({ data: { user: null }, error: null });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(spyNav.navigate).not.toHaveBeenCalled();
        });
    });
});
