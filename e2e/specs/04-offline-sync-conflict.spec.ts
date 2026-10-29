import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile, simulateRemoteFileUpdate } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 4: Offline-First Sync & Interactive Conflict Resolution", () => {
    test("offline concurrent edit should trigger conflict dialog and persist local resolution", async ({
        page,
        context,
        authSession,
    }) => {
        // 1. Seed document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Sync Conflict Document",
                isFolder: false,
                content: "# Line 1: Original Title\nLine 2: Base content\nLine 3: Tail",
                version: 1,
            })
            .returning();

        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });
        await expect(cmContent).toContainText("Original Title");

        // 2. Go offline
        await context.setOffline(true);

        // 3. Concurrently update document on server directly with version 2
        await simulateRemoteFileUpdate(
            doc.id,
            "# Line 1: Server Remote Edit Conflicting\nLine 2: Base content\nLine 3: Tail",
            2
        );

        // 4. In the UI, perform offline edit on the same line to force true 3-way conflict
        await cmContent.click();
        await page.keyboard.press("Home");
        await page.keyboard.type("Client Local Edit - ");

        // 5. Restore online state and trigger save
        await context.setOffline(false);
        await page.keyboard.type(" ");

        // 6. Assert Conflict Dialog / Resolution UI path
        const conflictHeading = page.getByText("تعارض في التزامن");
        const reviewBtn = page.getByRole("button", { name: "مراجعة وحل التعارض" });
        await expect(conflictHeading.or(reviewBtn)).toBeVisible({ timeout: 25000 });

        if (await reviewBtn.isVisible()) {
            await reviewBtn.click();
        }
        await expect(conflictHeading).toBeVisible({ timeout: 10000 });

        // 7. Select resolution strategy and confirm resolution
        const keepLocalBtn = page.getByRole("button", { name: "اعتماد النسخة المحلية" });
        await expect(keepLocalBtn).toBeVisible();
        await keepLocalBtn.click();

        const confirmBtn = page.getByRole("button", { name: "تأكيد وحفظ الحل في الخادم" });
        await expect(confirmBtn).toBeVisible();
        await confirmBtn.click();

        // 8. Assert dialog closed and DB state reflects resolved merge
        await expect(conflictHeading).toBeHidden({ timeout: 10000 });

        const resolvedDoc = await getDbFile(doc.id);
        expect(resolvedDoc?.version).toBeGreaterThan(1);
        expect(resolvedDoc?.content).toContain("Client Local Edit");
    });
});
