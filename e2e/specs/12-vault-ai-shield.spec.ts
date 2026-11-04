import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 13: Zero-Knowledge AI Shield & Default AI Enablement", () => {
    test("encrypted documents should render the AI shield badge and permit AI streaming requests", async ({
        page,
        context,
        authSession,
    }) => {
        // 1. Seed an encrypted document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Confidential Financials",
                isFolder: false,
                content: "enc:iv_mock:auth_tag_mock:ciphertext_mock",
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "mk-1",
                    salt: "salt",
                    iv: "iv_mock",
                    kdfIterations: 600000,
                },
                version: 1,
            })
            .returning();

        // 2. Open editor in browser
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        // 3. Verify that the amber AI Shield badge is explicitly displayed in the UI toolbar
        const aiBadge = page.getByTestId("ai-encrypted-badge");
        await expect(aiBadge).toBeVisible({ timeout: 15000 });
        await expect(aiBadge).toContainText(/AI Shield Active|Encrypted|ميزات الـ AI معطلة|التشفير محمي/);

        // 4. Verify that programmatic invocation of /api/agent/stream against this encrypted file is permitted by default (HTTP 200 SSE)
        const streamResponse = await context.request.post("/api/agent/stream", {
            data: {
                threadId: `thread-${doc.id}`,
                projectId: `project-${authSession.userId}`,
                targetFileIds: [doc.id],
                prompt: "Summarize this document",
            },
        });

        expect(streamResponse.status()).toBe(200);
        expect(streamResponse.headers()["content-type"]).toContain("text/event-stream");
    });
});
