import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, cleanupE2EUser } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 15: Cross-User Tenant Isolation & 404 Anti-Enumeration", () => {
    test("foreign tenant document access should be blocked with redirect and 404 anti-enumeration masking", async ({
        page,
        authSession: _authSession,
    }) => {
        // 1. Seed a foreign user and their private file
        const foreignUserId = "99988888-8888-8888-8888-888888888888";
        const foreignEmail = "foreign-tenant@lugx.test";

        await e2eDb
            .insert(schema.users)
            .values({
                id: foreignUserId,
                email: foreignEmail,
                displayName: "Foreign Tenant",
                tier: "pro",
            })
            .onConflictDoUpdate({
                target: schema.users.id,
                set: { displayName: "Foreign Tenant", updatedAt: new Date() },
            });

        const [foreignDoc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: foreignUserId,
                title: "Foreign Top Secret",
                isFolder: false,
                content: "# Secret belonging exclusively to Tenant B",
                version: 1,
            })
            .returning();

        try {
            // 2. Authenticated user A attempts to open foreign file via direct URL navigation
            await page.goto(`/workspace/editor/${foreignDoc.id}`);
            await page.waitForLoadState("domcontentloaded");

            // Verify that hydration enters fatal error state, editor is not rendered, and foreign content is never leaked
            const fatalHeading = page.getByRole("heading", { name: "تعذّر فتح المستند" });
            await expect(fatalHeading).toBeVisible({ timeout: 15000 });
            await expect(page.locator(".cm-content")).toBeHidden();
            await expect(page.getByText("Secret belonging exclusively to Tenant B")).toBeHidden();

            // Clicking return button navigates safely back to workspace
            const returnBtn = page.getByRole("button", { name: "العودة إلى مساحة العمل" });
            await expect(returnBtn).toBeVisible();
            await returnBtn.click();
            await expect(page).toHaveURL(/\/workspace(?!\/editor)/, { timeout: 10000 });

            // 3. User A attempts programmatic API access to foreign file
            const apiRes = await page.request.get(`/api/files/${foreignDoc.id}`);
            expect(apiRes.status()).toBe(404);

            const json = await apiRes.json();
            expect(json.error).toBe("File not found");
            expect(apiRes.headers()["x-correlation-id"]).toBeDefined();
        } finally {
            // Clean up foreign user
            await cleanupE2EUser(foreignUserId);
        }
    });
});
