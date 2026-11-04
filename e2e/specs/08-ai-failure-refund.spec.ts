import type { Route } from "@playwright/test";
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

        // 1. Intercept stream endpoints to simulate upstream AI provider crash (500)
        const handle500Failure = async (route: Route) => {
            await route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({
                    error: "Upstream AI service temporarily unavailable",
                    code: "INTERNAL_SERVER_ERROR",
                    message: "Upstream AI service temporarily unavailable",
                }),
            });
        };

        await page.route("**/api/agent/stream", handle500Failure);

        // 2. Open editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });
        await expect(cmContent).toContainText("Text awaiting AI refinement", { timeout: 20000 });

        // 3. Trigger AI Agent from UI
        const agentToggle = page.getByTestId("ai-toolbar-agent-toggle");
        await expect(agentToggle).toBeVisible({ timeout: 10000 });
        await agentToggle.click();

        const promptInput = page.getByTestId("agent-prompt-input");
        await expect(promptInput).toBeVisible({ timeout: 10000 });
        await promptInput.fill("Refine text with AI");

        const startButton = page.getByTestId("agent-start-button");
        await expect(startButton).toBeVisible();
        await startButton.click();

        // 4. Assert UI error alert is displayed
        const errorAlert = page.getByTestId("agent-error-alert").or(page.getByText(/حدث خطأ أثناء معالجة النص|Upstream AI service|error/i));
        await expect(errorAlert.first()).toBeVisible({ timeout: 15000 });

        // 5. Verify document content is preserved completely
        await expect(cmContent).toContainText("Text awaiting AI refinement");
        const currentDoc = await getDbFile(doc.id);
        expect(currentDoc?.content).toBe("# Text awaiting AI refinement");
        expect(currentDoc?.version).toBe(1);
    });
});
