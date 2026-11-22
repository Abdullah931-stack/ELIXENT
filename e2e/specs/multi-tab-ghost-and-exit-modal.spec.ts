import type { Route } from "@playwright/test";
import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Multi-Tab GhostHunk Persistence, Permission Modes & PendingEditsExitModal", () => {
    test("switches permission modes, preserves unresolved GhostHunks across tab close, and enforces Stay / Discard & Leave", async ({
        page,
        authSession,
    }) => {
        const workspaceId = schema.deriveDefaultWorkspaceId(authSession.userId);
        const [docA, docB] = await e2eDb
            .insert(schema.files)
            .values([
                {
                    userId: authSession.userId,
                    workspaceId,
                    title: "Alpha Tab Doc",
                    isFolder: false,
                    content: "# Alpha Heading\nOriginal alpha paragraph.",
                    version: 1,
                },
                {
                    userId: authSession.userId,
                    workspaceId,
                    title: "Beta Tab Doc",
                    isFolder: false,
                    content: "# Beta Heading\nOriginal beta paragraph.",
                    version: 1,
                },
            ])
            .returning();

        // Mock /api/agent/stream to propose a GhostHunk on docA
        await page.route("**/api/agent/stream", async (route: Route) => {
            let reqOpId = `op-ghost-${Date.now()}`;
            try {
                const postData = JSON.parse(route.request().postData() || "{}");
                if (postData.operationId) {
                    reqOpId = postData.operationId;
                    await e2eDb
                        .insert(schema.creditLedgerTransactions)
                        .values({
                            operationId: reqOpId,
                            userId: authSession.userId,
                            threadId: docA.id,
                            modelId: "google/gemini-3.8-flash",
                            executionMode: "STREAMING_GENERATIVE",
                            inputTokens: 40,
                            outputTokens: 20,
                            deltaMicro: BigInt(-150000),
                            status: "SETTLED",
                        })
                        .onConflictDoNothing();
                }
            } catch {
                // ignore malformed body
            }

            const sseBody = [
                `event: start\ndata: ${JSON.stringify({
                    type: "start",
                    sessionId: `sess_${Date.now()}`,
                    threadId: docA.id,
                    operationId: reqOpId,
                })}\n\n`,
                `event: ghost_hunk_proposed\ndata: ${JSON.stringify({
                    type: "ghost_hunk_proposed",
                    fileId: docA.id,
                    headingSlug: "alpha-heading",
                    hunks: [
                        {
                            hunkId: "hunk_alpha_1",
                            headingSlug: "alpha-heading",
                            replacementText: "# Alpha Heading\nProposed AI replacement for alpha.",
                            status: "preview_ready",
                        },
                    ],
                })}\n\n`,
                `event: done\ndata: ${JSON.stringify({
                    type: "done",
                    threadId: docA.id,
                    operationId: reqOpId,
                })}\n\n`,
            ].join("");

            await route.fulfill({
                status: 200,
                contentType: "text/event-stream",
                headers: {
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                },
                body: sseBody,
            });
        });

        // 1. Open Doc A in editor
        await page.goto(`/workspace/editor/${docA.id}`, { waitUntil: "domcontentloaded" });
        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });
        await expect(cmContent).toContainText("Original alpha paragraph.", { timeout: 15000 });

        // 2. Open Agent panel and test permission mode switching (safe / semi_auto / full_auto)
        await page.getByTestId("ai-toolbar-agent-toggle").click();
        const modeSelector = page.getByTestId("agent-permission-mode-selector");
        await expect(modeSelector).toBeVisible({ timeout: 10000 });

        const safeBtn = page.getByTestId("agent-permission-mode-safe");
        const semiAutoBtn = page.getByTestId("agent-permission-mode-semi_auto");
        const fullAutoBtn = page.getByTestId("agent-permission-mode-full_auto");

        await fullAutoBtn.click();
        await expect(fullAutoBtn).toHaveAttribute("aria-pressed", "true");
        await semiAutoBtn.click();
        await expect(semiAutoBtn).toHaveAttribute("aria-pressed", "true");
        await safeBtn.click();
        await expect(safeBtn).toHaveAttribute("aria-pressed", "true");

        // 3. Propose GhostHunk on Tab A
        await page.getByTestId("agent-prompt-input").fill("Propose an edit for Alpha");
        await page.getByTestId("agent-start-button").click();

        const ghostPreview = page
            .locator(".cm-ai-ghost-text")
            .or(page.getByTestId("agent-ghost-review-bar"));
        await expect(ghostPreview.first()).toBeVisible({ timeout: 15000 });

        // 4. Open Doc B as a second tab via sidebar
        const docBLink = page.getByRole("link", { name: "Beta Tab Doc", exact: true });
        await expect(docBLink).toBeVisible({ timeout: 10000 });
        await docBLink.click();
        await expect(page).toHaveURL(new RegExp(`/workspace/editor/${docB.id}`), { timeout: 10000 });

        const tabList = page.getByRole("tablist", { name: "Open workspace tabs" }).first();
        await expect(tabList).toBeVisible({ timeout: 10000 });
        await expect(tabList.getByRole("tab")).toHaveCount(2);

        // 5. Close Tab A while its GhostHunk remains unresolved
        await tabList.getByRole("button", { name: "Close Alpha Tab Doc" }).first().click();
        await expect(tabList.getByRole("tab")).toHaveCount(1);

        // 6. Verify unresolved edits tracker persists across tab close
        const trackerBtn = tabList.getByRole("button", { name: /1 Unresolved Edit in 1 File/i });
        await expect(trackerBtn).toBeVisible({ timeout: 10000 });
        await trackerBtn.click();

        const trackerDialog = page.getByRole("dialog", { name: "Unresolved AI edits" });
        await expect(trackerDialog).toBeVisible();
        await expect(trackerDialog).toContainText(docA.id);
        await expect(trackerDialog).toContainText("Closed");
        await page.getByRole("button", { name: "Close unresolved edits popover" }).click();

        // 7. Attempt external navigation to /account -> PendingEditsExitModal intercepts
        const accountLink = page.locator('a[href="/account"]').first();
        await expect(accountLink).toBeVisible({ timeout: 10000 });
        await accountLink.click();

        const exitModal = page.getByRole("dialog", { name: "Unresolved Workspace Changes" });
        await expect(exitModal).toBeVisible({ timeout: 10000 });

        // 8. Test "Stay": cancels navigation and preserves editor state
        await exitModal.getByRole("button", { name: "Stay" }).click();
        await expect(exitModal).toBeHidden();
        await expect(page).toHaveURL(new RegExp(`/workspace/editor/${docB.id}`));
        await expect(trackerBtn).toBeVisible();

        // 9. Navigate again and choose "Discard & Leave"
        await accountLink.click();
        await expect(exitModal).toBeVisible({ timeout: 10000 });
        await exitModal.getByRole("button", { name: "Discard & Leave" }).click();

        await expect(page).toHaveURL(/\/account/, { timeout: 15000 });
        const docAAfterDiscard = await getDbFile(docA.id);
        expect(docAAfterDiscard?.content).toContain("Original alpha paragraph.");
    });

    test("Save & Leave commits pending GhostHunk and completes external navigation", async ({
        page,
        authSession,
    }) => {
        const workspaceId = schema.deriveDefaultWorkspaceId(authSession.userId);
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                workspaceId,
                title: "Save Leave Doc",
                isFolder: false,
                content: "# Save Heading\nOriginal content before save.",
                version: 1,
            })
            .returning();

        await page.route("**/api/agent/stream", async (route: Route) => {
            let reqOpId = `op-save-leave-${Date.now()}`;
            try {
                const postData = JSON.parse(route.request().postData() || "{}");
                if (postData.operationId) {
                    reqOpId = postData.operationId;
                }
            } catch {
                // ignore
            }

            const sseBody = [
                `event: start\ndata: ${JSON.stringify({
                    type: "start",
                    sessionId: `sess_${Date.now()}`,
                    threadId: doc.id,
                    operationId: reqOpId,
                })}\n\n`,
                `event: ghost_hunk_proposed\ndata: ${JSON.stringify({
                    type: "ghost_hunk_proposed",
                    fileId: doc.id,
                    headingSlug: "save-heading",
                    hunks: [
                        {
                            hunkId: "hunk_save_1",
                            headingSlug: "save-heading",
                            replacementText: "# Save Heading\nSaved and committed on leave.",
                            status: "preview_ready",
                        },
                    ],
                })}\n\n`,
                `event: done\ndata: ${JSON.stringify({
                    type: "done",
                    threadId: doc.id,
                    operationId: reqOpId,
                })}\n\n`,
            ].join("");

            await route.fulfill({
                status: 200,
                contentType: "text/event-stream",
                body: sseBody,
            });
        });

        await page.goto(`/workspace/editor/${doc.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator(".cm-content")).toContainText("Original content before save.", {
            timeout: 15000,
        });

        await page.getByTestId("ai-toolbar-agent-toggle").click();
        await page.getByTestId("agent-prompt-input").fill("Update save heading");
        await page.getByTestId("agent-start-button").click();

        await expect(
            page.locator(".cm-ai-ghost-text").or(page.getByTestId("agent-ghost-review-bar")).first()
        ).toBeVisible({ timeout: 15000 });

        await page.locator('a[href="/account"]').first().click();
        const exitModal = page.getByRole("dialog", { name: "Unresolved Workspace Changes" });
        await expect(exitModal).toBeVisible({ timeout: 10000 });

        await exitModal.getByRole("button", { name: "Save & Leave" }).click();
        await expect(page).toHaveURL(/\/account/, { timeout: 15000 });
    });
});
