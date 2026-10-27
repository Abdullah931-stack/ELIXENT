/**
 * Phase 7: PostgreSQL Schema, Migrations & Atomic Transactions Suite (LIVE).
 *
 * Remediates: LUGX-025, LUGX-026, LUGX-027, LUGX-030, LUGX-031, LUGX-068, LUGX-069, LUGX-141, LUGX-143.
 *
 * Real Verification:
 * 1. Primary Key Uniqueness: Rejection of duplicate operations in credit_ledger_transactions.
 * 2. 1:N Subscriptions: Single user can hold multiple subscription records keyed by stripe_subscription_id.
 * 3. Stripe Subscription ID Uniqueness: Prevents duplicate stripe_subscription_id across users.
 * 4. Zero Partial Writes (Atomic Rollback): Simulated mid-transaction failure rolls back updates completely.
 * 5. Atomic Quota Debit & Idempotency: Deducts credit balance and inserts credit ledger transaction.
 * 6. Atomic Quota Refund: Restores credit balance and marks ledger transaction as ABORTED.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { txDb } from "@/server/db/transactional";
import { runMigrations } from "@/test/db.setup";
import { upsertSubscription } from "@/server/actions/subscription-actions";

const USER_A_ID = "71717171-7171-7171-7171-717171717171";
const USER_B_ID = "72727272-7272-7272-7272-727272727272";

describe("Phase 7: PostgreSQL Schema & Atomic Transactions (Live)", () => {
    beforeAll(async () => {
        await runMigrations();
        await cleanupTestUsers([USER_A_ID, USER_B_ID]);

        // Seed test users
        await testDb.insert(schema.users).values([
            {
                id: USER_A_ID,
                email: "user_a_phase7@example.test",
                tier: "pro",
                stripeCustomerId: "cus_test_p7_a",
                creditBalanceMicro: BigInt(10000000),
            },
            {
                id: USER_B_ID,
                email: "user_b_phase7@example.test",
                tier: "free",
                stripeCustomerId: "cus_test_p7_b",
                creditBalanceMicro: BigInt(5000000),
            },
        ]);
    });

    afterAll(async () => {
        await cleanupTestUsers([USER_A_ID, USER_B_ID]);
    });

    beforeEach(async () => {
        // Clean dependent rows before each test
        await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, USER_A_ID));
        await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, USER_B_ID));
        await testDb.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, USER_A_ID));
        await testDb.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, USER_B_ID));
    });

    it("enforces primary key uniqueness on operation_id in credit_ledger_transactions (remediates LUGX-030)", async () => {
        const opId = "op_p7_race_check_1";

        // First insertion should succeed
        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId: opId,
            userId: USER_A_ID,
            modelId: "claude-3-5-sonnet",
            executionMode: "SINGLE_PASS_DECISION",
            deltaMicro: BigInt(-150000),
            status: "SETTLED",
        });

        // Second insertion with identical operation_id must be rejected by PostgreSQL constraint
        let insertErr: any;
        try {
            await testDb.insert(schema.creditLedgerTransactions).values({
                operationId: opId,
                userId: USER_A_ID,
                modelId: "claude-3-5-sonnet",
                executionMode: "SINGLE_PASS_DECISION",
                deltaMicro: BigInt(-150000),
                status: "SETTLED",
            });
        } catch (e) {
            insertErr = e;
        }

        expect(insertErr).toBeDefined();
        // Check for PG unique_violation error code 23505 or duplicate key message
        const fullErrMsg = `${insertErr.message} ${insertErr.cause?.message || ""} ${insertErr.code || insertErr.cause?.code || ""}`;
        expect(fullErrMsg).toMatch(/unique|duplicate key|23505|credit_ledger_transactions_pkey/i);
    });

    it("allows 1:N multi-subscriptions per user and enforces stripe_subscription_id uniqueness (remediates LUGX-027)", async () => {
        const now = new Date();
        const end = new Date(Date.now() + 30 * 24 * 3600 * 1000);

        // 1. Insert first subscription for User A (e.g. canceled past tier)
        const res1 = await upsertSubscription(USER_A_ID, {
            stripeSubscriptionId: "sub_p7_hist_1",
            tier: "pro",
            status: "canceled",
            currentPeriodStart: now,
            currentPeriodEnd: end,
        });
        expect(res1.success).toBe(true);

        // 2. Insert second subscription for User A (active upgraded tier)
        const res2 = await upsertSubscription(USER_A_ID, {
            stripeSubscriptionId: "sub_p7_active_2",
            tier: "ultra",
            status: "active",
            currentPeriodStart: now,
            currentPeriodEnd: end,
        });
        expect(res2.success).toBe(true);

        // Verify user A now holds both subscription records (1:N allowed)
        const userSubs = await testDb
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, USER_A_ID));
        expect(userSubs).toHaveLength(2);

        // 3. Attempting to assign duplicate stripeSubscriptionId to User B must fail uniqueness
        let dupSubErr: any;
        try {
            await testDb.insert(schema.subscriptions).values({
                userId: USER_B_ID,
                stripeSubscriptionId: "sub_p7_active_2", // collision with User A
                tier: "ultra",
                status: "active",
                currentPeriodStart: now,
                currentPeriodEnd: end,
            });
        } catch (e) {
            dupSubErr = e;
        }

        expect(dupSubErr).toBeDefined();
        const fullDupMsg = `${dupSubErr.message} ${dupSubErr.cause?.message || ""} ${dupSubErr.code || dupSubErr.cause?.code || ""}`;
        expect(fullDupMsg).toMatch(/unique|duplicate key|23505|idx_subscriptions_stripe_id_unique/i);
    });

    it("executes interactive atomic rollback with zero partial writes upon transaction failure (remediates LUGX-030)", async () => {
        // Reset initial balance for USER_A_ID
        await testDb
            .update(schema.users)
            .set({ creditBalanceMicro: BigInt(5000000) })
            .where(eq(schema.users.id, USER_A_ID));

        // Execute a transaction that mutates credit_balance_micro, inserts credit_ledger_transactions, then throws
        const transactionAttempt = txDb.transaction(async (tx) => {
            // Step 1: deduct balance
            await tx
                .update(schema.users)
                .set({ creditBalanceMicro: BigInt(2000000) })
                .where(eq(schema.users.id, USER_A_ID));

            // Step 2: insert ledger transaction
            await tx.insert(schema.creditLedgerTransactions).values({
                operationId: "op_p7_rollback_test",
                userId: USER_A_ID,
                modelId: "claude-3-5-sonnet",
                executionMode: "SINGLE_PASS_DECISION",
                deltaMicro: BigInt(-3000000),
                status: "SETTLED",
            });

            // Step 3: Trigger intentional error before commit
            throw new Error("Simulated mid-transaction failure for atomic rollback verification");
        });

        await expect(transactionAttempt).rejects.toThrow("Simulated mid-transaction failure");

        // Verify zero partial writes in users table: creditBalanceMicro must STILL be BigInt(5000000)
        const [userRow] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USER_A_ID));
        expect(userRow.creditBalanceMicro).toBe(BigInt(5000000));

        // Verify credit ledger transaction was NOT persisted
        const [ledgerRow] = await testDb
            .select()
            .from(schema.creditLedgerTransactions)
            .where(eq(schema.creditLedgerTransactions.operationId, "op_p7_rollback_test"));
        expect(ledgerRow).toBeUndefined();
    });

    it("atomically debits credit balance, records transaction, and rejects duplicate inserts (remediates LUGX-030, LUGX-031)", async () => {
        const opId = "op_p7_atomic_debit_1";
        const deltaMicro = BigInt(-120000);

        // Reset balance to 1,000,000 micro
        await testDb
            .update(schema.users)
            .set({ creditBalanceMicro: BigInt(1000000) })
            .where(eq(schema.users.id, USER_A_ID));

        // Execute atomic debit transaction
        await txDb.transaction(async (tx) => {
            await tx
                .update(schema.users)
                .set({ creditBalanceMicro: sql`${schema.users.creditBalanceMicro} + ${deltaMicro}` })
                .where(eq(schema.users.id, USER_A_ID));

            await tx.insert(schema.creditLedgerTransactions).values({
                operationId: opId,
                userId: USER_A_ID,
                modelId: "claude-3-5-sonnet",
                executionMode: "SINGLE_PASS_DECISION",
                deltaMicro,
                status: "SETTLED",
            });
        });

        // Verify transaction record in credit_ledger_transactions
        const [storedTx] = await testDb
            .select()
            .from(schema.creditLedgerTransactions)
            .where(eq(schema.creditLedgerTransactions.operationId, opId));
        expect(storedTx).toBeDefined();
        expect(storedTx.deltaMicro).toBe(deltaMicro);
        expect(storedTx.status).toBe("SETTLED");

        // Verify balance decremented to 880,000 micro
        const [userRow] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USER_A_ID));
        expect(userRow.creditBalanceMicro).toBe(BigInt(880000));

        // Replay with identical operationId must be rejected by PK constraint (idempotency safety)
        let dupErr: any;
        try {
            await testDb.insert(schema.creditLedgerTransactions).values({
                operationId: opId,
                userId: USER_A_ID,
                modelId: "claude-3-5-sonnet",
                executionMode: "SINGLE_PASS_DECISION",
                deltaMicro,
                status: "SETTLED",
            });
        } catch (e) {
            dupErr = e;
        }
        expect(dupErr).toBeDefined();
    });

    it("atomically refunds credit balance and transitions ledger status (remediates LUGX-030)", async () => {
        const opId = "op_p7_atomic_refund_1";
        const debitMicro = BigInt(-100000);

        // Reset balance to 900,000 micro and insert debit transaction
        await testDb
            .update(schema.users)
            .set({ creditBalanceMicro: BigInt(900000) })
            .where(eq(schema.users.id, USER_A_ID));

        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId: opId,
            userId: USER_A_ID,
            modelId: "claude-3-5-sonnet",
            executionMode: "SINGLE_PASS_DECISION",
            deltaMicro: debitMicro,
            status: "SETTLED",
        });

        // Atomic refund: restore balance and mark as ABORTED
        await txDb.transaction(async (tx) => {
            await tx
                .update(schema.creditLedgerTransactions)
                .set({ status: "ABORTED" })
                .where(eq(schema.creditLedgerTransactions.operationId, opId));

            await tx
                .update(schema.users)
                .set({ creditBalanceMicro: sql`${schema.users.creditBalanceMicro} - ${debitMicro}` })
                .where(eq(schema.users.id, USER_A_ID));
        });

        // Verify ledger status updated to ABORTED
        const [storedTx] = await testDb
            .select()
            .from(schema.creditLedgerTransactions)
            .where(eq(schema.creditLedgerTransactions.operationId, opId));
        expect(storedTx.status).toBe("ABORTED");

        // Verify user credit balance restored to 1,000,000 micro
        const [userRow] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USER_A_ID));
        expect(userRow.creditBalanceMicro).toBe(BigInt(1000000));
    });
});
