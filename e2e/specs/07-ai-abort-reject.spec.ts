import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenarios 7 & 8: User AI Abort and Preview Reject (Browser User Journeys)", () => {
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

        // 1. Intercept stream to simulate slow continuous generation
        await page.route("**/api/ai/stream", async (route) => {
            await page.waitForTimeout(1000);
            const ndjson = [
                JSON.stringify({ type: "meta", operationId: `op-abort-${Date.now()}`, model: "google/gemini-2.5-flash" }),
                JSON.stringify({ type: "chunk", text: "# Partial text that should be cancelled" }),
            ].join("\n") + "\n";

            await route.fulfill({
                status: 200,
                contentType: "application/x-ndjson",
                body: ndjson,
            });
        });

        // 2. Open editor in browser
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });
        await expect(cmContent).toContainText("Original Unaltered Content", { timeout: 20000 });

        // 3. Trigger AI Improve
        const improveBtn = page.getByRole("button", { name: "Improve" });
        await expect(improveBtn).toBeVisible();
        await improveBtn.click();

        // 4. Abort stream via UI (Stop or Cancel button)
        const stopBtn = page.getByRole("button", { name: /Stop|إيقاف/ }).or(page.getByText("إلغاء"));
        await expect(stopBtn.first()).toBeVisible({ timeout: 5000 });
        await stopBtn.first().click();
        await expect(stopBtn.first()).toBeHidden({ timeout: 5000 });

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
        await page.route("**/api/ai/stream", async (route) => {
            const ndjson = [
                JSON.stringify({ type: "meta", operationId: `op-reject-${Date.now()}`, model: "google/gemini-2.5-flash" }),
                JSON.stringify({ type: "chunk", text: "# Unwanted AI Proposal" }),
                JSON.stringify({ type: "done" }),
            ].join("\n") + "\n";

            await route.fulfill({
                status: 200,
                contentType: "application/x-ndjson",
                body: ndjson,
            });
        });

        // 2. Open editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });
        await expect(cmContent).toContainText("Safe Baseline Text", { timeout: 20000 });

        // 3. Trigger AI Improve
        const improveBtn = page.getByRole("button", { name: "Improve" });
        await expect(improveBtn).toBeVisible();
        await improveBtn.click();

        // 4. Ghost preview appears
        const ghostPreview = page.locator(".cm-ai-ghost-text");
        await expect(ghostPreview).toBeVisible({ timeout: 10000 });
        await expect(ghostPreview).toContainText("Unwanted AI Proposal");

        // 5. Reject preview in UI
        const rejectBtn = page.getByText("رفض").or(page.getByRole("button", { name: /رفض|Reject/ }));
        await expect(rejectBtn.first()).toBeVisible({ timeout: 5000 });
        await rejectBtn.first().click();

        // 6. Verify preview is discarded and original text remains intact
        await expect(ghostPreview).not.toBeVisible();
        await expect(cmContent).toContainText("Safe Baseline Text");

        const currentDoc = await getDbFile(doc.id);
        expect(currentDoc?.content).toBe("# Safe Baseline Text");
        expect(currentDoc?.version).toBe(1);
    });
});

