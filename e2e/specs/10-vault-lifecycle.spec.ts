import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 11: Encrypted Vault Lifecycle & Zero-Knowledge Browser Journey", () => {
    test("user can view vault security in account and interact with unlock modal in editor", async ({
        page,
        authSession,
    }) => {
        // 1. Visit /account to verify Vault Security Card integration
        await page.goto("/account");
        await page.waitForLoadState("domcontentloaded");

        const vaultCardTitle = page.getByText("أمان الخزنة وموثوقية الأجهزة");
        await expect(vaultCardTitle).toBeVisible({ timeout: 15000 });

        // 2. Seed an encrypted document in database for the authenticated user
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Confidential Project Blueprint",
                isFolder: false,
                content: "enc:iv_lifecycle_123:tag_456:ciphertext_789",
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "mk-lifecycle-1",
                    salt: "salt-lifecycle",
                    iv: "iv_lifecycle_123",
                    kdfIterations: 600000,
                },
                version: 1,
            })
            .returning();

        // 3. Open encrypted document in editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        // 4. Modal automatically opens upon opening locked encrypted document (LUGX-047 invariant)
        const modalHeading = page.getByRole("heading", { name: "فتح قفل الخزنة المشفرة" });
        await expect(modalHeading).toBeVisible({ timeout: 15000 });

        // 5. Assert password input is rendered in the modal
        const passwordInput = page.getByPlaceholder("أدخل كلمة المرور...");
        await expect(passwordInput).toBeVisible();

        // 6. Dismiss modal via Cancel button to inspect locked background state
        const cancelBtn = page.getByRole("button", { name: "إلغاء" });
        await expect(cancelBtn).toBeVisible();
        await cancelBtn.click();
        await expect(modalHeading).toBeHidden({ timeout: 5000 });

        // 7. Verify locked state in background UI and manual unlock trigger
        const lockBanner = page.getByRole("heading", { name: "المستند مشفر ومحمي" });
        await expect(lockBanner).toBeVisible({ timeout: 10000 });

        const unlockBtn = page.getByRole("button", { name: "فتح قفل الخزنة" });
        await expect(unlockBtn).toBeVisible();
        await unlockBtn.click();
        await expect(modalHeading).toBeVisible({ timeout: 5000 });

        // 8. Verify zero plaintext or master keys leaked to localStorage
        const localStorageKeys = await page.evaluate(() => Object.keys(localStorage));
        const leakedKeys = localStorageKeys.filter((k) =>
            k.toLowerCase().includes("master_key") || k.toLowerCase().includes("private_key")
        );
        expect(leakedKeys).toHaveLength(0);
    });
});

