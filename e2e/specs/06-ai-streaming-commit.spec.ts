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

        // 3. Prepare credit ledger reservation and mock stream endpoint (SSE /api/agent/stream)
        let reqOpId = `op-e2e-stream-${Date.now()}`;
        const handleMockStream = async (route: any) => {
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

            const sseBody = [
                `event: start\ndata: ${JSON.stringify({ type: "start", sessionId: `sess_${Date.now()}`, threadId: doc.id, operationId: reqOpId })}\n\n`,
                `event: update\ndata: ${JSON.stringify({
                    type: "update",
                    chunk: {
                        hunks: [
                            {
                                hunkId: "hunk_1",
                                headingSlug: "original-document-text",
                                replacementText: "# Original Document Text\nImproved with state-of-the-art AI.",
                                status: "preview_ready",
                            },
                        ],
                    },
                })}\n\n`,
                `event: done\ndata: ${JSON.stringify({ type: "done", threadId: doc.id, operationId: reqOpId })}\n\n`,
            ].join("");

            await route.fulfill({
                status: 200,
                contentType: "text/event-stream",
                headers: {
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                },
                body: sseBody,
            });
        };

        await page.route("**/api/agent/stream", handleMockStream);
        await page.route("**/api/ai/stream", handleMockStream);

        // 4. Drive AI prompt submission from the UI (Phase 11 Architectural Agent panel)
        const agentToggle = page.getByTestId("ai-toolbar-agent-toggle");
        await expect(agentToggle).toBeVisible({ timeout: 10000 });
        await agentToggle.click();

        const promptInput = page.getByTestId("agent-prompt-input");
        await expect(promptInput).toBeVisible({ timeout: 10000 });
        await promptInput.fill("Improve document with AI");

        const startButton = page.getByTestId("agent-start-button");
        await expect(startButton).toBeVisible();
        await startButton.click();

        // 5. Assert dynamic ghost preview rendering
        const ghostPreview = page.locator(".cm-ai-ghost-text").or(page.getByTestId("agent-ghost-review-bar"));
        await expect(ghostPreview.first()).toBeVisible({ timeout: 15000 });

        // 6. Execute atomic commit via UI action (AIToolbar or AgentChatPanel)
        const applyCommitButton = page.getByTestId("ai-toolbar-accept-all").or(page.getByTestId("agent-accept-all-hunks"));
        await expect(applyCommitButton.first()).toBeVisible({ timeout: 10000 });
        await applyCommitButton.first().click();

        // 7. Assert ghost preview closes and editor contains committed text
        await expect(page.locator(".cm-ai-ghost-text")).toBeHidden({ timeout: 10000 });
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
