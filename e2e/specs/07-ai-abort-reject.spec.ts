import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenarios 7 & 8: User AI Abort and Preview Reject (Browser User Journeys)", () => {
    test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: "ignoreErrors" });
    });

    test("Scenario 7: User aborting AI stream in UI halts stream and preserves baseline document", async ({
        page,
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

        // 1. Intercept stream to simulate slow continuous generation using non-page-bound delay
        const handleAbortStream = async (route: any) => {
            try {
                const sseHeader = `event: start\ndata: ${JSON.stringify({ type: "start", sessionId: `sess_${Date.now()}`, threadId: doc.id, operationId: `op-abort-${Date.now()}` })}\n\n`;
                // Keep stream running with delayed chunks so client remains in active streaming state
                await new Promise((res) => setTimeout(res, 2000));
                await route.fulfill({
                    status: 200,
                    contentType: "text/event-stream",
                    body: sseHeader,
                });
            } catch {
                // Request aborted or page closed prior to fulfillment
            }
        };

        await page.route("**/api/agent/stream", handleAbortStream);
        await page.route("**/api/ai/stream", handleAbortStream);

        // 2. Open editor in browser
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 20000 });
        await expect(cmContent).toContainText("Original Unaltered Content", { timeout: 30000 });

        // 3. Trigger AI Agent from UI
        const agentToggle = page.getByTestId("ai-toolbar-agent-toggle");
        await expect(agentToggle).toBeVisible({ timeout: 10000 });
        await agentToggle.click();

        const promptInput = page.getByTestId("agent-prompt-input");
        await expect(promptInput).toBeVisible({ timeout: 10000 });
        await promptInput.fill("Partial text that should be cancelled");

        const startButton = page.getByTestId("agent-start-button");
        await expect(startButton).toBeVisible();
        await startButton.click();

        // 4. Abort stream via UI (Toolbar or Chat Panel Stop button)
        const stopBtn = page.getByTestId("ai-toolbar-stop-button").or(page.getByTestId("agent-stop-button"));
        await expect(stopBtn.first()).toBeVisible({ timeout: 10000 });
        await stopBtn.first().click();
        await expect(stopBtn.first()).toBeHidden({ timeout: 10000 });

        // 5. Verify document was NOT altered (zero text leakage in database)
        const currentDoc = await getDbFile(doc.id);
        expect(currentDoc?.content).toBe("# Original Unaltered Content");
        expect(currentDoc?.version).toBe(1);
    });

    test("Scenario 8: User preview rejection in UI discards proposal and retains baseline text", async ({
        page,
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

        // 1. Mock completed preview stream
        const handleRejectStream = async (route: any) => {
            try {
                const sseBody = [
                    `event: start\ndata: ${JSON.stringify({ type: "start", sessionId: `sess_${Date.now()}`, threadId: doc.id, operationId: `op-reject-${Date.now()}` })}\n\n`,
                    `event: update\ndata: ${JSON.stringify({
                        type: "update",
                        chunk: {
                            hunks: [
                                {
                                    hunkId: "hunk_reject_1",
                                    headingSlug: "safe-baseline-text",
                                    replacementText: "# Unwanted AI Proposal",
                                    status: "preview_ready",
                                },
                            ],
                        },
                    })}\n\n`,
                    `event: done\ndata: ${JSON.stringify({ type: "done", threadId: doc.id, operationId: `op-reject-${Date.now()}` })}\n\n`,
                ].join("");

                await route.fulfill({
                    status: 200,
                    contentType: "text/event-stream",
                    body: sseBody,
                });
            } catch {
                // Request aborted or page closed prior to fulfillment
            }
        };

        await page.route("**/api/agent/stream", handleRejectStream);
        await page.route("**/api/ai/stream", handleRejectStream);

        // 2. Open editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 20000 });
        await expect(cmContent).toContainText("Safe Baseline Text", { timeout: 30000 });

        // 3. Trigger AI Agent
        const agentToggle = page.getByTestId("ai-toolbar-agent-toggle");
        await expect(agentToggle).toBeVisible({ timeout: 10000 });
        await agentToggle.click();

        const promptInput = page.getByTestId("agent-prompt-input");
        await expect(promptInput).toBeVisible({ timeout: 10000 });
        await promptInput.fill("Generate unwanted proposal");

        const startButton = page.getByTestId("agent-start-button");
        await expect(startButton).toBeVisible();
        await startButton.click();

        // 4. Ghost preview appears
        const ghostPreview = page.locator(".cm-ai-ghost-text").or(page.getByTestId("agent-ghost-review-bar"));
        await expect(ghostPreview.first()).toBeVisible({ timeout: 15000 });

        // 5. Reject preview in UI (Toolbar or Chat Panel Reject button)
        const rejectBtn = page.getByTestId("ai-toolbar-reject-all").or(page.getByTestId("agent-reject-all-hunks"));
        await expect(rejectBtn.first()).toBeVisible({ timeout: 10000 });
        await rejectBtn.first().click();

        // 6. Verify preview is discarded and original text remains intact
        await expect(page.locator(".cm-ai-ghost-text")).toBeHidden({ timeout: 10000 });
        await expect(cmContent).toContainText("Safe Baseline Text");

        const currentDoc = await getDbFile(doc.id);
        expect(currentDoc?.content).toBe("# Safe Baseline Text");
        expect(currentDoc?.version).toBe(1);
    });
});

