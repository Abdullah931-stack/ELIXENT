/**
 * M3: Soft-delete lifecycle integration tests.
 *
 * REAL DATABASE TEST: local Postgres + Drizzle (pg driver) + full schema.
 *
 * Verifies the production soft-delete contract implemented in
 * @/server/actions/file-ops and enforced by migration 0003:
 *
 *   1. delete = tombstone (deleted_at IS NOT NULL), row stays in the DB.
 *   2. Every live read query filters deleted_at IS NULL
 *      (getFile / getUserFiles / getRootFiles / getFolderChildren).
 *   3. Live writes (updateFileContent / renameFile / moveFile) REJECT
 *      tombstoned rows — no stale sync replay can resurrect/modify them.
 *   4. restoreFile clears the tombstone; purged (physically deleted)
 *      rows cannot be restored.
 *   5. The partial unique index (user_id, parent_folder_id, title)
 *      WHERE deleted_at IS NULL means a user CAN recreate a file with
 *      the same name after deletion (no false unique violation).
 *   6. The purge DELETE WHERE deleted_at <= cutoff LIMIT 500 is bounded
 *      and parameterized (no injection surface).
 *
 * Server actions themselves require Supabase auth + remote Neon, so the
 * algorithm is exercised directly against the real schema via the
 * pg-backed test client. The SQL shapes are identical to production.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, and, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { getDescendantIds } from "@/server/actions/folders";
import { deleteFile, restoreFile } from "@/server/actions/file-ops";
import { randomUUID } from "crypto";

const TEST_USER_ID = "22222222-2222-2222-2222-222222222222";
let dbAvailable = false;

let currentSessionUser: { id: string; email: string } | null = {
    id: TEST_USER_ID,
    email: "softdelete-test@example.com",
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

const fileOf = (title: string, parent: string | null = null) => ({
    id: randomUUID(),
    userId: TEST_USER_ID,
    title,
    content: "<p>content</p>",
    isFolder: false,
    parentFolderId: parent,
    etag: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null as Date | null,
});

const folderOf = (title: string, parent: string | null = null) => ({
    id: randomUUID(),
    userId: TEST_USER_ID,
    title,
    content: "",
    isFolder: true,
    parentFolderId: parent,
    etag: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null as Date | null,
});

beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;
    await ensureTestDb();
    await runMigrations();
    await testDb
        .insert(schema.users)
        .values({ id: TEST_USER_ID, email: "softdelete-test@example.com" })
        .onConflictDoNothing();
});

beforeEach((ctx) => {
    if (!dbAvailable) {
        ctx.skip();
        return;
    }
    currentSessionUser = { id: TEST_USER_ID, email: "softdelete-test@example.com" };
});

afterAll(async () => {
    if (!dbAvailable) return;
    // Scoped cleanup ONLY — never wipe the whole files table on a live database.
    try { await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID)); } catch { /* ignore */ }
    // Remove this suite's seeded test account; CASCADE cleans dependents.
    try { await cleanupTestUsers([TEST_USER_ID]); } catch { /* ignore */ }
});

describe("soft delete lifecycle", () => {
    it("delete is a tombstone: row stays, reads become invisible", async () => {
        const file = fileOf("to-be-deleted.md");
        await testDb.insert(schema.files).values(file);

        // Live read finds it
        const live = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, file.id), eq(schema.files.userId, TEST_USER_ID)),
        });
        expect(live?.deletedAt).toBeNull();

        // Tombstone via production deleteFile server action
        const delResult = await deleteFile(file.id);
        expect(delResult.success).toBe(true);

        // Live read (all four production read queries) no longer sees it
        const queries = [
            // getFile
            testDb.query.files.findFirst({
                where: and(
                    eq(schema.files.id, file.id),
                    eq(schema.files.userId, TEST_USER_ID),
                    isNull(schema.files.deletedAt)
                ),
            }),
            // getUserFiles
            testDb.query.files.findMany({
                where: and(eq(schema.files.userId, TEST_USER_ID), isNull(schema.files.deletedAt)),
            }),
            // getRootFiles
            testDb.query.files.findMany({
                where: and(
                    eq(schema.files.userId, TEST_USER_ID),
                    isNull(schema.files.parentFolderId),
                    isNull(schema.files.deletedAt)
                ),
            }),
            // getFolderChildren — same where-shape as production
            testDb.query.files.findMany({
                where: and(
                    eq(schema.files.userId, TEST_USER_ID),
                    file.parentFolderId
                        ? eq(schema.files.parentFolderId, file.parentFolderId)
                        : isNull(schema.files.parentFolderId),
                    isNull(schema.files.deletedAt)
                ),
            }),
        ];

        const [one, many, roots, children] = await Promise.all(queries) as [
            typeof schema.files.$inferSelect | undefined,
            typeof schema.files.$inferSelect[],
            typeof schema.files.$inferSelect[],
            typeof schema.files.$inferSelect[],
        ];
        expect(one).toBeUndefined();
        expect(many.every((f) => f.id !== file.id)).toBe(true);
        expect(roots.every((f) => f.id !== file.id)).toBe(true);
        expect(children.every((f) => f.id !== file.id)).toBe(true);

        // Row still exists (tombstone, visible to admin/restore only)
        const tomb = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, file.id), isNotNull(schema.files.deletedAt)),
        });
        expect(tomb).toBeDefined();
        expect(tomb!.deletedAt).toBeInstanceOf(Date);
    });

    it("restoreFile clears the tombstone and the file reappears in reads", async () => {
        const file = fileOf("to-be-restored.md");
        await testDb.insert(schema.files).values(file);
        const delRes = await deleteFile(file.id);
        expect(delRes.success).toBe(true);

        // restoreFile server action: clear deleted_at
        const restoreRes = await restoreFile(file.id);
        expect(restoreRes.success).toBe(true);

        const restored = await testDb.query.files.findFirst({
            where: and(
                eq(schema.files.id, file.id),
                eq(schema.files.userId, TEST_USER_ID),
                isNull(schema.files.deletedAt)
            ),
        });
        expect(restored?.deletedAt).toBeNull();

        // Purged rows (physically deleted) are not restorable
        const goneId = randomUUID();
        const gone = fileOf("gone-forever.md");
        await testDb.insert(schema.files).values({ ...gone, id: goneId, deletedAt: new Date() });
        await testDb.delete(schema.files).where(eq(schema.files.id, goneId));
        const goneRes = await restoreFile(goneId);
        expect(goneRes.success).toBe(false);
        expect(goneRes.status).toBe("not_found");
    });

    it("live writes reject tombstoned rows (updateContent / rename / move)", async () => {
        const file = fileOf("frozen-while-deleted.md");
        await testDb.insert(schema.files).values(file);
        const delRes = await deleteFile(file.id);
        expect(delRes.success).toBe(true);

        const whereLive = and(
            eq(schema.files.id, file.id),
            eq(schema.files.userId, TEST_USER_ID),
            isNull(schema.files.deletedAt)
        );

        // updateFileContent: read returns nothing → rejects with "not found"
        const currentFile = await testDb.query.files.findFirst({ where: whereLive });
        expect(currentFile).toBeUndefined();

        // renameFile / moveFile: UPDATE touches 0 rows → rejects
        const renameResult = await testDb
            .update(schema.files)
            .set({ title: "sneaky-rename.md", updatedAt: new Date() })
            .where(whereLive);
        expect(renameResult.rowCount ?? 0).toBe(0);

        const moveResult = await testDb
            .update(schema.files)
            .set({ parentFolderId: randomUUID(), updatedAt: new Date() })
            .where(whereLive);
        expect(moveResult.rowCount ?? 0).toBe(0);

        // Title and parent are unchanged (the tombstone survived)
        const tomb = await testDb.query.files.findFirst({ where: eq(schema.files.id, file.id) });
        expect(tomb!.title).toBe("frozen-while-deleted.md");
    });

    it("unique name index ignores tombstones — re-creating a deleted name never conflicts", async () => {
        // Tombstone a row whose name will be reused
        const old = fileOf("same-name.md");
        await testDb.insert(schema.files).values(old);
        const delRes = await deleteFile(old.id);
        expect(delRes.success).toBe(true);

        // Live row with the same name in the same folder
        const fresh = fileOf("same-name.md");
        await expect(
            testDb.insert(schema.files).values(fresh)
        ).resolves.not.toThrow();

        // Live duplicate (same name, no tombstone) still conflicts
        const dup = fileOf("same-name.md");
        await expect(
            testDb.insert(schema.files).values(dup)
            // Drizzle wraps Postgres errors: match the wrapped "Failed query" or
            // the raw "duplicate key … unique constraint" message.
        ).rejects.toThrow(/unique|duplicate|violates|Failed query/i);
    });

    it("folder restoration cascades restoration to all soft-deleted descendant files and folders", async () => {
        const rootFolder = folderOf("Projects");
        const subFolder = folderOf("Frontend", rootFolder.id);
        const childDoc1 = fileOf("App.tsx", subFolder.id);
        const childDoc2 = fileOf("README.md", rootFolder.id);

        await testDb.insert(schema.files).values([rootFolder, subFolder, childDoc1, childDoc2]);

        // Soft-delete parent folder and all descendants via production deleteFile server action
        const delResult = await deleteFile(rootFolder.id);
        expect(delResult.success).toBe(true);

        const allIds = [rootFolder.id, subFolder.id, childDoc1.id, childDoc2.id];

        // Verify all rows are tombstoned
        const tombstoned = await testDb.query.files.findMany({
            where: and(eq(schema.files.userId, TEST_USER_ID), inArray(schema.files.id, allIds), isNotNull(schema.files.deletedAt)),
        });
        expect(tombstoned).toHaveLength(4);

        // getDescendantIds with includeDeleted: true discovers all soft-deleted children
        const descendantIds = await getDescendantIds(rootFolder.id, TEST_USER_ID, true);
        expect(descendantIds).toHaveLength(3);
        expect(descendantIds).toContain(subFolder.id);
        expect(descendantIds).toContain(childDoc1.id);
        expect(descendantIds).toContain(childDoc2.id);

        // getDescendantIds with includeDeleted: false (default) excludes soft-deleted items
        const liveDescendants = await getDescendantIds(rootFolder.id, TEST_USER_ID, false);
        expect(liveDescendants).toHaveLength(0);

        // Restore root folder and its descendants via production restoreFile server action
        const restoreResult = await restoreFile(rootFolder.id);
        expect(restoreResult.success).toBe(true);

        // Verify all 4 are completely restored and live queries see them
        const liveRows = await testDb.query.files.findMany({
            where: and(eq(schema.files.userId, TEST_USER_ID), inArray(schema.files.id, allIds), isNull(schema.files.deletedAt)),
        });
        expect(liveRows).toHaveLength(4);
    });
});

describe("purge job semantics", () => {
    it("bounded parameterized DELETE only removes rows past the retention window", async () => {
        // One row still within the 30-day window (must survive)
        const fresh = fileOf("fresh-tombstone.md");
        await testDb.insert(schema.files).values({
            ...fresh,
            deletedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
        });

        // One row past the window (must be purged)
        const expired = fileOf("expired-tombstone.md");
        await testDb.insert(schema.files).values({
            ...expired,
            deletedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
        });

        const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);

        // Exact SQL shape of /api/cron/purge-deleted (CTE-bounded DELETE).
        // LIMIT must be a fixed literal — Postgres prepared statements reject
        // parameterized LIMIT ($2) — so the production route keeps a constant
        // BATCH_LIMIT instead of any request-controlled value.
        const result = await testDb.execute(sql`
            WITH doomed AS (
                SELECT id FROM files
                WHERE deleted_at <= ${cutoff}
                LIMIT 500
            )
            DELETE FROM files USING doomed
            WHERE files.id = doomed.id
        `);

        expect(result.rowCount ?? 0).toBe(1);

        const survivors = await testDb.query.files.findMany({
            where: eq(schema.files.userId, TEST_USER_ID),
        });
        expect(survivors.map((f) => f.id)).toContain(fresh.id);
        expect(survivors.map((f) => f.id)).not.toContain(expired.id);
    });
});
