import crypto from "crypto";
import type { Route } from "@playwright/test";
import { eq } from "drizzle-orm";
import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";
import { AAD } from "../../src/lib/crypto/aad";

function aesGcmEncryptBase64(key: Buffer, plaintext: Buffer | string, aad: string): { ciphertextBase64: string; ivBase64: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const encrypted = Buffer.concat([
        cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
        ciphertextBase64: Buffer.concat([encrypted, tag]).toString("base64"),
        ivBase64: iv.toString("base64"),
    };
}

test.describe("Workspace Zero-Knowledge Encryption Governance & All-or-Nothing Decryption", () => {
    test("enforces vault unlock, displays AI ZK notice with zero localStorage key leaks, and requires all-or-nothing workspace decryption", async ({
        page,
        authSession,
    }) => {
        test.setTimeout(90000);
        const workspaceId = schema.deriveDefaultWorkspaceId(authSession.userId);
        const vaultPassword = "Vault_E2E_Pass_2026!";

        // 1. Derive real vault master key and seed userVaultProfiles + encrypted workspace + 2 encrypted files
        const masterKey = crypto.randomBytes(32);
        const keySalt = crypto.randomBytes(16);
        const recoverySalt = crypto.randomBytes(16);
        const kdfIterations = 600000;

        const kekPass = crypto.pbkdf2Sync(
            vaultPassword.normalize("NFKC"),
            keySalt,
            kdfIterations,
            32,
            "sha256"
        );
        const wrappedPass = aesGcmEncryptBase64(
            kekPass,
            masterKey,
            AAD.passwordWrap(authSession.userId)
        );
        const wrappedRecovery = aesGcmEncryptBase64(
            crypto.randomBytes(32),
            masterKey,
            AAD.recoveryWrap(authSession.userId)
        );

        await e2eDb.insert(schema.userVaultProfiles).values({
            userId: authSession.userId,
            encryptedMasterKey: JSON.stringify({
                ciphertext: wrappedPass.ciphertextBase64,
                iv: wrappedPass.ivBase64,
            }),
            recoveryEncryptedMasterKey: JSON.stringify({
                ciphertext: wrappedRecovery.ciphertextBase64,
                iv: wrappedRecovery.ivBase64,
            }),
            keySalt: keySalt.toString("base64"),
            recoverySalt: recoverySalt.toString("base64"),
            kdfIterations,
            keyVersion: 1,
        });

        await e2eDb
            .update(schema.workspaces)
            .set({ isEncrypted: true })
            .where(eq(schema.workspaces.id, workspaceId));

        const file1Id = crypto.randomUUID();
        const file2Id = crypto.randomUUID();
        const encFile1 = aesGcmEncryptBase64(
            masterKey,
            "# ZK One\nConfidential blueprint one.",
            AAD.file(authSession.userId, file1Id)
        );
        const encFile2 = aesGcmEncryptBase64(
            masterKey,
            "# ZK Two\nConfidential blueprint two.",
            AAD.file(authSession.userId, file2Id)
        );

        await e2eDb.insert(schema.files).values([
            {
                id: file1Id,
                userId: authSession.userId,
                workspaceId,
                title: "ZK Governance One",
                isFolder: false,
                content: encFile1.ciphertextBase64,
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "master-v1",
                    salt: keySalt.toString("base64"),
                    iv: encFile1.ivBase64,
                    kdfIterations,
                },
                version: 1,
            },
            {
                id: file2Id,
                userId: authSession.userId,
                workspaceId,
                title: "ZK Governance Two",
                isFolder: false,
                content: encFile2.ciphertextBase64,
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "master-v1",
                    salt: keySalt.toString("base64"),
                    iv: encFile2.ivBase64,
                    kdfIterations,
                },
                version: 1,
            },
        ]);

        // 2. Open encrypted file1 -> VaultUnlockModal opens automatically
        await page.goto(`/workspace/editor/${file1Id}`, { waitUntil: "domcontentloaded" });

        const unlockHeading = page.getByRole("heading", { name: "فتح قفل الخزنة المشفرة" });
        await expect(unlockHeading).toBeVisible({ timeout: 15000 });
        await page.getByPlaceholder("أدخل كلمة المرور...").fill(vaultPassword);
        await page.getByPlaceholder("أدخل كلمة المرور...").press("Enter");

        await expect(unlockHeading).toBeHidden({ timeout: 20000 });
        await expect(page.locator(".cm-content")).toContainText("Confidential blueprint one.", {
            timeout: 15000,
        });

        // 3. Verify AI ZK notice when running an AI request in an encrypted workspace
        await page.route("**/api/agent/stream", async (route: Route) => {
            let reqOpId = `op-zk-${Date.now()}`;
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
                    threadId: file1Id,
                    operationId: reqOpId,
                })}\n\n`,
                `event: done\ndata: ${JSON.stringify({
                    type: "done",
                    threadId: file1Id,
                    operationId: reqOpId,
                })}\n\n`,
            ].join("");
            await route.fulfill({
                status: 200,
                contentType: "text/event-stream",
                body: sseBody,
            });
        });

        await page.getByTestId("ai-toolbar-agent-toggle").click();
        await page.getByTestId("agent-prompt-input").fill("Summarize encrypted workspace");
        await page.getByTestId("agent-start-button").click();

        await expect(page.getByTestId("agent-zk-ai-notice")).toBeVisible({ timeout: 15000 });

        // 4. Verify zero cryptographic key leakage in localStorage
        const localStorageKeys = await page.evaluate(() => Object.keys(localStorage));
        const leakedKeys = localStorageKeys.filter(
            (k) => k.toLowerCase().includes("master_key") || k.toLowerCase().includes("private_key")
        );
        expect(leakedKeys).toHaveLength(0);

        // 5. Trigger single-file decryption via FileContextMenu -> WorkspaceDecryptionWarningModal
        const file1Item = page.locator("li", { hasText: "ZK Governance One" }).first();
        await file1Item.hover();
        await file1Item.locator("button").last().click({ force: true });
        await page.getByRole("button", { name: /فك تشفير الملف/ }).click();

        const decryptWarningDialog = page.getByRole("dialog", { name: "Decrypt Entire Workspace" });
        await expect(decryptWarningDialog).toBeVisible({ timeout: 10000 });
        await expect(decryptWarningDialog).toContainText(
            "requires decrypting the entire workspace and all of its files"
        );

        // Confirm all-or-nothing workspace decryption
        await decryptWarningDialog.getByRole("button", { name: "Decrypt Workspace" }).click();
        await expect(decryptWarningDialog).toBeHidden({ timeout: 20000 });

        // Verify both files are now decrypted in DB
        await expect
            .poll(async () => (await getDbFile(file1Id))?.isEncrypted, { timeout: 15000 })
            .toBe(false);
        await expect
            .poll(async () => (await getDbFile(file2Id))?.isEncrypted, { timeout: 15000 })
            .toBe(false);
    });
});
