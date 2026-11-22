import crypto from "crypto";
import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Multi-Workspace Isolation & Workspace ZIP Archive Export", () => {
    test("isolates file trees across workspaces, creates a workspace via UI, and exports a .zip archive", async ({
        page,
        authSession,
    }) => {
        const defaultWorkspaceId = schema.deriveDefaultWorkspaceId(authSession.userId);
        const betaWorkspaceId = crypto.randomUUID();

        // 1. Seed a secondary workspace and distinct files per workspace
        await e2eDb.insert(schema.workspaces).values({
            id: betaWorkspaceId,
            userId: authSession.userId,
            name: "Beta Workspace",
        });

        await e2eDb.insert(schema.files).values([
            {
                userId: authSession.userId,
                workspaceId: defaultWorkspaceId,
                title: "Alpha Architecture Note",
                isFolder: false,
                content: "# Alpha\nDefault workspace content.",
                version: 1,
            },
            {
                userId: authSession.userId,
                workspaceId: betaWorkspaceId,
                title: "Beta Design Spec",
                isFolder: false,
                content: "# Beta\nIsolated beta workspace content.",
                version: 1,
            },
        ]);

        // 2. Reload /workspace so seeded workspaces and files hydrate into sidebar
        await page.goto("/workspace", { waitUntil: "domcontentloaded" });
        const workspaceSelect = page.getByLabel("Active Workspace");
        await expect(workspaceSelect).toBeVisible({ timeout: 15000 });

        // 3. Verify Default Workspace file-tree isolation
        await expect(page.getByRole("link", { name: "Alpha Architecture Note", exact: true })).toBeVisible({
            timeout: 15000,
        });
        await expect(page.getByRole("link", { name: "Beta Design Spec", exact: true })).toBeHidden();

        // 4. Switch to Beta Workspace and verify strict isolation
        await workspaceSelect.selectOption(betaWorkspaceId);
        await expect(page.getByRole("link", { name: "Beta Design Spec", exact: true })).toBeVisible({
            timeout: 15000,
        });
        await expect(page.getByRole("link", { name: "Alpha Architecture Note", exact: true })).toBeHidden();

        // 5. Create a new workspace via the Create Workspace button prompt
        page.once("dialog", async (dialog) => {
            await dialog.accept("Gamma Workspace");
        });
        await page.getByLabel("Create Workspace").click();

        await expect(workspaceSelect.locator("option", { hasText: "Gamma Workspace" })).toBeAttached({
            timeout: 15000,
        });
        await expect(page.getByRole("link", { name: "Beta Design Spec", exact: true })).toBeHidden();

        // 6. Switch back to Beta Workspace and export as .zip
        await workspaceSelect.selectOption(betaWorkspaceId);
        await expect(page.getByRole("link", { name: "Beta Design Spec", exact: true })).toBeVisible({
            timeout: 15000,
        });

        const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
        await page.getByRole("button", { name: /Export Workspace \(\.zip\)/ }).click();
        const download = await downloadPromise;

        expect(download.suggestedFilename()).toBe(`workspace-${betaWorkspaceId}.zip`);
        const downloadPath = await download.path();
        expect(downloadPath).toBeTruthy();
    });
});
