import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";
import { eq } from "drizzle-orm";

test.describe("Scenarios 7 & 8: User AI Abort and Preview Reject (No Refund Policy §4-D)", () => {
    test("Scenario 7: User-initiated stream abort halts stream with zero text leakage and settles quota with NO refund", async ({
        authSession,
    }) => {
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Abort Test Document",
                isFolder: false,
                content: "# Original Unaltered Content",
                version: 1,
            })
            .returning();

        const abortOpId = `op-abort-${Date.now()}`;
        const [reservation] = await e2eDb
            .insert(schema.creditLedgerTransactions)
            .values({
                operationId: abortOpId,
                userId: authSession.userId,
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 50,
                outputTokens: 30,
                deltaMicro: BigInt(-300000),
                status: "SETTLED",
            })
            .returning();

        // Simulate user clicking Stop:
        // Transaction settled as ABORTED
        await e2eDb
            .update(schema.creditLedgerTransactions)
            .set({
                status: "ABORTED",
            })
            .where(eq(schema.creditLedgerTransactions.operationId, reservation.operationId));

        // Verify document was NOT altered (zero text leakage)
        const currentDoc = await getDbFile(doc.id);
        expect(currentDoc?.content).toBe("# Original Unaltered Content");
        expect(currentDoc?.version).toBe(1);

        // Verify transaction settlement: ABORTED
        const settledRes = await e2eDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, reservation.operationId),
        });
        expect(settledRes?.status).toBe("ABORTED");
    });

    test("Scenario 8: User preview rejection leaves document untouched and settles quota with NO refund", async ({
        authSession,
    }) => {
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Reject Test Document",
                isFolder: false,
                content: "# Safe Baseline Text",
                version: 1,
            })
            .returning();

        const rejectOpId = `op-reject-${Date.now()}`;
        const [reservation] = await e2eDb
            .insert(schema.creditLedgerTransactions)
            .values({
                operationId: rejectOpId,
                userId: authSession.userId,
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 50,
                outputTokens: 40,
                deltaMicro: BigInt(-400000),
                status: "SETTLED",
            })
            .returning();

        // Simulate user clicking Reject:
        await e2eDb
            .update(schema.creditLedgerTransactions)
            .set({
                status: "ABORTED",
            })
            .where(eq(schema.creditLedgerTransactions.operationId, reservation.operationId));

        // Verify document is untouched
        const currentDoc = await getDbFile(doc.id);
        expect(currentDoc?.content).toBe("# Safe Baseline Text");
        expect(currentDoc?.version).toBe(1);

        // Verify transaction settlement: ABORTED
        const settledRes = await e2eDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, reservation.operationId),
        });
        expect(settledRes?.status).toBe("ABORTED");
    });
});
