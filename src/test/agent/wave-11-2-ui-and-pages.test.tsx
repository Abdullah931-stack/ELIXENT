/**
 * @vitest-environment jsdom
 *
 * Phase 11 — Wave 11.2 Comprehensive Test Suite:
 * 1. AIStreamStatus (`src/components/editor/ai-stream-status.tsx`)
 *    - Ephemeral 8-State Visual Machine (`idle`, `running_graph`, `awaiting_hitl`,
 *      `streaming_hunks`, `preview_ready`, `completed`, `aborted`, `failed`)
 *    - Conflict Precedence, Hunk Pluralization, Action Callback Wiring & Fallbacks
 * 2. DashboardPage (`src/client/routes/dashboard-page.tsx`)
 *    - Server Component Authentication Guard (`redirect('/login')` / `navigateTo('/login')`)
 *    - Micro-Credit Denomination to Display Credits (`MICRO_PER_CREDIT`)
 *    - Free, Pro & Ultra Credit Progress Metering, Badge & Clamping
 *    - Session SearchParam Payment Success Notification & Profile Fallbacks
 * 3. AccountPage (`src/client/routes/account-page.tsx`)
 *    - Server Component Authentication Guard
 *    - Micro-Credit Metered AI Settlement Progress Card
 *    - Dynamic Plan Upgrade Button Matrix (Free -> Pro+Ultra, Pro -> Ultra, Ultra -> None)
 *    - Plan Comparison Synchronization with `TIER_LIMITS[tier].creditsDisplay`
 *    - Profile Avatar & Uppercase Initial Fallback
 * 4. EditorPage Wiring (`src/client/routes/editor-page.tsx`)
 *    - Integration wiring of `useEditorOrchestrator` with `<AIToolbar />`,
 *      `<AIStreamStatus />`, and `<AgentChatPanel />`
 *    - Keyboard Shortcuts (`Escape` stop guard, `Ctrl+F` search toggle)
 *    - Hydration Lifecycle Overlays (`hydrating`, `vault_locked`, `fatal`)
 *    - 412 Conflict Alert Banner & Resolution Dialog Integration
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// ============================================================================
// Navigation & Router Mocks
// ============================================================================

const mockPush = vi.fn();
const mockRedirect = vi.fn();

let mockFileIdParam = "file-arch-test-123";

vi.mock("@tanstack/react-router", () => ({
    Outlet: () => <div data-testid="mock-outlet">Outlet</div>,
    useRouter: () => null,
    Link: ({ children, to, href, ...props }: any) => (
        <a href={to || href || "#"} {...props}>
            {children}
        </a>
    ),
}));

vi.mock("@/client/navigation", () => ({
    useAppParams: () => ({ fileId: mockFileIdParam }),
    useAppNavigate: () => mockPush,
    navigateTo: (path: string) => mockRedirect(path),
}));

const mockGetServerUser = vi.fn();
const mockGetUserProfile = vi.fn();
const mockSignOut = vi.fn();
const mockGetUserCreditBalance = vi.fn();
const mockGetCreditBalanceResult = vi.fn();

const mockGetClientUser = vi.fn(async () => {
    const user = await mockGetServerUser();
    return { data: { user } };
});
vi.mock("@/lib/supabase/client", () => ({
    createClient: () => ({
        auth: {
            getUser: () => mockGetClientUser(),
        },
    }),
}));

vi.mock("@/client/rpc-client", () => ({
    getUserProfile: () => mockGetUserProfile(),
    signOut: () => mockSignOut(),
    getCreditBalance: () => mockGetUserCreditBalance(),
    getCreditBalanceResult: () => mockGetCreditBalanceResult(),
}));

// ============================================================================
// Mocks for Subcomponents used in Dashboard, Account & Editor
// ============================================================================

vi.mock("@/components/subscription/upgrade-button", () => ({
    UpgradeButton: ({ tier, currentTier }: { tier: string; currentTier: string }) => (
        <button data-testid={`upgrade-btn-${tier}`} data-current-tier={currentTier}>
            Upgrade to {tier}
        </button>
    ),
}));

vi.mock("@/components/vault", () => ({
    VaultSecurityCard: ({ userId }: { userId: string }) => (
        <div data-testid="vault-security-card" data-userid={userId}>
            Vault Security Card
        </div>
    ),
    VaultUnlockModal: ({ isOpen, onUnlocked, onClose }: { isOpen: boolean; onUnlocked: (t: string) => void; onClose: () => void }) =>
        isOpen ? (
            <div data-testid="vault-unlock-modal">
                <button data-testid="vault-modal-unlock-btn" onClick={() => onUnlocked("mock-token")}>
                    Confirm Unlock
                </button>
                <button data-testid="vault-modal-close-btn" onClick={onClose}>
                    Close
                </button>
            </div>
        ) : null,
}));

vi.mock("@/components/layout/ocr-settings-card", () => ({
    OcrSettingsCard: () => <div data-testid="ocr-settings-card">OCR Settings</div>,
}));

vi.mock("@/components/editor/search-replace", () => ({
    SearchReplace: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
        isOpen ? (
            <div data-testid="search-replace-dialog">
                <span>Search and Replace Dialog</span>
                <button data-testid="search-replace-close-btn" onClick={onClose}>
                    Close Search
                </button>
            </div>
        ) : null,
}));

vi.mock("@/components/sync/sync-indicator", () => ({
    SyncIndicator: ({ status, pendingCount }: { status: string; pendingCount: number }) => (
        <div data-testid="sync-indicator" data-status={status} data-pending={pendingCount}>
            Sync ({status})
        </div>
    ),
}));

vi.mock("@/components/sync/conflict-dialog", () => ({
    ConflictDialog: ({
        conflict,
        onResolve,
        onClose,
        isResolving,
    }: {
        conflict: { version?: number };
        onResolve: (strat: string) => void;
        onClose: () => void;
        isResolving: boolean;
    }) => (
        <div data-testid="conflict-dialog">
            <span>Conflict Dialog Version: {conflict?.version}</span>
            <button
                data-testid="resolve-merge-btn"
                disabled={isResolving}
                onClick={() => onResolve("merge")}
            >
                Resolve Merge
            </button>
            <button data-testid="close-conflict-btn" onClick={onClose}>
                Close
            </button>
        </div>
    ),
}));

vi.mock("@/components/export/export-warning-modal", () => ({
    ExportWarningModal: ({
        isOpen,
        onConfirm,
        onClose,
    }: {
        isOpen: boolean;
        onConfirm: () => void;
        onClose: () => void;
    }) =>
        isOpen ? (
            <div data-testid="export-warning-modal">
                <button data-testid="confirm-export-btn" onClick={onConfirm}>
                    Confirm Export
                </button>
                <button data-testid="cancel-export-btn" onClick={onClose}>
                    Cancel Export
                </button>
            </div>
        ) : null,
}));

let mockAdapterInstance: {
    getValue: () => string;
    getWordCount: () => number;
    getCharCount: () => number;
    getSelectedText: () => string;
    undo: () => void;
    redo: () => void;
    canUndo: () => boolean;
    canRedo: () => boolean;
    insertMarkdown: (p: string, s?: string, pl?: string) => void;
    setDirectionSettings: (d: unknown) => void;
};

vi.mock("@/components/editor/markdown", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/components/editor/markdown")>();
    return {
        ...actual,
        MarkdownEditor: ({
            onAdapterReady,
            placeholder,
            className,
        }: {
            onAdapterReady?: (adapter: typeof mockAdapterInstance) => void;
            placeholder?: string;
            className?: string;
        }) => {
            React.useEffect(() => {
                if (onAdapterReady && mockAdapterInstance) {
                    onAdapterReady(mockAdapterInstance);
                }
            }, [onAdapterReady]);
            return (
                <div data-testid="mock-markdown-editor" className={className}>
                    <span>{placeholder}</span>
                </div>
            );
        },
    };
});

// ============================================================================
// Orchestrator Mock Setup
// ============================================================================

type OrchestratorReturnType = ReturnType<typeof import("@/hooks/use-editor-orchestrator")["useEditorOrchestrator"]>;

let mockOrchestratorData: Partial<OrchestratorReturnType> = {};

vi.mock("@/hooks/use-editor-orchestrator", () => ({
    useEditorOrchestrator: () => ({
        title: "Architecture Plan",
        hydration: "hydrated",
        aiStatus: "idle",
        aiError: null,
        agentGraphStage: null,
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
            connectionState: "connected",
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
        ...mockOrchestratorData,
    }),
}));

// ============================================================================
// Imports Under Test
// ============================================================================

import { AIStreamStatus } from "@/components/editor/ai-stream-status";
import DashboardPage from "@/client/routes/dashboard-page";
import AccountPage from "@/client/routes/account-page";
import EditorPage from "@/client/routes/editor-page";
import { TIER_LIMITS } from "@/config/tiers.config";
import { MICRO_PER_CREDIT } from "@/lib/metering/constants";

// ============================================================================
// Test Suite Begins
// ============================================================================

describe("Phase 11 — Wave 11.2 UI Components & Orchestration Suite", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFileIdParam = "file-arch-test-123";
        mockAdapterInstance = {
            getValue: vi.fn().mockReturnValue("# Markdown content"),
            getWordCount: vi.fn().mockReturnValue(2),
            getCharCount: vi.fn().mockReturnValue(18),
            getSelectedText: vi.fn().mockReturnValue(""),
            undo: vi.fn(),
            redo: vi.fn(),
            canUndo: vi.fn().mockReturnValue(true),
            canRedo: vi.fn().mockReturnValue(false),
            insertMarkdown: vi.fn(),
            setDirectionSettings: vi.fn(),
        };
        mockGetServerUser.mockResolvedValue({ id: "user-client-123" });
        mockGetClientUser.mockImplementation(async () => {
            const user = await mockGetServerUser();
            return { data: { user } };
        });
        mockGetCreditBalanceResult.mockImplementation(async () => {
            const raw = await mockGetUserCreditBalance();
            if (raw !== undefined) {
                return {
                    success: true,
                    balanceMicro: raw.toString(),
                    balance: typeof raw === "bigint" ? raw : BigInt(raw),
                };
            }
            return {
                success: true,
                balanceMicro: "10000000",
                balance: BigInt(10000000),
            };
        });
        mockOrchestratorData = {};
    });

    afterEach(() => {
        cleanup();
    });

    // ========================================================================
    // 1. AIStreamStatus Component (8-State Rendering & Edge Cases)
    // ========================================================================
    describe("1. AIStreamStatus Component (8-State Rendering & Edge Cases)", () => {
        it("returns null when status is 'idle' and isConflict is false", () => {
            const { container } = render(<AIStreamStatus status="idle" />);
            expect(container.firstChild).toBeNull();
            expect(screen.queryByTestId("ai-stream-status")).toBeNull();
        });

        it("renders Notice card when isConflict is true, prioritizing conflict over any status", () => {
            const onRetry = vi.fn();
            render(
                <AIStreamStatus
                    status="running_graph"
                    isConflict={true}
                    onRetry={onRetry}
                    className="custom-conflict-class"
                />
            );

            const card = screen.getByTestId("ai-stream-status");
            expect(card).toBeDefined();
            expect(card.className).toContain("custom-conflict-class");
            expect(card.textContent).toContain(
                "Notice: File was modified in another session during processing. Original text was preserved."
            );

            const retryBtn = screen.getByTestId("ai-stream-retry-btn");
            fireEvent.click(retryBtn);
            expect(onRetry).toHaveBeenCalledTimes(1);
        });

        it("does not render retry button in conflict mode when onRetry is omitted", () => {
            render(<AIStreamStatus status="failed" isConflict={true} />);
            expect(screen.queryByTestId("ai-stream-retry-btn")).toBeNull();
        });

        it("renders 'running_graph' with default reasoning label when currentStage is not provided", () => {
            const onStop = vi.fn();
            render(<AIStreamStatus status="running_graph" onStop={onStop} />);

            const status = screen.getByTestId("ai-stream-status");
            expect(status.textContent).toContain("Agent reasoning...");
            const stopBtn = screen.getByTestId("ai-stream-stop-btn");
            fireEvent.click(stopBtn);
            expect(onStop).toHaveBeenCalledTimes(1);
        });

        it("renders 'running_graph' with formatted currentStage label", () => {
            render(
                <AIStreamStatus
                    status="running_graph"
                    currentStage="section_synthesis"
                />
            );

            expect(screen.getByTestId("ai-stream-status").textContent).toContain(
                "Agent reasoning: section_synthesis..."
            );
        });

        it("renders legacy 'reserved' state label with stop button", () => {
            const onCancel = vi.fn();
            render(
                <AIStreamStatus
                    status={"reserved" as any}
                    onCancel={onCancel}
                />
            );

            expect(screen.getByTestId("ai-stream-status").textContent).toContain(
                "Reserving quota and initiating session..."
            );
            const stopBtn = screen.getByTestId("ai-stream-stop-btn");
            fireEvent.click(stopBtn);
            expect(onCancel).toHaveBeenCalledTimes(1);
        });

        it("renders legacy 'committing' state and strictly hides the stop button", () => {
            const onStop = vi.fn();
            render(
                <AIStreamStatus
                    status={"committing" as any}
                    onStop={onStop}
                />
            );

            expect(screen.getByTestId("ai-stream-status").textContent).toContain(
                "Committing changes..."
            );
            expect(screen.queryByTestId("ai-stream-stop-btn")).toBeNull();
        });

        it("renders 'awaiting_hitl' with clarification prompt and functional stop button", () => {
            const onStop = vi.fn();
            render(<AIStreamStatus status="awaiting_hitl" onStop={onStop} />);

            const status = screen.getByTestId("ai-stream-status");
            expect(status.textContent).toContain("Awaiting clarification");

            const stopBtn = screen.getByTestId("ai-stream-stop-btn");
            fireEvent.click(stopBtn);
            expect(onStop).toHaveBeenCalledTimes(1);
        });

        it("renders 'streaming_hunks' with synthesizing label and stop action", () => {
            const onStop = vi.fn();
            render(<AIStreamStatus status="streaming_hunks" onStop={onStop} />);

            expect(screen.getByTestId("ai-stream-status").textContent).toContain(
                "Synthesizing document hunks..."
            );
            const stopBtn = screen.getByTestId("ai-stream-stop-btn");
            fireEvent.click(stopBtn);
            expect(onStop).toHaveBeenCalledTimes(1);
        });

        it("supports legacy 'streaming' status alias", () => {
            render(<AIStreamStatus status={"streaming" as any} />);
            expect(screen.getByTestId("ai-stream-status").textContent).toContain(
                "Synthesizing document hunks..."
            );
        });

        it("renders 'preview_ready' with generic label when activeGhostHunksCount is 0 or undefined", () => {
            const { rerender } = render(<AIStreamStatus status="preview_ready" />);
            expect(screen.getByTestId("ai-stream-status").textContent).toContain("Ghost preview ready");

            rerender(<AIStreamStatus status="preview_ready" activeGhostHunksCount={0} />);
            expect(screen.getByTestId("ai-stream-status").textContent).toContain("Ghost preview ready");
        });

        it("renders 'preview_ready' with singular hunk label when activeGhostHunksCount is 1", () => {
            render(<AIStreamStatus status="preview_ready" activeGhostHunksCount={1} />);
            expect(screen.getByTestId("ai-stream-status").textContent).toContain(
                "Ghost preview ready (1 hunk)"
            );
        });

        it("renders 'preview_ready' with plural hunks label when activeGhostHunksCount is greater than 1", () => {
            render(<AIStreamStatus status="preview_ready" activeGhostHunksCount={5} />);
            expect(screen.getByTestId("ai-stream-status").textContent).toContain(
                "Ghost preview ready (5 hunks)"
            );
        });

        it("renders 'completed' with changes applied confirmation", () => {
            render(<AIStreamStatus status="completed" />);
            expect(screen.getByTestId("ai-stream-status").textContent).toContain("Changes applied");
        });

        it("renders 'aborted' with session aborted indicator", () => {
            render(<AIStreamStatus status="aborted" />);
            expect(screen.getByTestId("ai-stream-status").textContent).toContain("Session aborted");
        });

        it("renders 'failed' with error fallback when no message is provided", () => {
            const onRetry = vi.fn();
            render(<AIStreamStatus status="failed" onRetry={onRetry} />);

            expect(screen.getByTestId("ai-stream-error").textContent).toContain(
                "An error occurred during AI processing. Quota was refunded."
            );
            const retryBtn = screen.getByTestId("ai-stream-retry-btn");
            fireEvent.click(retryBtn);
            expect(onRetry).toHaveBeenCalledTimes(1);
        });

        it("renders 'failed' with custom error or errorMessage and retry button", () => {
            const { rerender } = render(
                <AIStreamStatus status="failed" error="Pessimistic quota reservation depleted" />
            );
            expect(screen.getByTestId("ai-stream-error").textContent).toContain(
                "Pessimistic quota reservation depleted"
            );

            rerender(
                <AIStreamStatus
                    status="failed"
                    errorMessage="Circuit breaker active for gemini-3.8-flash"
                />
            );
            expect(screen.getByTestId("ai-stream-error").textContent).toContain(
                "Circuit breaker active for gemini-3.8-flash"
            );
        });

        it("does not render retry button in failed status when onRetry is omitted", () => {
            render(<AIStreamStatus status="failed" error="Connection aborted" />);
            expect(screen.queryByTestId("ai-stream-retry-btn")).toBeNull();
        });

        it("safely returns null for unknown status strings", () => {
            const { container } = render(<AIStreamStatus status={"unknown_custom_status" as any} />);
            expect(container.firstChild).toBeNull();
        });
    });

    // ========================================================================
    // 2. DashboardPage Credit Views & Progress Metering
    // ========================================================================
    describe("2. DashboardPage Credit Views & Progress Metering", () => {
        it("redirects unauthenticated visitor to /login", async () => {
            mockGetServerUser.mockResolvedValue(null);

            render(<DashboardPage />);
            await waitFor(() => {
                expect(mockRedirect).toHaveBeenCalledWith("/login");
            });
        });

        it("renders Free tier credit progress bar and available balance accurately", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-free-1" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Alice Engineer", tier: "free" },
            });
            // 25 credits remaining out of 50 credits (50% remaining)
            const balanceMicro = BigInt(25) * MICRO_PER_CREDIT;
            mockGetUserCreditBalance.mockResolvedValue(balanceMicro);

            render(<DashboardPage />);

            await waitFor(() => {
                expect(screen.getByText("Welcome back, Alice Engineer")).toBeDefined();
            });
            expect(screen.getByText("AI Architectural Credits")).toBeDefined();
            expect(screen.getByText("50% available")).toBeDefined();
            const span = screen.getByText(new RegExp(`/ ${TIER_LIMITS.free.creditsDisplay.toLocaleString()} Credits`));
            expect(span.parentElement?.textContent?.replace(/\s+/g, " ").trim()).toContain("25 / 50 Credits");
        });

        it("renders Pro tier credit allocation and handles 0 balance safely", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-pro-1" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Bob Architect", tier: "pro" },
            });
            mockGetUserCreditBalance.mockResolvedValue(BigInt(0));

            render(<DashboardPage />);

            await waitFor(() => {
                expect(screen.getByText("Welcome back, Bob Architect")).toBeDefined();
            });
            expect(screen.getByText("0% available")).toBeDefined();
            const span = screen.getByText(new RegExp(`/ ${TIER_LIMITS.pro.creditsDisplay.toLocaleString()} Credits`));
            expect(span.parentElement?.textContent?.replace(/\s+/g, " ").trim()).toContain("0 / 1,000 Credits");
        });

        it("renders Ultra tier credit allocation with the Ultra badge indicator", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-ultra-1" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Charlie Director", tier: "ultra" },
            });
            // Full 3,500 credits (100% available)
            const balanceMicro = BigInt(TIER_LIMITS.ultra.creditsDisplay) * MICRO_PER_CREDIT;
            mockGetUserCreditBalance.mockResolvedValue(balanceMicro);

            render(<DashboardPage />);

            await waitFor(() => {
                expect(screen.getByText("Welcome back, Charlie Director")).toBeDefined();
            });
            expect(screen.getByText("✦")).toBeDefined();
            expect(screen.getByText("100% available")).toBeDefined();
            const span = screen.getByText(new RegExp(`/ ${TIER_LIMITS.ultra.creditsDisplay.toLocaleString()} Credits`));
            expect(span.parentElement?.textContent?.replace(/\s+/g, " ").trim()).toContain("3,500 / 3,500 Credits");
        });

        it("clamps percentage remaining to 100% when balance exceeds tier limits", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-free-bonus" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Over Allocated User", tier: "free" },
            });
            // 150 credits on Free tier (limit 50)
            const balanceMicro = BigInt(150) * MICRO_PER_CREDIT;
            mockGetUserCreditBalance.mockResolvedValue(balanceMicro);

            render(<DashboardPage />);

            await waitFor(() => {
                expect(screen.getByText("100% available")).toBeDefined();
            });
            const span = screen.getByText(new RegExp(`/ ${TIER_LIMITS.free.creditsDisplay.toLocaleString()} Credits`));
            expect(span.parentElement?.textContent?.replace(/\s+/g, " ").trim()).toContain("150 / 50 Credits");
        });

        it("clamps percentage remaining to 0% when balance is negative", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-deficit" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Deficit User", tier: "free" },
            });
            mockGetUserCreditBalance.mockResolvedValue(BigInt(-5_000_000));

            render(<DashboardPage />);

            await waitFor(() => {
                expect(screen.getByText("0% available")).toBeDefined();
            });
        });

        it("renders payment success notification banner when session_id searchParam is present", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-paid-1" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Subscriber", tier: "pro" },
            });
            mockGetUserCreditBalance.mockResolvedValue(BigInt(1_000_000_000));

            render(
                <DashboardPage
                    searchParams={Promise.resolve({ session_id: "cs_stripe_mock_session_123" })}
                />
            );

            await waitFor(() => {
                expect(screen.getByText("Payment Successful!")).toBeDefined();
            });
            expect(
                screen.getByText("Your subscription has been activated. Welcome to your upgraded workspace.")
            ).toBeDefined();
        });

        it("falls back to 'User' when profile displayName is undefined", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-anon" });
            mockGetUserProfile.mockResolvedValue({ data: null });
            mockGetUserCreditBalance.mockResolvedValue(BigInt(0));

            render(<DashboardPage />);

            await waitFor(() => {
                expect(screen.getByText("Welcome back, User")).toBeDefined();
            });
        });

        it("does NOT redirect to /login when getCreditBalanceResult returns error status", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-free-err" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Alice Engineer", tier: "free" },
            });
            mockGetCreditBalanceResult.mockResolvedValue({
                success: false,
                status: "error",
                statusCode: 500,
                error: "Billing service unavailable",
            });

            render(<DashboardPage />);

            await waitFor(() => {
                expect(screen.getByText("Billing service unavailable")).toBeDefined();
            });
            expect(mockRedirect).not.toHaveBeenCalledWith("/login");
        });
    });

    // ========================================================================
    // 3. AccountPage Metered Credit Balance & Plan Comparison
    // ========================================================================
    describe("3. AccountPage Metered Credit Balance & Plan Comparison", () => {
        it("redirects unauthenticated visitor to /login", async () => {
            mockGetServerUser.mockResolvedValue(null);

            render(<AccountPage />);
            await waitFor(() => {
                expect(mockRedirect).toHaveBeenCalledWith("/login");
            });
        });

        it("renders Micro-Credit Metered AI Settlement section and displays accurate balance for Free tier", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-acc-free" });
            mockGetUserProfile.mockResolvedValue({
                data: {
                    displayName: "Dana Engineer",
                    email: "dana@example.com",
                    tier: "free",
                },
            });
            // 50 credits remaining out of 50 credits (100% remaining)
            mockGetUserCreditBalance.mockResolvedValue(BigInt(50) * MICRO_PER_CREDIT);

            render(<AccountPage />);

            await waitFor(() => {
                expect(screen.getByText("Account Settings")).toBeDefined();
            });
            expect(screen.getByText("Dana Engineer")).toBeDefined();
            expect(screen.getByText("dana@example.com")).toBeDefined();
            expect(screen.getByText("Micro-Credit Metered AI Settlement")).toBeDefined();
            expect(screen.getByText("FREE")).toBeDefined();
            expect(screen.getByText("100% remaining")).toBeDefined();
            expect(screen.getByText("Allocation resets each monthly billing cycle")).toBeDefined();

            // Check embedded security and OCR settings cards
            expect(screen.getByTestId("vault-security-card")).toBeDefined();
            expect(screen.getByTestId("ocr-settings-card")).toBeDefined();
        });

        it("renders both Pro and Ultra upgrade buttons for Free tier users", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-acc-free-upgrade" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Free User", tier: "free" },
            });
            mockGetUserCreditBalance.mockResolvedValue(BigInt(0));

            render(<AccountPage />);

            await waitFor(() => {
                expect(screen.getByTestId("upgrade-btn-pro")).toBeDefined();
            });
            expect(screen.getByTestId("upgrade-btn-ultra")).toBeDefined();
        });

        it("renders only Ultra upgrade button for Pro tier users", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-acc-pro" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Pro User", tier: "pro" },
            });
            // 400 credits remaining out of 1000 credits (40% remaining)
            mockGetUserCreditBalance.mockResolvedValue(BigInt(400) * MICRO_PER_CREDIT);

            render(<AccountPage />);

            await waitFor(() => {
                expect(screen.getByText("PRO")).toBeDefined();
            });
            expect(screen.queryByTestId("upgrade-btn-pro")).toBeNull();
            expect(screen.getByTestId("upgrade-btn-ultra")).toBeDefined();
            expect(screen.getByText("40% remaining")).toBeDefined();
        });

        it("renders zero upgrade buttons and shows the Ultra badge for Ultra tier users", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-acc-ultra" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Ultra User", tier: "ultra" },
            });
            mockGetUserCreditBalance.mockResolvedValue(BigInt(3_500) * MICRO_PER_CREDIT);

            render(<AccountPage />);

            await waitFor(() => {
                expect(screen.getByText("ULTRA")).toBeDefined();
            });
            expect(screen.queryByTestId("upgrade-btn-pro")).toBeNull();
            expect(screen.queryByTestId("upgrade-btn-ultra")).toBeNull();
            expect(screen.getByText("✦")).toBeDefined();
        });

        it("synchronizes Available Plans comparison cards with exact TIER_LIMITS.creditsDisplay", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-plans-check" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Tester", tier: "free" },
            });
            mockGetUserCreditBalance.mockResolvedValue(BigInt(0));

            render(<AccountPage />);

            await waitFor(() => {
                expect(screen.getByText("Available Plans")).toBeDefined();
            });
            expect(
                screen.getByText(`${TIER_LIMITS.free.creditsDisplay.toLocaleString()} Credits/month`)
            ).toBeDefined();
            expect(
                screen.getByText(`${TIER_LIMITS.pro.creditsDisplay.toLocaleString()} Credits/month`)
            ).toBeDefined();
            expect(
                screen.getByText(`${TIER_LIMITS.ultra.creditsDisplay.toLocaleString()} Credits/month`)
            ).toBeDefined();
        });

        it("renders initial fallback avatar letter when user has no avatarUrl", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-initial" });
            mockGetUserProfile.mockResolvedValue({
                data: { displayName: "Elena", avatarUrl: null, tier: "free" },
            });
            mockGetUserCreditBalance.mockResolvedValue(BigInt(0));

            render(<AccountPage />);

            await waitFor(() => {
                expect(screen.getByText("E")).toBeDefined();
            });
        });

        it("renders user avatar image when avatarUrl is provided in profile", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-avatar" });
            mockGetUserProfile.mockResolvedValue({
                data: {
                    displayName: "Frank",
                    avatarUrl: "https://example.com/avatar.png",
                    tier: "free",
                },
            });
            mockGetUserCreditBalance.mockResolvedValue(BigInt(0));

            render(<AccountPage />);

            await waitFor(() => {
                const img = screen.getByAltText("Frank") as HTMLImageElement;
                expect(img.src).toContain("https://example.com/avatar.png");
            });
        });

        it("does NOT redirect to /login when getCreditBalanceResult returns error status", async () => {
            mockGetServerUser.mockResolvedValue({ id: "user-acc-err" });
            mockGetUserProfile.mockResolvedValue({
                data: {
                    displayName: "Dana Engineer",
                    email: "dana@example.com",
                    tier: "free",
                },
            });
            mockGetCreditBalanceResult.mockResolvedValue({
                success: false,
                status: "error",
                statusCode: 500,
                error: "Billing service unavailable",
            });

            render(<AccountPage />);

            await waitFor(() => {
                expect(screen.getByText("Billing service unavailable")).toBeDefined();
            });
            expect(mockRedirect).not.toHaveBeenCalledWith("/login");
        });
    });

    // ========================================================================
    // 4. EditorPage Architectural Agent & Component Wiring
    // ========================================================================
    describe("4. EditorPage Architectural Agent & Component Wiring", () => {
        const renderEditorPage = async () => {
            const result = render(<EditorPage />);
            await waitFor(() => {
                expect(mockGetClientUser).toHaveBeenCalled();
            });
            return result;
        };

        it("mounts editor, fetches authenticated user, and binds useEditorOrchestrator", async () => {
            await renderEditorPage();

            expect(screen.getByTestId("ai-toolbar-agent-toggle")).toBeDefined();
            expect(screen.getByText("Architecture Plan")).toBeDefined();
            expect(screen.getByTestId("mock-markdown-editor")).toBeDefined();
        });

        it("renders lock icon in status bar when document is encrypted", async () => {
            mockOrchestratorData = { isEncrypted: true };
            await renderEditorPage();

            // Status bar renders document title with lock icon
            expect(screen.getByTitle("Architecture Plan")).toBeDefined();
        });

        it("toggles AgentChatPanel open state when clicking toolbar agent button", async () => {
            await renderEditorPage();

            // Agent chat panel is closed by default
            expect(screen.queryByTestId("agent-chat-panel")).toBeNull();

            // Click agent toggle button in AIToolbar
            fireEvent.click(screen.getByTestId("ai-toolbar-agent-toggle"));

            // Agent chat panel should now be open
            await waitFor(() => {
                expect(screen.getByTestId("agent-chat-panel")).toBeDefined();
            });

            // Clicking close button inside AgentChatPanel closes it
            const closeBtn = screen.getByTitle("Close Agent Panel");
            fireEvent.click(closeBtn);

            await waitFor(() => {
                expect(screen.queryByTestId("agent-chat-panel")).toBeNull();
            });
        });

        it("wires AIStreamStatus ephemeral states and triggers orchestrator resetAI on retry", async () => {
            const resetAIMock = vi.fn();
            mockOrchestratorData = {
                aiStatus: "failed",
                aiError: "Quota limit exhausted",
                resetAI: resetAIMock,
            };

            await renderEditorPage();

            expect(screen.getByTestId("ai-stream-status")).toBeDefined();
            expect(screen.getByTestId("ai-stream-error").textContent).toContain("Quota limit exhausted");

            const retryBtn = screen.getByTestId("ai-stream-retry-btn");
            fireEvent.click(retryBtn);
            expect(resetAIMock).toHaveBeenCalledTimes(1);
        });

        it("wires AIStreamStatus running_graph stage label and triggers stopAIOperation", async () => {
            const stopAIMock = vi.fn();
            mockOrchestratorData = {
                aiStatus: "running_graph",
                agentGraphStage: "atms_evaluation",
                stopAIOperation: stopAIMock,
            };

            await renderEditorPage();

            expect(screen.getByTestId("ai-stream-status").textContent).toContain(
                "Agent reasoning: atms_evaluation..."
            );

            const stopBtn = screen.getByTestId("ai-stream-stop-btn");
            fireEvent.click(stopBtn);
            expect(stopAIMock).toHaveBeenCalledTimes(1);
        });

        it("wires activeGhostHunksCount and batch accept/reject actions to AIToolbar", async () => {
            const acceptAllMock = vi.fn();
            const rejectAllMock = vi.fn();
            mockOrchestratorData = {
                activeGhostHunksCount: 3,
                acceptAllGhostHunks: acceptAllMock,
                rejectAllGhostHunks: rejectAllMock,
            };

            await renderEditorPage();

            expect(screen.getByTestId("ai-toolbar-ghost-actions")).toBeDefined();
            expect(screen.getByTestId("ai-toolbar-ghost-count").textContent).toContain("3 hunks");

            const acceptAllBtn = screen.getByTestId("ai-toolbar-accept-all");
            fireEvent.click(acceptAllBtn);
            expect(acceptAllMock).toHaveBeenCalledTimes(1);

            const rejectAllBtn = screen.getByTestId("ai-toolbar-reject-all");
            fireEvent.click(rejectAllBtn);
            expect(rejectAllMock).toHaveBeenCalledTimes(1);
        });

        it("handles Escape key shortcut: invokes stopAIOperation only when isAIActive is true", async () => {
            const stopAIMock = vi.fn();
            mockOrchestratorData = {
                isAIActive: false,
                stopAIOperation: stopAIMock,
            };

            const { rerender } = await renderEditorPage();

            // Escape while AI is inactive -> no-op
            fireEvent.keyDown(window, { key: "Escape" });
            expect(stopAIMock).not.toHaveBeenCalled();

            // Escape while AI is active -> triggers stopAIOperation
            mockOrchestratorData = {
                isAIActive: true,
                stopAIOperation: stopAIMock,
            };
            rerender(<EditorPage />);

            fireEvent.keyDown(window, { key: "Escape" });
            expect(stopAIMock).toHaveBeenCalledTimes(1);
        });

        it("handles Ctrl+F shortcut to toggle SearchReplace dialog", async () => {
            await renderEditorPage();

            expect(screen.queryByTestId("search-replace-dialog")).toBeNull();

            // Fire Ctrl+F
            fireEvent.keyDown(window, { key: "f", ctrlKey: true });

            expect(screen.getByTestId("search-replace-dialog")).toBeDefined();

            // Close dialog
            fireEvent.click(screen.getByTestId("search-replace-close-btn"));
            expect(screen.queryByTestId("search-replace-dialog")).toBeNull();
        });

        it("renders hydration loading overlay when hydration is 'hydrating' and adapter is empty", async () => {
            mockAdapterInstance.getValue = vi.fn().mockReturnValue("");
            mockOrchestratorData = { hydration: "hydrating" };

            await renderEditorPage();

            expect(screen.getByText("Loading and synchronizing document...")).toBeDefined();
        });

        it("renders vault locked overlay with Unlock Vault button when hydration is 'vault_locked'", async () => {
            const setIsUnlockModalOpenMock = vi.fn();
            mockOrchestratorData = {
                hydration: "vault_locked",
                setIsUnlockModalOpen: setIsUnlockModalOpenMock,
            };

            await renderEditorPage();

            expect(screen.getByText("Document Encrypted & Protected")).toBeDefined();

            const unlockBtn = screen.getByRole("button", { name: /Unlock Vault/i });
            fireEvent.click(unlockBtn);
            expect(setIsUnlockModalOpenMock).toHaveBeenCalledWith(true);
        });

        it("renders fatal document error screen when hydration is 'fatal'", async () => {
            mockOrchestratorData = { hydration: "fatal" };

            await renderEditorPage();

            expect(screen.getByText("Unable to Open Document")).toBeDefined();
            const returnBtn = screen.getByRole("button", { name: /Return to Workspace/i });
            fireEvent.click(returnBtn);
            expect(mockPush).toHaveBeenCalledWith("/workspace");
        });

        it("renders 412 Conflict Alert Banner and opens ConflictDialog upon review request", async () => {
            const setIsConflictDialogOpenMock = vi.fn();
            const resolveConflictMock = vi.fn();
            mockOrchestratorData = {
                activeConflict: {
                    fileId: "file-arch-test-123",
                    version: 8,
                    serverVersion: { version: 8, content: "Remote edit" },
                } as any,
                isConflictDialogOpen: false,
                setIsConflictDialogOpen: setIsConflictDialogOpenMock,
                handleResolveConflict: resolveConflictMock,
            };

            const { rerender } = await renderEditorPage();

            expect(screen.getByText(/Conflict Warning:/)).toBeDefined();
            const reviewBtn = screen.getByRole("button", { name: /Review & Resolve Conflict/i });
            fireEvent.click(reviewBtn);
            expect(setIsConflictDialogOpenMock).toHaveBeenCalledWith(true);

            // Re-render with dialog open
            mockOrchestratorData = {
                ...mockOrchestratorData,
                isConflictDialogOpen: true,
            };
            rerender(<EditorPage />);

            expect(screen.getByTestId("conflict-dialog")).toBeDefined();
            const resolveBtn = screen.getByTestId("resolve-merge-btn");
            fireEvent.click(resolveBtn);
            expect(resolveConflictMock).toHaveBeenCalledWith("merge");
        });
    });
});
