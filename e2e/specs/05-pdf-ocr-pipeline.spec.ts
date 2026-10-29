import { test, expect } from "../fixtures/auth-fixture";

test.describe("Scenario 5: Client-Side Document Ingestion & Import Pipeline", () => {
    test("document ingestion in workspace sidebar should render an enabled import button", async ({
        page,
        authSession: _authSession,
    }) => {
        // 1. Navigate to workspace
        await page.goto("/workspace");
        await page.waitForLoadState("domcontentloaded");

        // 2. Verify import button is present and enabled in sidebar
        const importBtn = page.getByRole("button", { name: "Import Files" });
        await expect(importBtn).toBeVisible();
        await expect(importBtn).toBeEnabled();
    });
});
