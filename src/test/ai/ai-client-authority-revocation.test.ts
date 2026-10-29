import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import * as aiCommitActions from "@/server/actions/ai-commit";
import * as aiOpsActions from "@/server/actions/ai-ops";
import { POST as streamRouteHandler } from "@/app/api/ai/stream/route";
import { getUser } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(),
}));

describe("Phase 11: Revocation of Client-Side Financial Authority", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getUser).mockResolvedValue(null);
    });

    it("ensures refundAIReservation is NOT exported from ai-commit Server Actions", () => {
        expect("refundAIReservation" in aiCommitActions).toBe(false);
    });

    it("ensures refundAIReservation, commitAIReservation, and reserveAndUpdateUsage are NOT exported from ai-ops Server Actions", () => {
        expect("refundAIReservation" in aiOpsActions).toBe(false);
        expect("commitAIReservation" in aiOpsActions).toBe(false);
        expect("reserveAndUpdateUsage" in aiOpsActions).toBe(false);
        expect("reserveAIQuota" in aiOpsActions).toBe(false);
    });

    it("runtime invocation: rejects unauthorized client reservation attempts at /api/ai/stream with HTTP 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/ai/stream", {
            method: "POST",
            body: JSON.stringify({
                operation: "correct",
                text: "Unauthorized reservation probe",
                tier: "free",
            }),
        });

        const res = await streamRouteHandler(req);
        expect(res.status).toBe(401);
        expect(await res.text()).toBe("Unauthorized");
    });

    it("runtime invocation: rejects unauthorized access to reservation status and commit Server Actions", async () => {
        // Unauthenticated client cannot inspect reservation status
        const statusRes = await aiOpsActions.getAIReservationStatus("op_unauthorized_probe");
        expect(statusRes).toEqual({ found: false, reason: "unauthorized" });

        // Unauthenticated client cannot commit AI file operations
        const commitRes = await aiCommitActions.commitAIFileOperation({
            operationId: "op_unauthorized_probe",
            fileId: "file_unauth",
            expectedVersion: 1,
            resultContent: "tampered content",
        });
        expect(commitRes.success).toBe(false);
        expect(commitRes.status).toBe("unauthorized");
    });
});
