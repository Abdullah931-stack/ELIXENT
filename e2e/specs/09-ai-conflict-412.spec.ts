import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile, simulateRemoteFileUpdate } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 10: AI Concurrent Edit Collision (412 Precondition Failed)", () => {
    test("concurrent remote edit during AI stream should trigger 412 conflict and preserve remote content", async ({
        page,
        authSession,
    }) => {
        test.setTimeout(90000);

        // 1. Seed document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Collision Document",
                isFolder: false,
                content: "# Version 1 Original",
                version: 1,
            })
            .returning();

        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });
        await expect(cmContent).toContainText("Version 1 Original", { timeout: 20000 });

        // 2. Mock AI stream to produce a pending preview
        let operationId = `op-e2e-collision-${Date.now()}`;
        await e2eDb
            .insert(schema.creditLedgerTransactions)
            .values({
                operationId,
                userId: authSession.userId,
                threadId: doc.id,
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 50,
                outputTokens: 25,
                deltaMicro: BigInt(-250000),
                status: "SETTLED",
            });

        await page.route("**/api/ai/stream", async (route) => {
            try {
                const postData = JSON.parse(route.request().postData() || "{}");
                if (postData.operationId) {
                    operationId = postData.operationId;
                    await e2eDb
                        .insert(schema.creditLedgerTransactions)
                        .values({
                            operationId,
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
                JSON.stringify({ type: "meta", operationId, model: "google/gemini-2.5-flash" }),
                JSON.stringify({ type: "chunk", text: "# Conflicting AI Rewrite" }),
                JSON.stringify({ type: "done" }),
            ].join("\n") + "\n";

            await route.fulfill({
                status: 200,
                contentType: "application/x-ndjson",
                body: ndjson,
            });
        });

        // 3. Trigger AI stream in UI
        const improveBtn = page.getByRole("button", { name: "Improve" });
        await expect(improveBtn).toBeVisible();
        await improveBtn.click();

        const ghostPreview = page.locator(".cm-ai-ghost-text");
        await expect(ghostPreview).toBeVisible({ timeout: 10000 });
        await expect(ghostPreview).toContainText("Conflicting AI Rewrite");

        // 4. Simulate concurrent remote save in another tab (increments server version past client expectedVersion)
        const preUpdateDoc = await getDbFile(doc.id);
        const conflictingServerVersion = (preUpdateDoc?.version ?? 1) + 1;
        await simulateRemoteFileUpdate(
            doc.id,
            "# Version Sibling Tab Modification",
            conflictingServerVersion
        );

        // 5. Attempt commit on stale version in UI (sends stale expectedVersion against incremented server version)
        const applyCommitBtn = page.getByRole("button", { name: "تطبيق التعديل" });
        await expect(applyCommitBtn).toBeVisible();
        await applyCommitBtn.click();

        // 6. Assert 412 Precondition Failed UI notification
        const conflictAlert = page.getByText(/تم تعديل الملف من جلسة أخرى أثناء المعالجة/).first();
        await expect(conflictAlert).toBeVisible({ timeout: 35000 });

        // 7. Verify authoritative remote content was NOT overwritten
        const currentDbDoc = await getDbFile(doc.id);
        expect(currentDbDoc?.version).toBe(conflictingServerVersion);
        expect(currentDbDoc?.content).toBe("# Version Sibling Tab Modification");

        // Reload editor: the editor safely reconciles and renders the authoritative remote content
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await expect(cmContent).toContainText("Version Sibling Tab Modification", { timeout: 20000 });
    });
});
