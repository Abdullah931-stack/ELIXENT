import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 6: AI Streaming, Dynamic Ghost Preview & Atomic Commit", () => {
    test("AI streaming response should display ghost preview and persist upon atomic commit", async ({
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
        await expect(cmContent).toContainText("Original Document Text", { timeout: 20000 });

        // 3. Prepare credit ledger reservation and mock stream endpoint
        let reqOpId = `op-e2e-stream-${Date.now()}`;
        await page.route("**/api/ai/stream", async (route) => {
            try {
                const postData = JSON.parse(route.request().postData() || "{}");
                if (postData.operationId) {
                    reqOpId = postData.operationId;
                    await e2eDb
                        .insert(schema.creditLedgerTransactions)
                        .values({
                            operationId: reqOpId,
                            userId: authSession.userId,
                            threadId: doc.id,
                            modelId: "google/gemini-2.5-flash",
                            executionMode: "STREAMING_GENERATIVE",
                            inputTokens: 50,
                            outputTokens: 25,
                            deltaMicro: BigInt(-250000),
                            status: "SETTLED",
                        })
                        .onConflictDoNothing();
                }
            } catch {
                // ignore
            }

            const ndjson = [
                JSON.stringify({ type: "meta", operationId: reqOpId, model: "google/gemini-2.5-flash" }),
                JSON.stringify({ type: "chunk", text: "# Original Document Text\nImproved with state-of-the-art AI." }),
                JSON.stringify({ type: "done" }),
            ].join("\n") + "\n";

            await route.fulfill({
                status: 200,
                contentType: "application/x-ndjson",
                body: ndjson,
            });
        });

        // 4. Drive AI prompt submission from the UI
        const improveButton = page.getByRole("button", { name: "Improve" });
        await expect(improveButton).toBeVisible();
        await improveButton.click();

        // 5. Assert dynamic ghost preview rendering
        const ghostPreview = page.locator(".cm-ai-ghost-text");
        await expect(ghostPreview).toBeVisible({ timeout: 10000 });
        await expect(ghostPreview).toContainText("Improved with state-of-the-art AI");

        // 6. Execute atomic commit via UI action
        const applyCommitButton = page.getByRole("button", { name: "تطبيق التعديل" });
        await expect(applyCommitButton).toBeVisible();
        await applyCommitButton.click();

        // 7. Assert ghost preview closes and editor contains committed text
        await expect(ghostPreview).toBeHidden({ timeout: 10000 });
        await expect(cmContent).toContainText("Improved with state-of-the-art AI");

        // 8. Assert DB persistence matches atomic commit
        await expect.poll(async () => {
            const updated = await getDbFile(doc.id);
            return updated?.version;
        }, { timeout: 10000 }).toBeGreaterThan(1);

        const updatedDoc = await getDbFile(doc.id);
        expect(updatedDoc?.content).toContain("Improved with state-of-the-art AI");
    });
});
