/**
 * F1: Lost-update guard on PUT /api/files/[id] — integration test.
 *
 * REAL DATABASE TEST: local Postgres + Drizzle (pg driver) + full schema.
 *
 * The architectural re-verification report documented a single remaining
 * theoretical race window: the PUT route read the row, compared the
 * ETag in application code, then wrote — three separate steps with no
 * SQL-level version guard. The route now conditions its UPDATE on the
 * exact version it read, so a concurrent writer inside the read-write
 * gap produces rowCount 0 and the caller receives an explicit 412
 * conflict instead of silent data loss.
 *
 * Real invocation of the production PUT route handler exercising the F1 guard.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { randomUUID } from "crypto";
import { PUT } from "@/app/api/files/[id]/route";
import { NextRequest } from "next/server";

const TEST_USER_ID = "77777777-7777-7777-7777-777777777777";
let dbAvailable = false;

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => ({ id: TEST_USER_ID, email: `putguard-${TEST_USER_ID}@example.com` })),
    createClient: vi.fn(async () => ({
        auth: {
            getUser: vi.fn(async () => ({ data: { user: { id: TEST_USER_ID, email: `putguard-${TEST_USER_ID}@example.com` } }, error: null })),
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
        .values({ id: TEST_USER_ID, email: `putguard-${TEST_USER_ID}@example.com` })
        .onConflictDoNothing();
    // Remove leftovers from previous runs so the live unique-title index
    // cannot collide across runs.
    try { await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID)); } catch { /* ignore */ }
});

beforeEach(async (ctx) => {
    if (!dbAvailable) {
        ctx.skip();
        return;
    }
    try { await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID)); } catch { /* ignore */ }
    await testDb
        .insert(schema.users)
        .values({ id: TEST_USER_ID, email: `putguard-${TEST_USER_ID}@example.com` })
        .onConflictDoNothing();
});

afterAll(async () => {
    if (!dbAvailable) return;
    try { await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID)); } catch { /* ignore */ }
    // Remove this suite's seeded test account; CASCADE cleans dependents.
    try { await cleanupTestUsers([TEST_USER_ID]); } catch { /* ignore */ }
});

/**
 * Invokes the real production PUT route handler with optimistic concurrency controls.
 */
async function routePutUpdate(fileId: string, newContent: string, opts: { version?: number } = {}) {
    let expectedVersion = opts.version;
    if (expectedVersion === undefined) {
        const current = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, fileId), eq(schema.files.userId, TEST_USER_ID)),
            columns: { version: true },
        });
        if (!current) return { success: false, error: "not-found" as const, affected: 0 };
        expectedVersion = current.version ?? 0;
    }

    const req = new NextRequest(`http://localhost/api/files/${fileId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content: newContent,
            expectedVersion,
        }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: fileId }) });
    if (res.status === 200) {
        const data = await res.json();
        return { success: true, version: data.version, affected: 1 };
    }
    if (res.status === 412) {
        return { success: false, error: "conflict" as const, affected: 0 };
    }
    if (res.status === 404) {
        return { success: false, error: "not-found" as const, affected: 0 };
    }
    return { success: false, error: "error" as const, affected: 0 };
}

describe("PUT /api/files/[id] version guard (F1)", () => {
    it("normal PUT advances version by 1 and persists content", async () => {
        const fileId = randomUUID();
        await testDb.insert(schema.files).values({
            id: fileId, userId: TEST_USER_ID, title: "f1-plain.md", content: "v0",
            isFolder: false, parentFolderId: null, etag: null,
            version: 1, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
        });

        const r = await routePutUpdate(fileId, "v1");
        expect(r.success).toBe(true);
        expect(r.version).toBe(2);

        const row = await testDb.query.files.findFirst({ where: eq(schema.files.id, fileId) });
        expect(row?.content).toBe("v1");
        expect(row?.version).toBe(2);
    });

    it("concurrent same-version PUTs: exactly one lands, the other reports 412 conflict", async () => {
        const fileId = randomUUID();
        await testDb.insert(schema.files).values({
            id: fileId, userId: TEST_USER_ID, title: "f1-race.md", content: "v0",
            isFolder: false, parentFolderId: null, etag: null,
            version: 3, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
        });

        const snapshot = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, fileId), eq(schema.files.userId, TEST_USER_ID)),
            columns: { version: true },
        });
        const [first, second] = await Promise.all([
            routePutUpdate(fileId, "put-A", { version: snapshot!.version ?? 0 }),
            routePutUpdate(fileId, "put-B", { version: snapshot!.version ?? 0 }),
        ]);

        const outcomes = [first, second];
        expect(outcomes.filter(o => o.success).length).toBe(1);
        expect(outcomes.filter(o => !o.success && o.error === "conflict").length).toBe(1);

        const row = await testDb.query.files.findFirst({ where: eq(schema.files.id, fileId) });
        const winner = outcomes.find(o => o.success)!;
        expect(row?.content).toBe(winner === first ? "put-A" : "put-B");
        expect(row?.version).toBe(4);
    });

    it("stale PUT is rejected, never overwrites the fresh writer", async () => {
        const fileId = randomUUID();
        await testDb.insert(schema.files).values({
            id: fileId, userId: TEST_USER_ID, title: "f1-stale.md", content: "v0",
            isFolder: false, parentFolderId: null, etag: null,
            version: 5, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
        });

        const fresh = await routePutUpdate(fileId, "fresh-save");
        expect(fresh.success).toBe(true);
        expect(fresh.version).toBe(6);

        const stale = await routePutUpdate(fileId, "stale-save", { version: 4 });
        expect(stale.success).toBe(false);
        expect(stale.error).toBe("conflict");

        const row = await testDb.query.files.findFirst({ where: eq(schema.files.id, fileId) });
        expect(row?.content).toBe("fresh-save");
        expect(row?.version).toBe(6);
    });
});
