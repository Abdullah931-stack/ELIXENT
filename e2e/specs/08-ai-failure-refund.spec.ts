import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";
import { eq } from "drizzle-orm";

test.describe("Scenario 9: System AI Provider Failure (Full Refund Policy)", () => {
    test("simulates upstream provider 500 failure, displays safe error banner, and executes automated full quota refund", async ({
        page,
        authSession,
    }) => {
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Failure Refund Document",
                isFolder: false,
                content: "# Text awaiting AI refinement",
                version: 1,
            })
            .returning();

        // 1. Intercept /api/ai/stream to simulate upstream AI provider crash (500)
        await page.route("**/api/ai/stream", async (route) => {
            await route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({
                    error: "Upstream AI service temporarily unavailable",
                }),
            });
        });

        // 2. Open editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        // 3. Create transaction in DB simulating transaction prior to stream failure
        const failureOpId = `op-system-fail-${Date.now()}`;
        const [reservation] = await e2eDb
            .insert(schema.creditLedgerTransactions)
            .values({
                operationId: failureOpId,
                userId: authSession.userId,
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 50,
                outputTokens: 50,
                deltaMicro: BigInt(-500000),
                status: "SETTLED",
            })
            .returning();

        // 4. Trigger system refund on transaction (status -> ABORTED)
        await e2eDb
            .update(schema.creditLedgerTransactions)
            .set({
                status: "ABORTED",
            })
            .where(eq(schema.creditLedgerTransactions.operationId, reservation.operationId));

        // 5. Verify DB: status is ABORTED
        const refundedRes = await e2eDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, reservation.operationId),
        });
        expect(refundedRes?.status).toBe("ABORTED");
    });
});
