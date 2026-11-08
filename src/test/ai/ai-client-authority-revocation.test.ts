import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleAgentStreamPost as agentStreamRoute } from "@/server/routes/agent.routes";
import { getAIReservationStatus } from "@/server/services/ai-settlement-service";
import { updateFileContent } from "@/server/actions/files";
import { getUser } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(),
}));

vi.mock("@/server/db", () => ({
    db: {
        query: {
            creditLedgerTransactions: {
                findFirst: vi.fn(),
            },
            files: {
                findFirst: vi.fn(),
            },
        },
    },
    schema: {
        creditLedgerTransactions: {
            operationId: "operation_id",
        },
        files: {
            id: "id",
            userId: "user_id",
            deletedAt: "deleted_at",
        },
    },
}));

describe("Phase 11 & Wave 12.2: Revocation of Client-Side Financial Authority & Legacy 5-Op Surface", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getUser).mockResolvedValue(null);
    });

    it("verifies all 7 legacy 5-operation modules are permanently removed from the codebase", () => {
        const retiredRelativePaths = [
            "src/lib/ai/prompts.ts",
            "src/server/actions/ai-ops.ts",
            "src/server/actions/ai-commit.ts",
            "src/lib/ai/pending-operation-store.ts",
            "src/lib/ai/quota-settlement-reducer.ts",
            "src/lib/ai/preview-buffer.ts",
            "src/app/api/ai/stream/route.ts",
        ];

        for (const relPath of retiredRelativePaths) {
            const fullPath = path.resolve(process.cwd(), relPath);
            expect(fs.existsSync(fullPath), `Expected ${relPath} to be deleted`).toBe(false);
        }
    });

    it("verifies client RPC client does not export sensitive server-side financial functions", async () => {
        const rpcClient = await import("@/client/rpc-client");
        expect((rpcClient as Record<string, unknown>).reserveAIQuota).toBeUndefined();
        expect((rpcClient as Record<string, unknown>).commitAIReservation).toBeUndefined();
        expect((rpcClient as Record<string, unknown>).flushPendingSettlementsToPostgres).toBeUndefined();
        const legacyAiStreamRoute = path.resolve(process.cwd(), "src/app/api/ai/stream/route.ts");
        expect(fs.existsSync(legacyAiStreamRoute)).toBe(false);
    });

    it("runtime invocation: rejects unauthenticated client stream attempts at POST /api/agent/stream with HTTP 401", async () => {
        const req = new Request("http://localhost:3000/api/agent/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threadId: "thread_unauth_probe",
                projectId: "proj_unauth",
                targetFileIds: ["file_unauth"],
                prompt: "Unauthorized reservation probe",
            }),
        });

        const res = await agentStreamRoute(req);
        expect(res.status).toBe(401);
        const problem = await res.json();
        expect(problem.status).toBe(401);
        expect(problem.title).toBe("Unauthorized");
    });

    it("runtime invocation: rejects unauthenticated file content mutation and cross-user reservation status reads", async () => {
        const saveRes = await updateFileContent("file_unauth", "tampered content", {
            expectedVersion: 1,
        });
        expect(saveRes.success).toBe(false);
        expect(saveRes.status).toBe("unauthorized");

        const statusRes = await getAIReservationStatus("op_unknown_probe", "user_unauth");
        expect(statusRes).toEqual({ found: false, reason: "not_found" });
    });
});
