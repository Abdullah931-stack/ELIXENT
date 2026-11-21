import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 13: Zero-Knowledge AI Shield & Default AI Enablement", () => {
    test("encrypted documents should render the AI shield badge and permit AI streaming requests", async ({
        page,
        authSession,
    }) => {
        // 1. Seed an encrypted document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                workspaceId: schema.deriveDefaultWorkspaceId(authSession.userId),
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

        // 4. Verify that programmatic invocation of /api/agent/stream against this encrypted file is permitted by default (HTTP 200 SSE).
        //    Use a streaming browser fetch with AbortController so we validate SSE admission (`event: start`)
        //    without buffering the entire live LLM stream until EOF.
        const streamProbe = await page.evaluate(
            async ({ threadId, projectId, targetFileId }) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort("probe_timeout"), 15_000);
                try {
                    const response = await fetch("/api/agent/stream", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            threadId,
                            projectId,
                            targetFileIds: [targetFileId],
                            prompt: "Summarize this document",
                        }),
                        signal: controller.signal,
                    });

                    const status = response.status;
                    const contentType = response.headers.get("content-type") ?? "";

                    if (!response.ok || !response.body) {
                        const errorBody = await response.text().catch(() => "");
                        return { status, contentType, receivedText: errorBody, hasStartEvent: false };
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let receivedText = "";

                    try {
                        while (!receivedText.includes("event: start")) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            receivedText += decoder.decode(value, { stream: true });
                        }
                    } finally {
                        await reader.cancel().catch(() => {});
                    }

                    return {
                        status,
                        contentType,
                        receivedText,
                        hasStartEvent: receivedText.includes("event: start"),
                    };
                } finally {
                    clearTimeout(timeoutId);
                    controller.abort();
                }
            },
            {
                threadId: `thread-${doc.id}`,
                projectId: `project-${authSession.userId}`,
                targetFileId: doc.id,
            }
        );

        expect(
            streamProbe.status,
            `Unexpected /api/agent/stream response body: ${streamProbe.receivedText}`
        ).toBe(200);
        expect(streamProbe.contentType).toContain("text/event-stream");
        expect(streamProbe.hasStartEvent).toBe(true);
    });
});
