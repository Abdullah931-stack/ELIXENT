/**
 * W5: Lost-update guard integration tests.
 *
 * REAL DATABASE TEST: local Postgres + Drizzle (pg driver) + full schema.
 *
 * Verifies the optimistic-locking contract implemented in
 * @/server/actions/file-ops (updateFileContent):
 *
 *   1. A normal update succeeds: version advances by 1, content and etag
 *      are persisted.
 *   2. Two CONCURRENT updates that both read the same version cannot both
 *      land: the second writer's UPDATE is conditioned on the version it
 *      read, so it touches 0 rows — the caller is told there was a
 *      conflict instead of silently overwriting the first writer.
 *   3. Sequential updates keep advancing the version monotonically; the
 *      guard never rejects a legitimately newer save.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { randomUUID } from "crypto";
import { updateFileContent } from "@/server/actions/file-ops";

const TEST_USER_ID = "55555555-5555-5555-5555-555555555555";
let dbAvailable = false;

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => ({ id: TEST_USER_ID, email: "lostupdate-test@example.com" })),
    createClient: vi.fn(async () => ({
        auth: {
            getUser: vi.fn(async () => ({ data: { user: { id: TEST_USER_ID, email: "lostupdate-test@example.com" } }, error: null })),
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
    await testDb
        .insert(schema.users)
        .values({ id: TEST_USER_ID, email: "lostupdate-test@example.com" })
        .onConflictDoNothing();
    // Remove leftovers from previous runs so the live unique-title index
    // cannot collide across runs.
    try { await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID)); } catch { /* ignore */ }
});

beforeEach((ctx) => {
    if (!dbAvailable) {
        ctx.skip();
    }
});

afterAll(async () => {
    if (!dbAvailable) return;
    try { await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID)); } catch { /* ignore */ }
    // Remove this suite's seeded test account; CASCADE cleans dependents.
    try { await cleanupTestUsers([TEST_USER_ID]); } catch { /* ignore */ }
});

describe("lost-update guard (W5)", () => {
    it("normal update advances version by 1 and persists content", async () => {
        const fileId = randomUUID();
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "w5-plain.md",
            content: "v0",
            isFolder: false,
            parentFolderId: null,
            etag: null,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        });

        const r1 = await updateFileContent(fileId, "v1");
        expect(r1.success).toBe(true);
        expect((r1 as any).version).toBe(2);

        const row = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });
        expect(row?.content).toBe("v1");
        expect(row?.version).toBe(2);
    });

    it("concurrent same-version saves: exactly one lands, the other is told about the conflict", async () => {
        const fileId = randomUUID();
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "w5-race.md",
            content: "v0",
            isFolder: false,
            parentFolderId: null,
            etag: null,
            version: 3,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        });

        // Both writers read version 3 and both compute version 4. To make
        // the race unambiguous, read the version ONCE and hand both writers
        // that same snapshot — any real concurrent save behaves identically.
        const snapshot = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, fileId), eq(schema.files.userId, TEST_USER_ID)),
            columns: { version: true },
        });
        const [first, second] = await Promise.all([
            updateFileContent(fileId, "writer-A", { expectedVersion: snapshot!.version ?? 0 }),
            updateFileContent(fileId, "writer-B", { expectedVersion: snapshot!.version ?? 0 }),
        ]);

        // Exactly one must succeed; the other must report the conflict.
        const outcomes = [first, second];
        expect(outcomes.filter(o => o.success).length).toBe(1);
        expect(outcomes.filter(o => !o.success && o.status === "conflict").length).toBe(1);

        // Whichever won, its content is what the row holds (no silent mix).
        const row = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });
        const winner = outcomes.find(o => o.success)!;
        expect(row?.content).toBe(winner === first ? "writer-A" : "writer-B");
        expect(row?.version).toBe(4);
    });

    it("stale writer with an older version is rejected, never overwrites", async () => {
        const fileId = randomUUID();
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "w5-stale.md",
            content: "v0",
            isFolder: false,
            parentFolderId: null,
            etag: null,
            version: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        });

        // Fresh writer moves it to 6.
        const fresh = await updateFileContent(fileId, "fresh-save");
        expect(fresh.success).toBe(true);
        expect((fresh as any).version).toBe(6);

        // A writer still holding version 4 tries to save — must fail,
        // and the row's content must stay the fresh writer's.
        const stale = await updateFileContent(fileId, "stale-save", { expectedVersion: 4 });
        expect(stale.success).toBe(false);
        expect(stale.status).toBe("conflict");

        const row = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });
        expect(row?.content).toBe("fresh-save");
        expect(row?.version).toBe(6);
    });

    it("sequential legitimate saves keep advancing the version", async () => {
        const fileId = randomUUID();
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "w5-seq.md",
            content: "v0",
            isFolder: false,
            parentFolderId: null,
            etag: null,
            version: 7,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        });

        // Sequential legitimate saves — each reading the freshly committed
        // version — must ALL succeed and advance the version monotonically.
        // The guard must never reject a genuinely newer save; it only blocks
        // writers holding a stale snapshot.
        const s1 = await updateFileContent(fileId, "v1");
        const s2 = await updateFileContent(fileId, "v2");
        const s3 = await updateFileContent(fileId, "v3");
        expect(s1.success).toBe(true);
        expect(s2.success).toBe(true);
        expect(s3.success).toBe(true);

        const row = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });
        expect(row?.version).toBe(10);
        expect(row?.content).toBe("v3");

        // Meanwhile a stale writer still holding the original snapshot
        // (version 7) is rejected — the positive and negative paths both
        // verified in one test.
        const stale = await updateFileContent(fileId, "stale-save", { expectedVersion: 7 });
        expect(stale.success).toBe(false);
        expect(stale.status).toBe("conflict");

        const rowAfterStale = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });
        expect(rowAfterStale?.version).toBe(10);
        expect(rowAfterStale?.content).toBe("v3");
    });
});
