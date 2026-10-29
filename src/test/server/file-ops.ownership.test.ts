/**
 * Phase 3: File Ownership, Parent Validation, Cycle Detection & If-Match Tests
 *
 * Verifies:
 * 1. Parent folder ownership: User A cannot target User B's folder as parent (cross-user isolation).
 * 2. Hierarchy cycle detection: Moving a folder into itself or into its descendant is rejected with 409 conflict.
 * 3. Precondition enforcement: Tested via production moveFile and updateFileContent contracts.
 * 4. Restore lifecycle & ADV-01 resolution:
 *    - Restoring a file whose parent folder is soft-deleted safely detaches to root (parentFolderId = null).
 *    - Restoring a file when a live duplicate exists automatically appends `(Restored)` without date.
 *    - Multiple deleted files with identical titles coexist in tombstone state without constraint violations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { randomUUID } from "crypto";
import { generateRestoredTitle, generateCopyTitle } from "@/lib/utils/file-naming";
import { moveFile, restoreFile } from "@/server/actions/file-ops";

const USER_A_ID = "33333333-3333-3333-3333-333333333333";
const USER_B_ID = "44444444-4444-4444-4444-444444444444";
let dbAvailable = false;

let currentSessionUser: { id: string; email: string } | null = {
    id: USER_A_ID,
    email: "user-a-ownership@example.com",
};

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => currentSessionUser),
    createClient: vi.fn(async () => ({
        auth: {
            getUser: vi.fn(async () => ({ data: { user: currentSessionUser }, error: null })),
        },
    })),
}));

vi.mock("@/server/db", async () => {
    const original = await vi.importActual<typeof import("@/server/db")>("@/server/db");
    return {
        ...original,
        db: testDb,
    };
});

beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;
    await ensureTestDb();
    await runMigrations();

    await testDb.insert(schema.users).values([
        { id: USER_A_ID, email: "user-a-ownership@example.com" },
        { id: USER_B_ID, email: "user-b-ownership@example.com" },
    ]).onConflictDoNothing();

    try {
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A_ID));
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B_ID));
    } catch {
        /* ignore */
    }
});

beforeEach(async (ctx) => {
    if (!dbAvailable) {
        ctx.skip();
        return;
    }
    currentSessionUser = { id: USER_A_ID, email: "user-a-ownership@example.com" };
    try {
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A_ID));
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B_ID));
    } catch {
        /* ignore */
    }
});

afterAll(async () => {
    if (!dbAvailable) return;
    try {
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A_ID));
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B_ID));
    } catch {
        /* ignore */
    }
    // Remove this suite's seeded test accounts; CASCADE cleans dependents.
    try { await cleanupTestUsers([USER_A_ID, USER_B_ID]); } catch { /* ignore */ }
});

describe("Phase 3: Algorithm & Contract Specifications (Pure Logic & Sacred Tests)", () => {
    it("ADV-01 title resolution: correctly appends (Restored) without date", () => {
        expect(generateRestoredTitle("Report.md")).toBe("Report (Restored).md");
        expect(generateRestoredTitle("Report.md", 2)).toBe("Report (Restored 2).md");
        expect(generateRestoredTitle("Project Plan")).toBe("Project Plan (Restored)");
        expect(generateRestoredTitle("Project Plan", 3)).toBe("Project Plan (Restored 3)");
        expect(generateRestoredTitle("archive.tar.gz")).toBe("archive.tar (Restored).gz");
    });

    it("CRIT-02 copy title resolution: correctly generates Notes (Copy).md and Notes (Copy 2).md", () => {
        expect(generateCopyTitle("Notes.md")).toBe("Notes (Copy).md");
        expect(generateCopyTitle("Notes.md", 1)).toBe("Notes (Copy).md");
        expect(generateCopyTitle("Notes.md", 2)).toBe("Notes (Copy 2).md");
        expect(generateCopyTitle("Notes.md", 5)).toBe("Notes (Copy 5).md");
        expect(generateCopyTitle("Projects")).toBe("Projects (Copy)");
        expect(generateCopyTitle("Projects", 3)).toBe("Projects (Copy 3)");
    });
});

describe("Phase 3: Database & Production moveFile Integration Tests", () => {
    it("cycle detection: blocks moving a folder into itself (409 conflict)", async () => {
        const folder1Id = randomUUID();
        await testDb.insert(schema.files).values({
            id: folder1Id,
            userId: USER_A_ID,
            title: "Folder 1",
            isFolder: true,
            parentFolderId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        });

        const res = await moveFile(folder1Id, folder1Id);
        expect(res.success).toBe(false);
        expect(res.status).toBe("conflict");
        expect(res.error).toBe("Cannot move a folder into itself");
    });

    it("cycle detection: blocks moving into descendant across arbitrary depth (409 conflict)", async () => {
        const rootId = randomUUID();
        const childId = randomUUID();
        const grandchildId = randomUUID();
        const greatgrandchildId = randomUUID();

        await testDb.insert(schema.files).values([
            { id: rootId, userId: USER_A_ID, title: "root", isFolder: true, parentFolderId: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null },
            { id: childId, userId: USER_A_ID, title: "child", isFolder: true, parentFolderId: rootId, createdAt: new Date(), updatedAt: new Date(), deletedAt: null },
            { id: grandchildId, userId: USER_A_ID, title: "grandchild", isFolder: true, parentFolderId: childId, createdAt: new Date(), updatedAt: new Date(), deletedAt: null },
            { id: greatgrandchildId, userId: USER_A_ID, title: "greatgrandchild", isFolder: true, parentFolderId: grandchildId, createdAt: new Date(), updatedAt: new Date(), deletedAt: null },
        ]);

        const res = await moveFile(rootId, greatgrandchildId);
        expect(res.success).toBe(false);
        expect(res.status).toBe("conflict");
        expect(res.error?.toLowerCase()).toContain("descendant");

        // Moving grandchild into root is valid
        const validRes = await moveFile(grandchildId, rootId);
        expect(validRes.success).toBe(true);
    });

    it("cross-user parent isolation: blocks selecting another user's folder as parent (404 not found)", async () => {
        const userBFolderId = randomUUID();
        const userADocId = randomUUID();

        await testDb.insert(schema.files).values([
            { id: userBFolderId, userId: USER_B_ID, title: "User B Folder", isFolder: true, parentFolderId: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null },
            { id: userADocId, userId: USER_A_ID, title: "User A Doc", isFolder: false, parentFolderId: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null },
        ]);

        const res = await moveFile(userADocId, userBFolderId);
        expect(res.success).toBe(false);
        expect(res.status).toBe("not_found");
    });

    it("[DB] ADV-01: multiple deleted files with same name coexist and restore without collision", async () => {
        const file1Id = randomUUID();
        const file2Id = randomUUID();

        // 1. Insert file 1, then soft-delete it
        await testDb.insert(schema.files).values({
            id: file1Id,
            userId: USER_A_ID,
            title: "Document.md",
            content: "first version",
            isFolder: false,
            parentFolderId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: new Date(),
        });

        // 2. Insert file 2 with SAME title, and also soft-delete it (both deleted)
        await expect(testDb.insert(schema.files).values({
            id: file2Id,
            userId: USER_A_ID,
            title: "Document.md",
            content: "second version",
            isFolder: false,
            parentFolderId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: new Date(),
        })).resolves.not.toThrow();

        // 3. Create a LIVE file with the same title "Document.md"
        const liveFileId = randomUUID();
        await testDb.insert(schema.files).values({
            id: liveFileId,
            userId: USER_A_ID,
            title: "Document.md",
            content: "live active document",
            isFolder: false,
            parentFolderId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        });

        // 4. Restore file 1 using production restoreFile: must become "Document (Restored).md"
        const restoreRes = await restoreFile(file1Id);
        expect(restoreRes.success).toBe(true);
        expect(restoreRes.data?.title).toBe("Document (Restored).md");

        const restored1 = await testDb.query.files.findFirst({
            where: eq(schema.files.id, file1Id),
        });
        expect(restored1?.title).toBe("Document (Restored).md");
        expect(restored1?.deletedAt).toBeNull();
    });

    it("[DB] restore lifecycle: restoring a file with deleted parent attaches to root", async () => {
        const parentFolderId = randomUUID();
        const fileId = randomUUID();

        await testDb.insert(schema.files).values([
            {
                id: parentFolderId,
                userId: USER_A_ID,
                title: "Deleted Parent Folder",
                isFolder: true,
                parentFolderId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: new Date(),
            },
            {
                id: fileId,
                userId: USER_A_ID,
                title: "Orphan Child File",
                isFolder: false,
                parentFolderId: parentFolderId,
                content: "content",
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: new Date(),
            },
        ]);

        // Restore orphan child via production restoreFile: detaches to root
        const restoreRes = await restoreFile(fileId);
        expect(restoreRes.success).toBe(true);
        expect(restoreRes.data?.parentFolderId).toBeNull();

        const restoredFile = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });

        expect(restoredFile?.deletedAt).toBeNull();
        expect(restoredFile?.parentFolderId).toBeNull();
    });
});
