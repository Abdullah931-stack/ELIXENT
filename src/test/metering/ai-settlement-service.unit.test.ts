import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getUserCreditBalance,
  flushPendingSettlementsToPostgres,
  reserveAIQuota,
  commitAIReservation,
  refundAIReservation,
  computeRequestHash,
} from "@/server/services/ai-settlement-service";
import { REDIS_KEYS } from "@/lib/metering/constants";
import { MeteringServiceUnavailableError } from "@/lib/metering/lua-scripts";

// In-memory database tables for hermetic unit testing
interface MockUser {
  id: string;
  creditBalanceMicro: bigint | number | null;
  tier: string;
  updatedAt?: Date;
}

interface MockLedgerTx {
  operationId: string;
  userId: string;
  threadId?: string | null;
  nodeName?: string | null;
  modelId: string;
  executionMode: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  deltaMicro: bigint | number;
  status: string;
  createdAt: Date;
}

let usersTable: Map<string, MockUser>;
let ledgerTable: Map<string, MockLedgerTx>;

const mockDb = vi.hoisted(() => {
  return {
    query: {
      users: {
        findFirst: vi.fn(async (params: any) => {
          const userId = params?.where?.value;
          return (userId ? usersTable.get(userId) : null) ?? null;
        }),
      },
      creditLedgerTransactions: {
        findFirst: vi.fn(async (params: any) => {
          const opId = params?.where?.value;
          return (opId ? ledgerTable.get(opId) : null) ?? null;
        }),
        findMany: vi.fn(async () => Array.from(ledgerTable.values())),
      },
    },
    insert: vi.fn((_table: any) => ({
      values: vi.fn((rows: any) => {
        const rowsArray = Array.isArray(rows) ? rows : [rows];
        return {
          onConflictDoNothing: vi.fn((_opts?: any) => ({
            returning: vi.fn(async () => {
              const inserted: any[] = [];
              for (const row of rowsArray) {
                if (!ledgerTable.has(row.operationId)) {
                  const record = {
                    ...row,
                    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(),
                  };
                  ledgerTable.set(row.operationId, record);
                  inserted.push(record);
                }
              }
              return inserted;
            }),
          })),
          returning: vi.fn(async () => {
            for (const row of rowsArray) {
              ledgerTable.set(row.operationId, {
                ...row,
                createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(),
              });
            }
            return rowsArray;
          }),
        };
      }),
    })),
    update: vi.fn((_table: any) => ({
      set: vi.fn((updates: any) => ({
        where: vi.fn((condition: any) => {
          const findId = (cond: any): string | undefined => {
            if (!cond) return undefined;
            if (cond.value) return cond.value;
            if (cond.conditions) {
              for (const c of cond.conditions) {
                const found = findId(c);
                if (found) return found;
              }
            }
            return undefined;
          };

          return {
            returning: vi.fn(async () => {
              const targetUserId = findId(condition);
              const user = targetUserId ? usersTable.get(targetUserId) : undefined;
              if (!user) return [];

              if (updates?.creditBalanceMicro?.__delta !== undefined) {
                const current = BigInt(user.creditBalanceMicro ?? 0);
                const delta = BigInt(updates.creditBalanceMicro.__delta);
                const required = -delta;
                if (updates.creditBalanceMicro.__checkGte && current < required) {
                  return [];
                }
                user.creditBalanceMicro = current + delta;
              } else if (typeof updates?.creditBalanceMicro === "bigint" || typeof updates?.creditBalanceMicro === "number") {
                user.creditBalanceMicro = BigInt(updates.creditBalanceMicro);
              }
              user.updatedAt = new Date();
              return [{ id: user.id }];
            }),
            then: async (resolve: (val: any) => void) => {
              const targetId = findId(condition);
              const tx = targetId ? ledgerTable.get(targetId) : undefined;
              if (tx) {
                if (updates.status) tx.status = updates.status;
                if (updates.nodeName) tx.nodeName = updates.nodeName;
                if (updates.outputTokens !== undefined) tx.outputTokens = updates.outputTokens;
              }
              const user = targetId ? usersTable.get(targetId) : undefined;
              if (user && updates?.creditBalanceMicro?.__delta !== undefined) {
                const current = BigInt(user.creditBalanceMicro ?? 0);
                user.creditBalanceMicro = current + updates.creditBalanceMicro.__delta;
                user.updatedAt = new Date();
              }
              resolve({ rowCount: 1 });
            },
          };
        }),
      })),
    })),
    transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockDb)),
  };
});

vi.mock("@/server/db", () => ({
  db: mockDb,
}));

vi.mock("@/server/db/transactional", () => ({
  txDb: mockDb,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: any, val: any) => ({ value: val })),
  and: vi.fn((...conditions: any[]) => ({ conditions })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => {
      const num = values.find((v) => typeof v === "bigint" || typeof v === "number");
      if (strings[0]?.includes("-") || strings[1]?.includes("-")) {
        return { __delta: -BigInt(num ?? 0), __checkGte: true, __required: BigInt(num ?? 0) };
      }
      if (strings[0]?.includes("+") || strings[1]?.includes("+")) {
        return { __delta: BigInt(num ?? 0) };
      }
      return { raw: strings.join("?"), values };
    },
    { raw: vi.fn() }
  ),
}));

/**
 * In-memory Mock Redis Client for pending settlements & dirty wallets testing.
 */
class MockSettlementRedis {
  public pending = new Map<string, Map<string, string>>();
  public dirty = new Set<string>();

  public async hgetall(key: string): Promise<Record<string, string> | null> {
    const map = this.pending.get(key);
    if (!map) return null;
    return Object.fromEntries(map.entries());
  }

  public async hdel(key: string, ...fields: string[]): Promise<number> {
    const map = this.pending.get(key);
    if (!map) return 0;
    let count = 0;
    for (const f of fields) {
      if (map.delete(f)) count++;
    }
    return count;
  }

  public async hlen(key: string): Promise<number> {
    const map = this.pending.get(key);
    return map ? map.size : 0;
  }

  public async srem(key: string, ...members: string[]): Promise<number> {
    let count = 0;
    for (const m of members) {
      if (this.dirty.delete(m)) count++;
    }
    return count;
  }

  public setPending(userId: string, opId: string, payload: any): void {
    const key = REDIS_KEYS.pendingSettlements(userId);
    let map = this.pending.get(key);
    if (!map) {
      map = new Map();
      this.pending.set(key, map);
    }
    map.set(opId, typeof payload === "string" ? payload : JSON.stringify(payload));
    this.dirty.add(userId);
  }
}

describe("AI Settlement Service & Flush Engine (ai-settlement-service.ts)", () => {
  const userId = "usr_settlement_test_1";

  beforeEach(() => {
    vi.clearAllMocks();
    usersTable = new Map();
    ledgerTable = new Map();

    usersTable.set(userId, {
      id: userId,
      creditBalanceMicro: BigInt(5_000_000), // 5 Credits
      tier: "free",
    });
  });

  describe("getUserCreditBalance", () => {
    it("should return correct BigInt balance when user exists and has confirmed credits", async () => {
      const balance = await getUserCreditBalance(userId);
      expect(balance).toBe(BigInt(5_000_000));
    });

    it("should return 0n when user does not exist in the database", async () => {
      const balance = await getUserCreditBalance("non_existent_user");
      expect(balance).toBe(BigInt(0));
    });

    it("should return 0n when user exists but creditBalanceMicro is null or undefined", async () => {
      usersTable.set("usr_null_balance", {
        id: "usr_null_balance",
        creditBalanceMicro: null,
        tier: "free",
      });

      const balance = await getUserCreditBalance("usr_null_balance");
      expect(balance).toBe(BigInt(0));
    });

    it("should accurately preserve 64-bit BigInt balances beyond JS safe integer limits", async () => {
      const largeBalance = BigInt("9007199254740999555");
      usersTable.set(userId, {
        id: userId,
        creditBalanceMicro: largeBalance,
        tier: "ultra",
      });

      const balance = await getUserCreditBalance(userId);
      expect(balance).toBe(largeBalance);
    });
  });

  describe("flushPendingSettlementsToPostgres", () => {
    it("should throw MeteringServiceUnavailableError when Redis is unavailable", async () => {
      await expect(
        flushPendingSettlementsToPostgres(userId, { customRedis: null })
      ).rejects.toThrow(MeteringServiceUnavailableError);
    });

    it("should remove user from dirty wallets and return 0 flushed when pending hash is empty", async () => {
      const redis = new MockSettlementRedis();
      redis.dirty.add(userId);

      const result = await flushPendingSettlementsToPostgres(userId, {
        customRedis: redis,
      });

      expect(result.flushedCount).toBe(0);
      expect(result.netDeltaMicro).toBe(BigInt(0));
      expect(redis.dirty.has(userId)).toBe(false);
    });

    it("should flush single pending settlement, insert ledger row, adjust user balance, and clean Redis", async () => {
      const redis = new MockSettlementRedis();
      const opId = "op_test_single_flush_1";
      redis.setPending(userId, opId, {
        userId,
        modelId: "gemini-2.5-flash",
        executionMode: "STREAMING_GENERATIVE",
        inputTokens: 100,
        outputTokens: 50,
        deltaMicro: -150000,
        status: "SETTLED",
        created_at_ms: Date.now() - 5000,
      });

      const result = await flushPendingSettlementsToPostgres(userId, {
        customRedis: redis,
      });

      expect(result.flushedCount).toBe(1);
      expect(result.netDeltaMicro).toBe(BigInt(-150000));

      // Ledger transaction record inserted
      const savedTx = ledgerTable.get(opId);
      expect(savedTx).toBeDefined();
      expect(savedTx?.deltaMicro).toBe(BigInt(-150000));
      expect(savedTx?.status).toBe("SETTLED");

      // User balance adjusted in Postgres (5_000_000 + (-150_000) = 4_850_000)
      const updatedUser = usersTable.get(userId);
      expect(updatedUser?.creditBalanceMicro).toBe(BigInt(4_850_000));

      // Redis pending hash and dirty set purged
      const remainingLen = await redis.hlen(REDIS_KEYS.pendingSettlements(userId));
      expect(remainingLen).toBe(0);
      expect(redis.dirty.has(userId)).toBe(false);
    });

    it("should derive deltaMicro from actualTotalCostMicro when deltaMicro field is missing", async () => {
      const redis = new MockSettlementRedis();
      const opId = "op_derived_cost_1";
      redis.setPending(userId, opId, {
        userId,
        actualTotalCostMicro: 75000,
        status: "SETTLED",
        created_at_ms: Date.now() - 2000,
      });

      const result = await flushPendingSettlementsToPostgres(userId, {
        customRedis: redis,
      });

      expect(result.flushedCount).toBe(1);
      expect(result.netDeltaMicro).toBe(BigInt(-75000));

      const savedTx = ledgerTable.get(opId);
      expect(savedTx?.deltaMicro).toBe(BigInt(-75000));
    });

    it("should filter entries by onlyOlderThanMs and keep newer entries in Redis", async () => {
      const redis = new MockSettlementRedis();
      const oldOpId = "op_old_settlement";
      const newOpId = "op_recent_settlement";
      const now = Date.now();

      // Old entry: 10 seconds ago
      redis.setPending(userId, oldOpId, {
        userId,
        deltaMicro: -30000,
        created_at_ms: now - 10000,
      });

      // Recent entry: 100 milliseconds ago
      redis.setPending(userId, newOpId, {
        userId,
        deltaMicro: -20000,
        created_at_ms: now - 100,
      });

      // Flush only items older than 5000ms (5 seconds)
      const result = await flushPendingSettlementsToPostgres(userId, {
        customRedis: redis,
        onlyOlderThanMs: 5000,
      });

      expect(result.flushedCount).toBe(1);
      expect(result.netDeltaMicro).toBe(BigInt(-30000));

      // Old op removed from Redis, new op preserved
      const pendingHash = await redis.hgetall(REDIS_KEYS.pendingSettlements(userId));
      expect(pendingHash?.[oldOpId]).toBeUndefined();
      expect(pendingHash?.[newOpId]).toBeDefined();

      // Dirty set must still retain userId because pending items remain
      expect(redis.dirty.has(userId)).toBe(true);
    });

    it("should handle onConflictDoNothing idempotently when operationId already exists in PostgreSQL", async () => {
      const redis = new MockSettlementRedis();
      const duplicateOpId = "op_duplicate_already_flushed";

      // Pre-existing ledger entry in database
      ledgerTable.set(duplicateOpId, {
        operationId: duplicateOpId,
        userId,
        modelId: "gemini-2.5-flash",
        executionMode: "STREAMING_GENERATIVE",
        inputTokens: 50,
        cachedInputTokens: 0,
        outputTokens: 25,
        reasoningTokens: 0,
        deltaMicro: BigInt(-50000),
        status: "SETTLED",
        createdAt: new Date(),
      });

      redis.setPending(userId, duplicateOpId, {
        userId,
        deltaMicro: -50000,
        created_at_ms: Date.now() - 1000,
      });

      const initialUserBal = usersTable.get(userId)?.creditBalanceMicro;

      const result = await flushPendingSettlementsToPostgres(userId, {
        customRedis: redis,
      });

      // Flushed from Redis without re-crediting or double-debiting
      expect(result.flushedCount).toBe(1);
      expect(result.netDeltaMicro).toBe(BigInt(0)); // onConflictDoNothing returned 0 rows
      expect(usersTable.get(userId)?.creditBalanceMicro).toBe(initialUserBal);

      const pendingHash = await redis.hgetall(REDIS_KEYS.pendingSettlements(userId));
      expect(pendingHash?.[duplicateOpId]).toBeUndefined();
    });

    it("should fail closed and not delete Redis keys if database transaction throws", async () => {
      const redis = new MockSettlementRedis();
      const opId = "op_db_crash_1";
      redis.setPending(userId, opId, {
        userId,
        deltaMicro: -10000,
        created_at_ms: Date.now() - 1000,
      });

      // Force mock transaction failure
      mockDb.transaction.mockRejectedValueOnce(new Error("Deadlock detected"));

      await expect(
        flushPendingSettlementsToPostgres(userId, { customRedis: redis })
      ).rejects.toThrow(MeteringServiceUnavailableError);

      // Pending entry preserved in Redis for retry
      const pendingHash = await redis.hgetall(REDIS_KEYS.pendingSettlements(userId));
      expect(pendingHash?.[opId]).toBeDefined();
    });
  });

  describe("Regression Verification of Existing Settlement Functions", () => {
    describe("reserveAIQuota", () => {
      it("should reject reservation when tier limit is exceeded or disabled", async () => {
        // Free tier does not allow toPrompt
        const res = await reserveAIQuota(userId, "toPrompt", 100, "free");
        expect(res.reserved).toBe(false);
        expect(res.reason).toContain("ToPrompt is only available");
      });

      it("should reject reservation when user has insufficient credit balance", async () => {
        usersTable.set(userId, {
          id: userId,
          creditBalanceMicro: BigInt(500), // Only 500 micro-credits
          tier: "free",
        });

        const res = await reserveAIQuota(userId, "correct", 200, "free");
        expect(res.reserved).toBe(false);
        expect(res.reason).toContain("Insufficient credit balance");
      });

      it("should detect replay attack when operationId is reused with different request payload", async () => {
        const opId = "op_replay_test";
        const initialHash = computeRequestHash(userId, "correct", "f_1", "Original text");
        const alteredHash = computeRequestHash(userId, "correct", "f_1", "Tampered text");

        ledgerTable.set(opId, {
          operationId: opId,
          userId,
          nodeName: `reserved:correct:${initialHash}:50`,
          modelId: "gemini-2.5-flash",
          executionMode: "STREAMING_GENERATIVE",
          inputTokens: 50,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          deltaMicro: BigInt(-50000),
          status: "SETTLED",
          createdAt: new Date(),
        });

        const res = await reserveAIQuota(userId, "correct", 50, "free", {
          operationId: opId,
          requestHash: alteredHash,
        });

        expect(res.reserved).toBe(false);
        expect(res.isReplayConflict).toBe(true);
        expect(res.reason).toContain("Replay attack detected");
      });

      it("should deduct credits and record transaction on successful reservation", async () => {
        const opId = "op_success_reserve";
        const wordCount = 100;

        const res = await reserveAIQuota(userId, "correct", wordCount, "free", {
          operationId: opId,
        });

        expect(res.reserved).toBe(true);
        expect(res.operationId).toBe(opId);

        // Balance deducted: 100 words * 1000 = 100,000 micro-credits
        const user = usersTable.get(userId);
        expect(user?.creditBalanceMicro).toBe(BigInt(4_900_000));

        const savedTx = ledgerTable.get(opId);
        expect(savedTx).toBeDefined();
        expect(savedTx?.deltaMicro).toBe(BigInt(-100_000));
      });
    });

    describe("commitAIReservation", () => {
      it("should return not_found if operationId does not exist", async () => {
        const res = await commitAIReservation("unknown_op");
        expect(res.committed).toBe(false);
        expect(res.reason).toBe("not_found");
      });

      it("should return already_committed when calling commit on an already committed operation", async () => {
        const opId = "op_committed_1";
        ledgerTable.set(opId, {
          operationId: opId,
          userId,
          nodeName: "committed:correct:hash123:100",
          modelId: "gemini-2.5-flash",
          executionMode: "STREAMING_GENERATIVE",
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 100,
          reasoningTokens: 0,
          deltaMicro: BigInt(-100000),
          status: "SETTLED",
          createdAt: new Date(),
        });

        const res = await commitAIReservation(opId);
        expect(res.committed).toBe(true);
        expect(res.reason).toBe("already_committed");
      });

      it("should commit and issue partial refund when actual consumed units are lower than reserved", async () => {
        const opId = "op_partial_commit";
        const reservedUnits = 200;
        const consumedUnits = 120; // 80 units unconsumed -> 80,000 micro refund

        ledgerTable.set(opId, {
          operationId: opId,
          userId,
          nodeName: `reserved:correct:hash123:${reservedUnits}`,
          modelId: "gemini-2.5-flash",
          executionMode: "STREAMING_GENERATIVE",
          inputTokens: reservedUnits,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          deltaMicro: BigInt(-reservedUnits * 1000),
          status: "SETTLED",
          createdAt: new Date(),
        });

        const res = await commitAIReservation(opId, consumedUnits);
        expect(res.committed).toBe(true);

        const tx = ledgerTable.get(opId);
        expect(tx?.nodeName).toContain("committed:");
        expect(tx?.outputTokens).toBe(consumedUnits);

        // User refunded 80,000 micro-credits
        const user = usersTable.get(userId);
        expect(user?.creditBalanceMicro).toBe(BigInt(5_080_000));
      });
    });

    describe("refundAIReservation", () => {
      it("should return reservation_not_found if operation does not exist", async () => {
        const res = await refundAIReservation("op_missing");
        expect(res.refunded).toBe(false);
        expect(res.reason).toBe("reservation_not_found");
      });

      it("should reject refund if operation was already committed", async () => {
        const opId = "op_already_done";
        ledgerTable.set(opId, {
          operationId: opId,
          userId,
          nodeName: "committed:correct:hash:100",
          modelId: "gemini-2.5-flash",
          executionMode: "STREAMING_GENERATIVE",
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 100,
          reasoningTokens: 0,
          deltaMicro: BigInt(-100000),
          status: "SETTLED",
          createdAt: new Date(),
        });

        const res = await refundAIReservation(opId);
        expect(res.refunded).toBe(false);
        expect(res.reason).toBe("already_committed");
      });

      it("should restore full debit amount to user balance and update transaction status to ABORTED", async () => {
        const opId = "op_refund_full";
        ledgerTable.set(opId, {
          operationId: opId,
          userId,
          nodeName: "reserved:correct:hash:150",
          modelId: "gemini-2.5-flash",
          executionMode: "STREAMING_GENERATIVE",
          inputTokens: 150,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          deltaMicro: BigInt(-150000),
          status: "SETTLED",
          createdAt: new Date(),
        });

        const res = await refundAIReservation(opId, "stream_failed");
        expect(res.refunded).toBe(true);

        const tx = ledgerTable.get(opId);
        expect(tx?.status).toBe("ABORTED");
        expect(tx?.nodeName).toContain("refunded:");

        // User refunded 150,000 micro-credits
        const user = usersTable.get(userId);
        expect(user?.creditBalanceMicro).toBe(BigInt(5_150_000));
      });
    });
  });
});
