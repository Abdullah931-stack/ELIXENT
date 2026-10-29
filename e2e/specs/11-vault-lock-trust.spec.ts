import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 12: Vault Inactivity Auto-Lock, Multi-Modal Unlock & Device Trust", () => {
    test("encrypted note should display lock indicator and maintain memory isolation", async ({
        page,
        authSession,
    }) => {
        // 1. Seed an encrypted document in database
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Locked Confidential Note",
                isFolder: false,
                content: "enc:iv_mock_123:auth_tag_456:ciphertext_789",
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "mk-1",
                    salt: "salt",
                    iv: "iv_mock_123",
                    kdfIterations: 600000,
                },
                version: 1,
            })
            .returning();

        // 2. Open editor in browser
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        // 3. Verify unlock modal automatically opens for locked encrypted note
        const passwordInput = page.getByPlaceholder("أدخل كلمة المرور...");
        await expect(passwordInput).toBeVisible({ timeout: 15000 });

        // 4. Test wrong password rejection in unlock modal
        await expect(passwordInput).toBeVisible({ timeout: 5000 });
        await passwordInput.fill("wrong-password-123");
        await page.getByRole("button", { name: /فتح القفل|فك القفل/ }).click();
        await expect(page.getByText(/غير صحيحة|فشل|تعذر/)).toBeVisible({ timeout: 5000 });

        // 5. Dismiss modal via Cancel button and verify locked background state
        const cancelBtn = page.getByRole("button", { name: "إلغاء" });
        await cancelBtn.click();
        await expect(passwordInput).toBeHidden({ timeout: 5000 });

        const lockBanner = page.getByRole("heading", { name: "المستند مشفر ومحمي" });
        await expect(lockBanner).toBeVisible({ timeout: 10000 });

        const unlockBtn = page.getByRole("button", { name: "فتح قفل الخزنة" });
        await expect(unlockBtn).toBeVisible();

        // 6. Verify volatile memory isolation: RAM keys must not leak into localStorage
        const localStorageKeys = await page.evaluate(() => Object.keys(localStorage));
        const leakedKeys = localStorageKeys.filter((k) =>
            k.toLowerCase().includes("master_key") || k.toLowerCase().includes("private_key")
        );
        expect(leakedKeys).toHaveLength(0);
    });
});
