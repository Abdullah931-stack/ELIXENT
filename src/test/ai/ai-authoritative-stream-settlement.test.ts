import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setScheduleAfterResponseListener } from "@/server/context/request-context";

const {
    mockAfterCallbacks,
    mockRequireAuthenticatedUser,
    mockGraphStream,
    mockFlushPendingSettlements,
    mockZeroOutVaultMemory,
} = vi.hoisted(() => ({
    mockAfterCallbacks: [] as Array<() => Promise<void> | void>,
    mockRequireAuthenticatedUser: vi.fn(),
    mockGraphStream: vi.fn(),
    mockFlushPendingSettlements: vi.fn(),
    mockZeroOutVaultMemory: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
    requireAuthenticatedUser: mockRequireAuthenticatedUser,
}));

vi.mock("@/lib/rate-limit", () => ({
    aiStreamRateLimiter: {
        limit: vi.fn().mockResolvedValue({ success: true, remaining: 29, reset: 60, limit: 30 }),
    },
    addRateLimitHeaders: vi.fn(),
    rateLimitExceededResponse: vi.fn(),
}));

vi.mock("@/core/agent/graph", () => ({
    elixentAgentGraph: {
        stream: mockGraphStream,
    },
}));

vi.mock("@/server/services/ai-settlement-service", () => ({
    flushPendingSettlementsToPostgres: mockFlushPendingSettlements,
}));

vi.mock("@/lib/vault/ephemeral-memory-map", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/vault/ephemeral-memory-map")>();
    return {
        ...actual,
        zeroOutEphemeralVaultMemory: (...args: unknown[]) => {
            mockZeroOutVaultMemory(...args);
            return actual.zeroOutEphemeralVaultMemory();
        },
    };
});

import { handleAgentStreamPost as agentStreamRoute } from "@/server/routes/agent.routes";

describe("Phase 11: Authoritative Server-Side Agent Stream Settlement (/api/agent/stream)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setScheduleAfterResponseListener((cb) => mockAfterCallbacks.push(cb));
        mockAfterCallbacks.length = 0;
        mockRequireAuthenticatedUser.mockResolvedValue({ id: "user_test_1" });
        mockFlushPendingSettlements.mockResolvedValue({ flushedCount: 1, netDeltaMicro: BigInt(-1000) });
    });

    afterEach(() => {
        setScheduleAfterResponseListener(null);
    });

    async function drainSSEFrames(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let raw = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();

        const blocks = raw.split("\n\n").map((b) => b.trim()).filter(Boolean);
        return blocks.map((block) => {
            const lines = block.split("\n");
            const eventLine = lines.find((l) => l.startsWith("event:")) ?? "event: message";
            const dataLine = lines.find((l) => l.startsWith("data:")) ?? "data: {}";
            return {
                event: eventLine.slice("event:".length).trim(),
                data: JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>,
            };
        });
    }

    it("completes SSE stream with zero route-level double-metering and schedules PostgreSQL background flush via after()", async () => {
        mockGraphStream.mockResolvedValueOnce(
            (async function* () {
                yield { document_writer_node: { status: "writing", text: "Hello " } };
                yield { document_writer_node: { status: "done", text: "world!" } };
            })()
        );

        const req = new Request("http://localhost/api/agent/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threadId: "thread_success_1",
                projectId: "proj_1",
                targetFileIds: ["file_test_1"],
                prompt: "Write a clean introduction section",
            }),
        });

        const res = await agentStreamRoute(req);
        expect(res.status).toBe(200);

        const frames = await drainSSEFrames(res);
        expect(frames[0].event).toBe("start");
        expect(frames.some((f) => f.event === "update")).toBe(true);
        expect(frames[frames.length - 1].event).toBe("done");

        expect(mockZeroOutVaultMemory).toHaveBeenCalled();

        expect(mockAfterCallbacks).toHaveLength(1);
        await mockAfterCallbacks[0]();
        expect(mockFlushPendingSettlements).toHaveBeenCalledWith("user_test_1");
    });

    it("emits STREAM_EXECUTION_ERROR, zeroes vault memory, and still schedules PostgreSQL flush when upstream graph throws", async () => {
        mockGraphStream.mockResolvedValueOnce(
            (async function* () {
                yield { search_agent_node: { status: "searching" } };
                throw new Error("Upstream model runtime failure");
            })()
        );

        const req = new Request("http://localhost/api/agent/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threadId: "thread_fail_1",
                projectId: "proj_1",
                targetFileIds: ["file_test_1"],
                prompt: "Analyze document",
            }),
        });

        const res = await agentStreamRoute(req);
        expect(res.status).toBe(200);

        const frames = await drainSSEFrames(res);
        const errorFrame = frames.find((f) => f.event === "error");
        expect(errorFrame).toBeDefined();
        expect(errorFrame?.data.code).toBe("STREAM_EXECUTION_ERROR");

        expect(mockZeroOutVaultMemory).toHaveBeenCalled();
        expect(mockAfterCallbacks).toHaveLength(1);
        await mockAfterCallbacks[0]();
        expect(mockFlushPendingSettlements).toHaveBeenCalledWith("user_test_1");
    });

    it("emits INSUFFICIENT_CREDITS interrupt frame, suppresses done, zeroes vault memory, and schedules PostgreSQL flush", async () => {
        mockGraphStream.mockResolvedValueOnce(
            (async function* () {
                yield {
                    nodeId: "document_writer_node",
                    stepIndex: 2,
                    status: "INTERRUPTED",
                    interruptReason: "INSUFFICIENT_CREDITS",
                    interruptPayload: {
                        availableMicro: 100,
                        requiredMicro: 50_000,
                    },
                };
            })()
        );

        const req = new Request("http://localhost/api/agent/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threadId: "thread_quota_exhausted",
                projectId: "proj_1",
                targetFileIds: ["file_test_1"],
                prompt: "Generate long specification",
            }),
        });

        const res = await agentStreamRoute(req);
        expect(res.status).toBe(200);

        const frames = await drainSSEFrames(res);
        const interruptFrame = frames.find((f) => f.event === "interrupt");
        expect(interruptFrame).toBeDefined();
        expect(interruptFrame?.data).toMatchObject({
            type: "interrupt",
            interruptReason: "INSUFFICIENT_CREDITS",
            interrupts: [
                {
                    resumable: false,
                    value: {
                        code: "INSUFFICIENT_CREDITS",
                        availableMicro: 100,
                        requiredMicro: 50_000,
                    },
                },
            ],
        });
        expect(frames.some((f) => f.event === "done")).toBe(false);
        expect(mockZeroOutVaultMemory).toHaveBeenCalled();

        expect(mockAfterCallbacks).toHaveLength(1);
        await mockAfterCallbacks[0]();
        expect(mockFlushPendingSettlements).toHaveBeenCalledWith("user_test_1");
    });

    it("zeroes vault memory cleanly when client cancels the response stream", async () => {
        mockGraphStream.mockImplementationOnce(async () => {
            return (async function* () {
                await new Promise(() => {
                    // Hang until client cancels stream
                });
                yield {};
            })();
        });

        const req = new Request("http://localhost/api/agent/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threadId: "thread_cancel_1",
                projectId: "proj_1",
                targetFileIds: ["file_test_1"],
                prompt: "Translate section",
            }),
        });

        const res = await agentStreamRoute(req);
        expect(res.status).toBe(200);

        await res.body!.cancel("Client disconnected");

        expect(mockZeroOutVaultMemory).toHaveBeenCalled();
        expect(mockAfterCallbacks).toHaveLength(1);
    });
});
