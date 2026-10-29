import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 9: System AI Provider Failure (Full Refund Policy)", () => {
    test("upstream provider 500 failure should display error banner and preserve document content", async ({
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

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });
        await expect(cmContent).toContainText("Text awaiting AI refinement", { timeout: 20000 });

        // 3. Trigger AI operation from UI
        const improveBtn = page.getByRole("button", { name: "Improve" });
        await expect(improveBtn).toBeVisible();
        await improveBtn.click();

        // 4. Assert UI error alert is displayed
        const errorAlert = page.getByText(/حدث خطأ أثناء معالجة النص|Upstream AI service/).first();
        await expect(errorAlert).toBeVisible({ timeout: 10000 });

        // 5. Verify document content is preserved completely
        await expect(cmContent).toContainText("Text awaiting AI refinement");
        const currentDoc = await getDbFile(doc.id);
        expect(currentDoc?.content).toBe("# Text awaiting AI refinement");
        expect(currentDoc?.version).toBe(1);
    });
});
