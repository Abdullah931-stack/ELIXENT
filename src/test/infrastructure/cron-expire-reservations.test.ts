import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  GET as expireReservationsGET,
  POST as expireReservationsPOST,
} from "@/app/api/cron/expire-reservations/route";
import * as aiSettlement from "@/server/services/ai-settlement-service";
import * as cronLock from "@/lib/cron/lock";
import * as redisModule from "@/lib/redis";
import { MeteringServiceUnavailableError } from "@/lib/metering/lua-scripts";

vi.mock("@/server/services/ai-settlement-service", () => ({
  flushPendingSettlementsToPostgres: vi.fn(),
}));

vi.mock("@/lib/redis", () => {
  const mockRedis = {
    smembers: vi.fn(),
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue("lock-id"),
    del: vi.fn().mockResolvedValue(1),
  };
  return {
    redis: mockRedis,
    isRedisConfigured: vi.fn(),
  };
});

describe("Cron: Batch-Draining Sweeper (/api/cron/expire-reservations) — TD-02 & Distributed Lock", () => {
  const originalEnv = process.env.CRON_SECRET;
  const TEST_SECRET = "super-secret-cron-key-123";

  beforeEach(() => {
    process.env.CRON_SECRET = TEST_SECRET;
    vi.clearAllMocks();
    vi.mocked(redisModule.isRedisConfigured).mockReturnValue(true);
    vi.mocked(redisModule.redis.smembers).mockResolvedValue([]);
    vi.mocked(redisModule.redis.set).mockResolvedValue("OK");
    vi.mocked(redisModule.redis.get).mockResolvedValue("lock-id");
    vi.mocked(redisModule.redis.del).mockResolvedValue(1);
    vi.mocked(aiSettlement.flushPendingSettlementsToPostgres).mockResolvedValue({
      flushedCount: 0,
      netDeltaMicro: BigInt(0),
    });
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalEnv;
  });

  it("should reject request with 401 Unauthorized when Authorization header is missing", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "GET",
      }
    );

    const res = await expireReservationsGET(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("Unauthorized");
    expect(
      aiSettlement.flushPendingSettlementsToPostgres
    ).not.toHaveBeenCalled();
  });

  it("should reject request with 401 Unauthorized when Bearer token is invalid", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer wrong-secret-token",
        },
      }
    );

    const res = await expireReservationsGET(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("Unauthorized");
    expect(
      aiSettlement.flushPendingSettlementsToPostgres
    ).not.toHaveBeenCalled();
  });

  it("should reject request with 401 Unauthorized when CRON_SECRET is not configured in env", async () => {
    delete process.env.CRON_SECRET;
    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_SECRET}`,
        },
      }
    );

    const res = await expireReservationsGET(req);
    expect(res.status).toBe(401);
  });

  it("should safely skip overlapping execution when distributed lock is already held", async () => {
    const spyLock = vi
      .spyOn(cronLock, "acquireCronLock")
      .mockResolvedValueOnce({
        acquired: false,
        lockKey: "cron:lock:expire-reservations",
        lockId: "conflict",
        release: vi.fn(),
      });

    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_SECRET}`,
        },
      }
    );

    const res = await expireReservationsGET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.skipped).toBe(true);
    expect(data.reason).toContain("Overlapping execution prevented");
    expect(
      aiSettlement.flushPendingSettlementsToPostgres
    ).not.toHaveBeenCalled();

    spyLock.mockRestore();
  });

  it("should execute batch draining across dirty wallets and return 200 with aggregated stats", async () => {
    vi.mocked(redisModule.redis.smembers).mockResolvedValueOnce([
      "user-1",
      "user-2",
    ]);

    vi.mocked(aiSettlement.flushPendingSettlementsToPostgres)
      .mockResolvedValueOnce({
        flushedCount: 2,
        netDeltaMicro: BigInt(-80000),
      })
      .mockResolvedValueOnce({
        flushedCount: 1,
        netDeltaMicro: BigInt(-40000),
      });

    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_SECRET}`,
        },
      }
    );

    const res = await expireReservationsGET(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.processedUsers).toBe(2);
    expect(data.flushedOperations).toBe(3);
    expect(data.netDeltaMicro).toBe("-120000");
    expect(data.timestamp).toBeDefined();

    expect(redisModule.redis.smembers).toHaveBeenCalledWith("lugx:dirty_wallets");
    expect(
      aiSettlement.flushPendingSettlementsToPostgres
    ).toHaveBeenCalledTimes(2);
    expect(
      aiSettlement.flushPendingSettlementsToPostgres
    ).toHaveBeenNthCalledWith(1, "user-1", { onlyOlderThanMs: 30000 });
    expect(
      aiSettlement.flushPendingSettlementsToPostgres
    ).toHaveBeenNthCalledWith(2, "user-2", { onlyOlderThanMs: 30000 });
  });

  it("should handle empty dirty wallets set gracefully with zero counts", async () => {
    vi.mocked(redisModule.redis.smembers).mockResolvedValueOnce([]);

    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_SECRET}`,
        },
      }
    );

    const res = await expireReservationsGET(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.processedUsers).toBe(0);
    expect(data.flushedOperations).toBe(0);
    expect(data.netDeltaMicro).toBe("0");
    expect(
      aiSettlement.flushPendingSettlementsToPostgres
    ).not.toHaveBeenCalled();
  });

  it("should execute via POST method identically to GET when authorized", async () => {
    vi.mocked(redisModule.redis.smembers).mockResolvedValueOnce(["user-post"]);
    vi.mocked(aiSettlement.flushPendingSettlementsToPostgres).mockResolvedValueOnce({
      flushedCount: 1,
      netDeltaMicro: BigInt(-25000),
    });

    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_SECRET}`,
        },
      }
    );

    const res = await expireReservationsPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.processedUsers).toBe(1);
    expect(data.flushedOperations).toBe(1);
    expect(data.netDeltaMicro).toBe("-25000");
  });

  it("should return 503 Fail-Closed when Redis is not configured and release the lock", async () => {
    vi.mocked(redisModule.isRedisConfigured).mockReturnValue(false);

    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_SECRET}`,
        },
      }
    );

    const res = await expireReservationsGET(req);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("Redis service unavailable");

    // Lock must be released cleanly, enabling subsequent call
    vi.mocked(redisModule.isRedisConfigured).mockReturnValue(true);
    const nextRes = await expireReservationsGET(req);
    expect(nextRes.status).toBe(200);
  });

  it("should return 503 when Redis smembers throws MeteringServiceUnavailableError", async () => {
    vi.mocked(redisModule.redis.smembers).mockRejectedValueOnce(
      new MeteringServiceUnavailableError("Redis connection dropped")
    );

    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_SECRET}`,
        },
      }
    );

    const res = await expireReservationsGET(req);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("Redis connection dropped");
  });

  it("should return 500 when flushPendingSettlementsToPostgres throws database error and release lock", async () => {
    vi.mocked(redisModule.redis.smembers).mockResolvedValueOnce(["user-err"]);
    vi.mocked(aiSettlement.flushPendingSettlementsToPostgres).mockRejectedValueOnce(
      new Error("Postgres deadlock detected")
    );

    const req = new NextRequest(
      "http://localhost:3000/api/cron/expire-reservations",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_SECRET}`,
        },
      }
    );

    const res = await expireReservationsGET(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("Postgres deadlock detected");

    // Subsequent call must acquire lock cleanly
    vi.mocked(redisModule.redis.smembers).mockResolvedValueOnce([]);
    const nextRes = await expireReservationsGET(req);
    expect(nextRes.status).toBe(200);
  });
});
