/**
 * Phase 8 Integration Test: Real Database AI Atomic Commit & Transactional Settlement
 *
 * REAL DATABASE TEST:
 * Runs against live PostgreSQL database with real Drizzle schema, tables, and transactions.
 * Exercises the ACTUAL production server actions:
 * - `commitAIFileOperation`
 * - `refundAIReservation`
 *
 * Proves that:
 * 1. File content update + AI transaction settlement commit ATOMICALLY in a single SQL transaction.
 * 2. If reservation settlement fails, the file modification is COMPLETELY ROLLED BACK in PostgreSQL.
 * 3. Concurrent version divergence (412 Conflict) is prevented by optimistic locking in PostgreSQL.
 * 4. Retrying an already committed operation is idempotent and returns persisted state without mutation.
 * 5. Reservation assigned to another file/user is strictly rejected against real DB records.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { randomUUID } from "crypto";
import { generateETagSync } from "@/lib/sync/etag-generator";
import { commitAIFileOperation } from "@/server/actions/ai-commit";
import { refundAIReservation } from "@/server/services/ai-settlement-service";
import { getUser } from "@/lib/supabase/server";

// Wire up getUser to authenticate as the real test user
vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(),
}));

// Route transactional DB client to the real PostgreSQL test database
vi.mock("@/server/db/transactional", () => ({
    txDb: testDb,
    schema,
}));

vi.mock("@/server/db", () => ({
    db: testDb,
    schema,
}));

const TEST_USER_ID = "88888888-8888-8888-8888-888888888888";
const OTHER_USER_ID = "99999999-9999-9999-9999-999999999999";
let dbAvailable = false;

beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;

    await ensureTestDb();
    await runMigrations();

    await testDb
        .insert(schema.users)
        .values([
            { id: TEST_USER_ID, email: "ai-commit-integration@example.com", creditBalanceMicro: BigInt(1000000000) },
            { id: OTHER_USER_ID, email: "ai-commit-other@example.com", creditBalanceMicro: BigInt(1000000000) },
        ])
        .onConflictDoNothing();
});

beforeEach(async (ctx) => {
    if (!dbAvailable) {
        ctx.skip();
        return;
    }

    vi.mocked(getUser).mockResolvedValue({ id: TEST_USER_ID } as unknown as Awaited<ReturnType<typeof getUser>>);

    await testDb
        .insert(schema.users)
        .values([
            { id: TEST_USER_ID, email: "ai-commit-integration@example.com", creditBalanceMicro: BigInt(1000000000) },
            { id: OTHER_USER_ID, email: "ai-commit-other@example.com", creditBalanceMicro: BigInt(1000000000) },
        ])
        .onConflictDoNothing();

    // Clean up test files & transactions before each test
    await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, TEST_USER_ID));
    await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, OTHER_USER_ID));
    await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID));
    await testDb.delete(schema.files).where(eq(schema.files.userId, OTHER_USER_ID));
});

afterAll(async () => {
    if (!dbAvailable) return;
    try {
        await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, TEST_USER_ID));
        await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, OTHER_USER_ID));
        await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID));
        await testDb.delete(schema.files).where(eq(schema.files.userId, OTHER_USER_ID));
    } catch {
        /* ignore */
    }
    // Remove this suite's seeded test accounts; CASCADE cleans dependents.
    try { await cleanupTestUsers([TEST_USER_ID, OTHER_USER_ID]); } catch { /* ignore */ }
});

describe("AI Atomic Commit — Real PostgreSQL Production Action Execution (Phase 8 Integration)", () => {
    it("should atomically commit file update and reservation settlement via real commitAIFileOperation", async () => {
        const fileId = randomUUID();
        const operationId = `op_real_${randomUUID()}`;
        const initialContent = "<p>Original document content</p>";
        const initialDate = new Date();
        const initialEtag = generateETagSync({ id: fileId, content: initialContent, updatedAt: initialDate });

        // 1. Seed initial file in Postgres
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "Atomic Test Doc",
            content: initialContent,
            version: 1,
            etag: initialEtag,
            updatedAt: initialDate,
        });

        // 2. Seed active AI transaction in Postgres
        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId,
            userId: TEST_USER_ID,
            modelId: "google/gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            inputTokens: 100,
            outputTokens: 200,
            deltaMicro: BigInt(-300000),
            status: "SETTLED",
            createdAt: new Date(),
        });

        // 3. Execute real production server action
        const aiResultContent = "<p>Enhanced AI polished document content</p>";
        const result = await commitAIFileOperation({
            operationId,
            fileId,
            expectedVersion: 1,
            expectedETag: initialEtag,
            resultContent: aiResultContent,
        });

        expect(result.success).toBe(true);
        expect(result.status).toBe("committed");
        if (result.status === "committed") {
            expect(result.version).toBe(2);
            expect(result.etag).toBeDefined();
        }

        // 4. Verify directly against real database state (Postgres Persistence)
        const dbFile = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });
        const dbTx = await testDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, operationId),
        });

        expect(dbFile).toBeDefined();
        expect(dbFile?.version).toBe(2);
        expect(dbFile?.content).toBe(aiResultContent);

        expect(dbTx).toBeDefined();
        expect(dbTx?.status).toBe("SETTLED");
    });

    it("should rollback file update completely when reservation settlement fails during commitAIFileOperation", async () => {
        const fileId = randomUUID();
        const operationId = `op_fail_${randomUUID()}`;
        const initialContent = "<p>Pristine content before failed commit</p>";
        const initialDate = new Date();
        const initialEtag = generateETagSync({ id: fileId, content: initialContent, updatedAt: initialDate });

        // Seed file
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "Rollback Test Doc",
            content: initialContent,
            version: 1,
            etag: initialEtag,
            updatedAt: initialDate,
        });

        // Seed transaction with 'ABORTED' status so commit is rejected
        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId,
            userId: TEST_USER_ID,
            modelId: "google/gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            inputTokens: 50,
            outputTokens: 100,
            deltaMicro: BigInt(-150000),
            status: "ABORTED",
            createdAt: new Date(),
        });

        // Attempt commitAIFileOperation
        const result = await commitAIFileOperation({
            operationId,
            fileId,
            expectedVersion: 1,
            expectedETag: initialEtag,
            resultContent: "<p>Uncommitted malicious or invalid content</p>",
        });

        expect(result.success).toBe(false);

        // Assert that PostgreSQL database state remains completely pristine
        const dbFile = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });

        expect(dbFile).toBeDefined();
        expect(dbFile?.version).toBe(1); // Pristine version preserved
        expect(dbFile?.content).toBe(initialContent); // Pristine content untouched
    });

    it("should detect concurrent version modification in real Postgres and return 412 conflict", async () => {
        const fileId = randomUUID();
        const operationId = `op_race_${randomUUID()}`;
        const initialContent = "<p>Base version 1</p>";

        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "Race Test Doc",
            content: initialContent,
            version: 1,
            etag: "etag-v1",
            updatedAt: new Date(),
        });

        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId,
            userId: TEST_USER_ID,
            modelId: "google/gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            inputTokens: 100,
            outputTokens: 100,
            deltaMicro: BigInt(-200000),
            status: "SETTLED",
            createdAt: new Date(),
        });

        // Advance version in Postgres to simulate concurrent autosave / collaborator
        await testDb
            .update(schema.files)
            .set({
                content: "<p>Concurrent writer edits document</p>",
                version: 2,
                etag: "etag-v2",
                updatedAt: new Date(),
            })
            .where(eq(schema.files.id, fileId));

        // Attempt commit with stale expectedVersion: 1
        const result = await commitAIFileOperation({
            operationId,
            fileId,
            expectedVersion: 1, // Stale!
            resultContent: "<p>Stale AI result</p>",
        });

        expect(result.success).toBe(false);
        expect(result.status).toBe("conflict");
        if (result.status === "conflict") {
            expect(result.serverVersion?.version).toBe(2);
        }

        // Verify concurrent writer's data in Postgres was preserved intact
        const dbFile = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });
        expect(dbFile?.version).toBe(2);
        expect(dbFile?.content).toBe("<p>Concurrent writer edits document</p>");

        // Verify transaction remained in database
        const dbTx = await testDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, operationId),
        });
        expect(dbTx?.status).toBe("SETTLED");
    });

    it("should idempotently return committed state when retrying an already committed operation via commitAIFileOperation", async () => {
        const fileId = randomUUID();
        const operationId = `op_idempotent_${randomUUID()}`;
        const committedContent = "<p>Already committed document text</p>";

        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "Idempotent Test Doc",
            content: committedContent,
            version: 3,
            etag: "etag-v3",
            updatedAt: new Date(),
        });

        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId,
            userId: TEST_USER_ID,
            nodeName: "committed:improve:test:100",
            modelId: "google/gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            inputTokens: 100,
            outputTokens: 150,
            deltaMicro: BigInt(-250000),
            status: "SETTLED",
            createdAt: new Date(),
        });

        // Call production commitAIFileOperation on committed transaction
        const result = await commitAIFileOperation({
            operationId,
            fileId,
            expectedVersion: 2,
            resultContent: "<p>Attempted retry content</p>",
        });

        expect(result.success).toBe(true);
        expect(result.status).toBe("already_committed");
        if (result.status === "already_committed") {
            expect(result.version).toBe(3);
            expect(result.etag).toBe("etag-v3");
        }

        // Verify database was NOT mutated
        const dbFile = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });
        expect(dbFile?.version).toBe(3);
        expect(dbFile?.content).toBe(committedContent);
    });

    it("should reject commitAIFileOperation when reservation is assigned to a different file or user in real DB", async () => {
        const fileA = randomUUID();
        const fileB = randomUUID();
        const operationId = `op_mismatch_${randomUUID()}`;

        await testDb.insert(schema.files).values([
            {
                id: fileA,
                userId: TEST_USER_ID,
                title: "File A",
                content: "<p>File A content</p>",
                version: 1,
                etag: "etag-a",
                updatedAt: new Date(),
            },
            {
                id: fileB,
                userId: TEST_USER_ID,
                title: "File B",
                content: "<p>File B content</p>",
                version: 1,
                etag: "etag-b",
                updatedAt: new Date(),
            },
        ]);

        // Transaction assigned to OTHER_USER_ID
        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId,
            userId: OTHER_USER_ID,
            modelId: "google/gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            inputTokens: 50,
            outputTokens: 50,
            deltaMicro: BigInt(-100000),
            status: "SETTLED",
            createdAt: new Date(),
        });

        // Attempt commit against File B by TEST_USER_ID
        const result = await commitAIFileOperation({
            operationId,
            fileId: fileB,
            expectedVersion: 1,
            resultContent: "<p>Content for File B</p>",
        });

        expect(result.success).toBe(false);
    });

    it("should successfully execute real refundAIReservation on real PostgreSQL database", async () => {
        const fileId = randomUUID();
        const operationId = `op_refund_${randomUUID()}`;

        // Seed parent file in Postgres first to satisfy foreign key constraint
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "Refund Test Doc",
            content: "<p>Original doc</p>",
            version: 1,
            etag: "etag-ref",
            updatedAt: new Date(),
        });

        // Seed transaction in Postgres
        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId,
            userId: TEST_USER_ID,
            modelId: "google/gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            inputTokens: 50,
            outputTokens: 100,
            deltaMicro: BigInt(-150000),
            status: "SETTLED",
            createdAt: new Date(),
        });

        // Execute production refundAIReservation
        const refundResult = await refundAIReservation(operationId, "test_cancellation");

        expect(refundResult.refunded).toBe(true);

        // Verify in real database
        const dbTx = await testDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, operationId),
        });

        expect(dbTx?.status).toBe("ABORTED");
    });

    it("should refuse unauthenticated commits with zero mutation", async () => {
        vi.mocked(getUser).mockResolvedValueOnce(null as never);
        const fileId = randomUUID();
        const operationId = `op_unauth_${randomUUID()}`;

        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "Unauth Test Doc",
            content: "<p>Original pristine</p>",
            version: 1,
            etag: "etag-unauth",
            updatedAt: new Date(),
        });

        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId,
            userId: TEST_USER_ID,
            modelId: "google/gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            inputTokens: 50,
            outputTokens: 50,
            deltaMicro: BigInt(-100000),
            status: "SETTLED",
            createdAt: new Date(),
        });

        const res = await commitAIFileOperation({
            operationId,
            fileId,
            expectedVersion: 1,
            resultContent: "<p>Should never be written</p>",
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe("unauthorized");

        const row = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });
        expect(row?.version).toBe(1);
        expect(row?.content).toBe("<p>Original pristine</p>");

        const resRow = await testDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, operationId),
        });
        expect(resRow?.status).toBe("SETTLED");
    });
});
