import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeRequestHash, reserveAIQuota } from "@/server/services/ai-settlement-service";
import { NextRequest } from "next/server";
import { POST as agentStreamRoute } from "@/app/api/agent/stream/route";

const {
    mockRequireAuthenticatedUser,
    mockGraphStream,
    mockGovernorOnTokenChunk,
    mockGovernorSettle,
    mockDb,
} = vi.hoisted(() => ({
    mockRequireAuthenticatedUser: vi.fn(),
    mockGraphStream: vi.fn(),
    mockGovernorOnTokenChunk: vi.fn(),
    mockGovernorSettle: vi.fn(),
    mockDb: {
        query: {
            users: { findFirst: vi.fn() },
            files: { findFirst: vi.fn() },
            creditLedgerTransactions: { findFirst: vi.fn() },
            userVaultProfiles: { findFirst: vi.fn() },
        },
        insert: vi.fn(() => ({
            values: vi.fn(() => ({
                onConflictDoNothing: vi.fn(() => Promise.resolve()),
                returning: vi.fn(() => Promise.resolve([{ operationId: "res-new" }])),
            })),
        })),
        update: vi.fn(() => ({
            set: vi.fn(() => ({
                where: vi.fn(() => ({
                    returning: vi.fn(() => Promise.resolve([{ operationId: "tx-1" }])),
                })),
            })),
        })),
    },
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return {
        ...actual,
        after: vi.fn(),
    };
});

vi.mock("@/server/auth/session", () => ({
    requireAuthenticatedUser: mockRequireAuthenticatedUser,
}));

vi.mock("@/server/db", () => ({
    db: mockDb,
    schema: {
        users: { id: "id", creditBalanceMicro: "credit_balance_micro" },
        files: { id: "id", userId: "user_id", isEncrypted: "is_encrypted", deletedAt: "deleted_at" },
        creditLedgerTransactions: { operationId: "operation_id", userId: "user_id", status: "status", nodeName: "node_name" },
        userVaultProfiles: { userId: "user_id" },
    },
}));

vi.mock("@/server/db/transactional", () => ({
    txDb: null,
}));

vi.mock("@/lib/rate-limit", () => ({
    aiStreamRateLimiter: {
        limit: vi.fn().mockResolvedValue({ success: true, remaining: 10, reset: 60 }),
    },
    addRateLimitHeaders: vi.fn(),
    rateLimitExceededResponse: vi.fn(),
}));

vi.mock("@/core/agent/graph", () => ({
    elixentAgentGraph: {
        stream: mockGraphStream,
    },
}));

vi.mock("@/lib/metering/stream-governor", () => ({
    StreamGovernor: class MockStreamGovernor {
        onTokenChunk = mockGovernorOnTokenChunk;
        settle = mockGovernorSettle;
    },
}));

describe("Phase 11: Replay Attack Defense & Request Fingerprint Validation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRequireAuthenticatedUser.mockResolvedValue({ id: "user_test_replay" });
        mockGovernorOnTokenChunk.mockResolvedValue(true);
        mockGovernorSettle.mockResolvedValue({ status: "SETTLED" });
    });

    it("computes deterministic SHA-256 fingerprint from (userId, operation, fileId, text)", () => {
        const hash1 = computeRequestHash("u1", "agent_stream", "f1", "Hello World");
        const hash2 = computeRequestHash("u1", "agent_stream", "f1", "Hello World");
        expect(hash1).toBe(hash2);
        expect(hash1).toHaveLength(64);

        const hashDivergent = computeRequestHash("u1", "agent_stream", "f1", "Hello Divergent");
        expect(hash1).not.toBe(hashDivergent);

        const hashUser = computeRequestHash("u2", "agent_stream", "f1", "Hello World");
        expect(hash1).not.toBe(hashUser);

        const hashOp = computeRequestHash("u1", "document_writer", "f1", "Hello World");
        expect(hash1).not.toBe(hashOp);
    });

    it("rejects reservation when operationId is reused with a divergent requestHash", async () => {
        const operationId = "op-replay-1";
        const legitimateHash = computeRequestHash("u1", "agent_stream", "f1", "Original Text");
        const maliciousHash = computeRequestHash("u1", "agent_stream", "f1", "Tampered Text");

        mockDb.query.creditLedgerTransactions.findFirst.mockResolvedValueOnce({
            operationId,
            userId: "u1",
            nodeName: `reserved:agent_stream:${legitimateHash}:10`,
            status: "SETTLED",
        });

        const result = await reserveAIQuota("u1", "agent_stream", 10, "free", {
            operationId,
            fileId: "f1",
            requestHash: maliciousHash,
        });

        expect(result.reserved).toBe(false);
        expect(result.isReplayConflict).toBe(true);
        expect(result.reason).toContain("Replay attack detected");
    });

    it("rejects reservation when operationId belongs to a different user", async () => {
        const operationId = "op-cross-user-replay";
        const requestHash = computeRequestHash("u2", "agent_stream", "f1", "Text");

        mockDb.query.creditLedgerTransactions.findFirst.mockResolvedValueOnce({
            operationId,
            userId: "u1",
            nodeName: `reserved:agent_stream:${requestHash}:10`,
            status: "SETTLED",
        });

        const result = await reserveAIQuota("u2", "agent_stream", 10, "free", {
            operationId,
            fileId: "f1",
            requestHash,
        });

        expect(result.reserved).toBe(false);
        expect(result.isReplayConflict).toBe(true);
        expect(result.reason).toContain("belongs to another account");
    });

    it("mints fresh server-side operationId per POST /api/agent/stream invocation and prevents client operationId spoofing", async () => {
        mockGraphStream.mockImplementation(async () =>
            (async function* () {
                yield { document_writer_node: { text: "chunk" } };
            })()
        );

        const req1 = new NextRequest("http://localhost/api/agent/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threadId: "thread_replay_1",
                projectId: "proj_1",
                targetFileIds: ["f_test"],
                prompt: "First request",
            }),
        });
        const req2 = new NextRequest("http://localhost/api/agent/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threadId: "thread_replay_1",
                projectId: "proj_1",
                targetFileIds: ["f_test"],
                prompt: "Second request",
            }),
        });

        const res1 = await agentStreamRoute(req1);
        const res2 = await agentStreamRoute(req2);
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        const text1 = await res1.text();
        const text2 = await res2.text();

        const opMatch1 = text1.match(/"operationId":"(op_[^"]+)"/);
        const opMatch2 = text2.match(/"operationId":"(op_[^"]+)"/);
        expect(opMatch1?.[1]).toBeDefined();
        expect(opMatch2?.[1]).toBeDefined();
        expect(opMatch1?.[1]).not.toBe(opMatch2?.[1]);
    });
});
