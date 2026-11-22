import type { Route } from "@playwright/test";
import { eq } from "drizzle-orm";
import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Decision Graph Explorer & Two-Tier Undo (Ctrl+Z + Turn/Session Revert)", () => {
    test("renders DecisionGraphExplorer SVG, inspects node details, and executes Tier 1 Ctrl+Z and Tier 2 Revert Turn/Session", async ({
        page,
        authSession,
    }) => {
        const workspaceId = schema.deriveDefaultWorkspaceId(authSession.userId);

        // 1. Seed markdown document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                workspaceId,
                title: "Architecture Spec",
                isFolder: false,
                content: "# Architecture\nOriginal architecture text.",
                version: 1,
            })
            .returning();

        // 2. Seed decisions.ledger.json with 2 nodes and 1 DEPENDS_ON edge
        const ledgerDoc = {
            schemaVersion: "2.0.0",
            workspaceId,
            updatedAt: new Date().toISOString(),
            taxonomy: null,
            nodes: {
                "dec-storage": {
                    decisionId: "dec-storage",
                    topicSlug: "storage-engine",
                    questionPrompt: "Which primary database engine?",
                    conceptTags: ["storage", "database"],
                    selectedOptionKey: "postgresql",
                    selectionRationale: "Strong ACID guarantees and relational integrity.",
                    runnerUpOptionKey: "sqlite",
                    evaluatedAlternatives: [
                        {
                            optionKey: "postgresql",
                            neutralSummary: "Managed PostgreSQL",
                            rationaleAndPremises: "ACID transactions and concurrency.",
                        },
                    ],
                    status: "APPROVED_DIRECT",
                    impactTier: "CORE_ARCHITECTURAL",
                    isLoadBearing: true,
                    dependsOn: [],
                    dependedBy: ["dec-auth"],
                    affectedSections: [{ fileId: doc.id, headingSlug: "architecture" }],
                    changeWeight: {
                        total: 74,
                        structural: 25,
                        provenance: 20,
                        topology: 17,
                        surface: 12,
                    },
                },
                "dec-auth": {
                    decisionId: "dec-auth",
                    topicSlug: "session-auth",
                    questionPrompt: "How are sessions persisted?",
                    conceptTags: ["auth"],
                    selectedOptionKey: "db-sessions",
                    selectionRationale: "Backed by PostgreSQL session table.",
                    runnerUpOptionKey: "stateless-jwt",
                    evaluatedAlternatives: [],
                    status: "APPROVED_CONSERVATIVE",
                    impactTier: "PERIPHERAL",
                    isLoadBearing: false,
                    dependsOn: ["dec-storage"],
                    dependedBy: [],
                    affectedSections: [{ fileId: doc.id, headingSlug: "architecture" }],
                    changeWeight: {
                        total: 35,
                        structural: 10,
                        provenance: 10,
                        topology: 8,
                        surface: 7,
                    },
                },
            },
            edges: [
                {
                    edgeId: "edge-auth-storage",
                    sourceDecisionId: "dec-auth",
                    targetDecisionId: "dec-storage",
                    relation: "DEPENDS_ON",
                    justification: "Session persistence relies on the primary storage engine.",
                },
            ],
        };

        await e2eDb.insert(schema.files).values({
            userId: authSession.userId,
            workspaceId,
            title: "decisions.ledger.json",
            artifactRole: "decision_ledger",
            isFolder: false,
            content: JSON.stringify(ledgerDoc),
            version: 1,
        });

        // 3. Open editor and launch Decision Graph Explorer
        await page.goto(`/workspace/editor/${doc.id}`, { waitUntil: "domcontentloaded" });
        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toContainText("Original architecture text.", { timeout: 15000 });

        const decisionGraphBtn = page.getByRole("button", { name: /Decision Graph/ });
        await expect(decisionGraphBtn).toBeVisible({ timeout: 15000 });
        await decisionGraphBtn.click();

        const explorerDialog = page.getByRole("dialog", { name: "Decision Graph Explorer" });
        await expect(explorerDialog).toBeVisible({ timeout: 10000 });

        const graphSvg = page.getByTestId("decision-graph-svg");
        await expect(graphSvg).toBeVisible({ timeout: 10000 });
        await expect(graphSvg).toContainText("storage-engine");
        await expect(graphSvg).toContainText("session-auth");
        await expect(graphSvg).toContainText("DEPENDS_ON");

        // 4. Select a node and verify Decision Inspector Drawer
        await graphSvg.locator("g", { hasText: "storage-engine" }).first().click();
        const inspectorDrawer = page.getByLabel("Decision Inspector Drawer");
        await expect(inspectorDrawer).toBeVisible({ timeout: 10000 });
        await expect(inspectorDrawer).toContainText("postgresql");
        await expect(inspectorDrawer).toContainText("Strong ACID guarantees");

        // 5. Close Decision Graph Explorer
        await page.getByLabel("Close Decision Graph Explorer").click();
        await expect(explorerDialog).toBeHidden();

        // 6. Tier 1 Undo: propose GhostHunk, accept via single-transaction replaceRanges, and undo via Control+z
        let streamCallCount = 0;
        const turnId = "turn-e2e-undo-1";
        await page.route("**/api/agent/stream", async (route: Route) => {
            streamCallCount += 1;
            let reqOpId = `op-undo-${Date.now()}`;
            try {
                const postData = JSON.parse(route.request().postData() || "{}");
                if (postData.operationId) {
                    reqOpId = postData.operationId;
                }
            } catch {
                // ignore
            }

            if (streamCallCount === 1) {
                const sseBody = [
                    `event: start\ndata: ${JSON.stringify({
                        type: "start",
                        sessionId: `sess_${Date.now()}`,
                        threadId: doc.id,
                        operationId: reqOpId,
                    })}\n\n`,
                    `event: ghost_hunk_proposed\ndata: ${JSON.stringify({
                        type: "ghost_hunk_proposed",
                        fileId: doc.id,
                        headingSlug: "architecture",
                        hunks: [
                            {
                                hunkId: "hunk_arch_1",
                                headingSlug: "architecture",
                                replacementText: "# Architecture\nProposed AI architecture update.",
                                status: "preview_ready",
                            },
                        ],
                    })}\n\n`,
                    `event: done\ndata: ${JSON.stringify({
                        type: "done",
                        threadId: doc.id,
                        operationId: reqOpId,
                    })}\n\n`,
                ].join("");

                await route.fulfill({
                    status: 200,
                    contentType: "text/event-stream",
                    body: sseBody,
                });
                return;
            }

            // Turn 2: file_mutated for Tier 2 Revert Turn / Revert Session
            await e2eDb
                .update(schema.files)
                .set({
                    content: "# Architecture\nMutated by AI turn 2.",
                    version: 3,
                    updatedAt: new Date(),
                })
                .where(eq(schema.files.id, doc.id));

            const sseBody = [
                `event: start\ndata: ${JSON.stringify({
                    type: "start",
                    sessionId: `sess_${Date.now()}`,
                    threadId: doc.id,
                    operationId: reqOpId,
                    turnId,
                })}\n\n`,
                `event: file_mutated\ndata: ${JSON.stringify({
                    type: "file_mutated",
                    fileId: doc.id,
                    relativePath: doc.title,
                    action: "updated",
                    turnId,
                })}\n\n`,
                `event: done\ndata: ${JSON.stringify({
                    type: "done",
                    threadId: doc.id,
                    operationId: reqOpId,
                    turnId,
                })}\n\n`,
            ].join("");

            await route.fulfill({
                status: 200,
                contentType: "text/event-stream",
                body: sseBody,
            });
        });

        await page.getByTestId("ai-toolbar-agent-toggle").click();
        await page.getByTestId("agent-prompt-input").fill("Propose architecture update");
        await page.getByTestId("agent-start-button").click();

        const applyCommitButton = page
            .getByTestId("ai-toolbar-accept-all")
            .or(page.getByTestId("agent-accept-all-hunks"));
        await expect(applyCommitButton.first()).toBeVisible({ timeout: 15000 });
        await applyCommitButton.first().click();

        await expect(cmContent).toContainText("Proposed AI architecture update.", { timeout: 10000 });

        // Tier 1 Undo: single-transaction Control+z in CodeMirror
        await cmContent.click();
        await page.keyboard.press("Control+z");
        await expect(cmContent).toContainText("Original architecture text.", { timeout: 10000 });

        // 7. Tier 2 Undo: trigger file_mutated turn and verify Revert Turn & Revert Session controls
        await page.getByTestId("agent-prompt-input").fill("Apply turn 2 mutation");
        await page.getByTestId("agent-start-button").click();
        await expect(cmContent).toContainText("Mutated by AI turn 2.", { timeout: 15000 });

        const revertTurnBtn = page.getByRole("button", { name: "Revert Turn" }).first();
        const revertSessionBtn = page.getByTestId("agent-revert-session-button");
        await expect(revertTurnBtn).toBeVisible({ timeout: 10000 });
        await expect(revertSessionBtn).toBeVisible({ timeout: 10000 });

        await revertTurnBtn.click();
        await expect(page.getByText("Reverted", { exact: true })).toBeVisible({ timeout: 10000 });
    });
});
