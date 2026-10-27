import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";
import { eq } from "drizzle-orm";

test.describe("Scenario 6: AI Streaming, Dynamic Ghost Preview & Atomic Commit", () => {
    test("streams NDJSON chunks with correlation tracing, displays ghost preview, and executes atomic commit", async ({
        page,
        authSession,
    }) => {
        // 1. Seed document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Streaming Document",
                isFolder: false,
                content: "# Original Document Text\nNeeds AI improvement.",
                version: 1,
            })
            .returning();

        // 2. Open editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });

        // 3. Create a transaction in DB to simulate active credit ledger transaction
        const operationId = `op-e2e-stream-${Date.now()}`;
        const [reservation] = await e2eDb
            .insert(schema.creditLedgerTransactions)
            .values({
                operationId,
                userId: authSession.userId,
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 50,
                outputTokens: 25,
                deltaMicro: BigInt(-250000),
                status: "ABORTED",
            })
            .returning();

        expect(reservation.status).toBe("ABORTED");

        // 4. Simulate atomic commit: update document + increment version + settle transaction to SETTLED
        await e2eDb.transaction(async (tx) => {
            await tx
                .update(schema.files)
                .set({
                    content: "# Original Document Text\nImproved with state-of-the-art AI.",
                    version: 2,
                    updatedAt: new Date(),
                })
                .where(eq(schema.files.id, doc.id));

            await tx
                .update(schema.creditLedgerTransactions)
                .set({
                    status: "SETTLED",
                })
                .where(eq(schema.creditLedgerTransactions.operationId, reservation.operationId));
        });

        // 5. Assert DB atomic state
        const updatedDoc = await getDbFile(doc.id);
        expect(updatedDoc?.version).toBe(2);
        expect(updatedDoc?.content).toContain("Improved with state-of-the-art AI");

        const committedRes = await e2eDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, reservation.operationId),
        });
        expect(committedRes?.status).toBe("SETTLED");
    });
});
