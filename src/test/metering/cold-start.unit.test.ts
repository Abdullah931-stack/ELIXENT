import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureWalletLoadedFlushFirst } from "@/lib/metering/cold-start";
import { REDIS_KEYS, WALLET_TTL_SECONDS } from "@/lib/metering/constants";
import { MeteringServiceUnavailableError } from "@/lib/metering/lua-scripts";

const mockGetUserCreditBalance = vi.hoisted(() => vi.fn());
const mockFlushPendingSettlementsToPostgres = vi.hoisted(() => vi.fn());
const mockIsRedisConfigured = vi.hoisted(() => vi.fn());

vi.mock("@/server/services/ai-settlement-service", () => ({
  getUserCreditBalance: mockGetUserCreditBalance,
  flushPendingSettlementsToPostgres: mockFlushPendingSettlementsToPostgres,
}));

vi.mock("@/lib/redis", () => ({
  isRedisConfigured: mockIsRedisConfigured,
  redis: null,
}));

/**
 * High-fidelity Redis mock supporting direct functions, Map fallback, and Lua eval.
 */
class MockRedisClient {
  public store = new Map<string, string | number>();
  public hashes = new Map<string, Map<string, string>>();
  public ttls = new Map<string, number>();

  // Optional direct API implementations
  public async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  public async get(key: string): Promise<string | number | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  public async hlen(key: string): Promise<number> {
    const hash = this.hashes.get(key);
    return hash ? hash.size : 0;
  }

  public async set(
    key: string,
    value: string | number,
    options?: { nx?: boolean; ex?: number }
  ): Promise<string | null> {
    if (options?.nx && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    if (options?.ex) {
      this.ttls.set(key, options.ex);
    }
    return "OK";
  }

  public async setnx(key: string, value: string | number): Promise<number> {
    if (this.store.has(key)) {
      return 0;
    }
    this.store.set(key, value);
    return 1;
  }

  public async expire(key: string, ttl: number): Promise<number> {
    if (this.store.has(key)) {
      this.ttls.set(key, ttl);
      return 1;
    }
    return 0;
  }

  public async eval<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[]
  ): Promise<T> {
    if (script.includes("EXISTS")) {
      return (this.store.has(keys[0]) ? 1 : 0) as unknown as T;
    }
    if (script.includes("GET")) {
      return (this.store.get(keys[0]) ?? null) as unknown as T;
    }
    if (script.includes("HLEN")) {
      const hash = this.hashes.get(keys[0]);
      return (hash ? hash.size : 0) as unknown as T;
    }
    if (script.includes("SETNX")) {
      const [key] = keys;
      const [val, ttl] = args;
      if (this.store.has(key)) {
        return 0 as unknown as T;
      }
      this.store.set(key, val);
      if (ttl) {
        this.ttls.set(key, Number(ttl));
      }
      return 1 as unknown as T;
    }
    throw new Error(`Unhandled Lua script in MockRedisClient: ${script}`);
  }
}

describe("Cold-Start Wallet Preloading & Flush-First Policy (cold-start.ts)", () => {
  const userId = "usr_test_cold_start_1";
  const walletKey = REDIS_KEYS.wallet(userId);
  const pendingKey = REDIS_KEYS.pendingSettlements(userId);

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRedisConfigured.mockReturnValue(false);
  });

  describe("Redis Availability & Fail-Closed Guards", () => {
    it("should throw MeteringServiceUnavailableError when no custom client is provided and default redis is unconfigured", async () => {
      mockIsRedisConfigured.mockReturnValue(false);

      await expect(ensureWalletLoadedFlushFirst(userId)).rejects.toThrow(
        MeteringServiceUnavailableError
      );
      expect(mockGetUserCreditBalance).not.toHaveBeenCalled();
      expect(mockFlushPendingSettlementsToPostgres).not.toHaveBeenCalled();
    });

    it("should fail closed with MeteringServiceUnavailableError when redis check throws an unexpected error", async () => {
      const faultyClient = {
        exists: vi.fn().mockRejectedValue(new Error("Connection reset by peer")),
      };

      await expect(
        ensureWalletLoadedFlushFirst(userId, faultyClient as any)
      ).rejects.toThrow(MeteringServiceUnavailableError);
    });

    it("should fail closed when database lookup throws during cold start", async () => {
      const client = new MockRedisClient();
      mockGetUserCreditBalance.mockRejectedValue(new Error("Postgres connection timeout"));

      await expect(
        ensureWalletLoadedFlushFirst(userId, client as any)
      ).rejects.toThrow(MeteringServiceUnavailableError);
    });
  });

  describe("Warm Wallet Hits (Cache Hit Path)", () => {
    it("should return confirmed balance directly from warm Redis cache without querying DB or flushing", async () => {
      const client = new MockRedisClient();
      client.store.set(walletKey, "7500000");

      const balance = await ensureWalletLoadedFlushFirst(userId, client as any);

      expect(balance).toBe(BigInt(7500000));
      expect(mockFlushPendingSettlementsToPostgres).not.toHaveBeenCalled();
      expect(mockGetUserCreditBalance).not.toHaveBeenCalled();
    });

    it("should handle zero cached balance correctly", async () => {
      const client = new MockRedisClient();
      client.store.set(walletKey, "0");

      const balance = await ensureWalletLoadedFlushFirst(userId, client as any);

      expect(balance).toBe(BigInt(0));
      expect(mockGetUserCreditBalance).not.toHaveBeenCalled();
    });

    it("should handle high-precision 64-bit micro-credit balances accurately", async () => {
      const client = new MockRedisClient();
      const largeBal = "9007199254740993000"; // Exceeds JS Number.MAX_SAFE_INTEGER
      client.store.set(walletKey, largeBal);

      const balance = await ensureWalletLoadedFlushFirst(userId, client as any);

      expect(balance).toBe(BigInt(largeBal));
    });
  });

  describe("Cold Start Without Pending Settlements", () => {
    it("should query database balance, populate Redis with SETNX and 24h TTL, and return confirmed balance", async () => {
      const client = new MockRedisClient();
      mockGetUserCreditBalance.mockResolvedValue(BigInt(4200000));

      const balance = await ensureWalletLoadedFlushFirst(userId, client as any);

      expect(balance).toBe(BigInt(4200000));
      expect(mockFlushPendingSettlementsToPostgres).not.toHaveBeenCalled();
      expect(mockGetUserCreditBalance).toHaveBeenCalledWith(userId);

      // Verify Redis state populated
      expect(client.store.get(walletKey)).toBe("4200000");
      expect(client.ttls.get(walletKey)).toBe(WALLET_TTL_SECONDS);
    });

    it("should handle new user with zero balance in database", async () => {
      const client = new MockRedisClient();
      mockGetUserCreditBalance.mockResolvedValue(BigInt(0));

      const balance = await ensureWalletLoadedFlushFirst(userId, client as any);

      expect(balance).toBe(BigInt(0));
      expect(client.store.get(walletKey)).toBe("0");
      expect(client.ttls.get(walletKey)).toBe(WALLET_TTL_SECONDS);
    });
  });

  describe("Cold Start With Pending Settlements (Flush-First Policy)", () => {
    it("should flush pending settlements to PostgreSQL before querying balance to prevent reading stale data", async () => {
      const client = new MockRedisClient();
      const pendingHash = new Map<string, string>();
      pendingHash.set("op_1", JSON.stringify({ deltaMicro: -50000 }));
      client.hashes.set(pendingKey, pendingHash);

      mockFlushPendingSettlementsToPostgres.mockImplementation(async () => {
        // Pending settlements flushed, cleared in Redis
        pendingHash.clear();
      });
      mockGetUserCreditBalance.mockResolvedValue(BigInt(3950000));

      const balance = await ensureWalletLoadedFlushFirst(userId, client as any);

      expect(balance).toBe(BigInt(3950000));
      expect(mockFlushPendingSettlementsToPostgres).toHaveBeenCalledWith(
        userId,
        { customRedis: client }
      );
      expect(mockGetUserCreditBalance).toHaveBeenCalledWith(userId);
      expect(client.store.get(walletKey)).toBe("3950000");
      expect(client.ttls.get(walletKey)).toBe(WALLET_TTL_SECONDS);
    });

    it("should fail closed if flushPendingSettlementsToPostgres throws during cold start", async () => {
      const client = new MockRedisClient();
      const pendingHash = new Map<string, string>();
      pendingHash.set("op_pending_crash", JSON.stringify({ deltaMicro: -10000 }));
      client.hashes.set(pendingKey, pendingHash);

      mockFlushPendingSettlementsToPostgres.mockRejectedValue(
        new Error("Database transaction aborted due to lock contention")
      );

      await expect(
        ensureWalletLoadedFlushFirst(userId, client as any)
      ).rejects.toThrow(MeteringServiceUnavailableError);

      expect(mockGetUserCreditBalance).not.toHaveBeenCalled();
    });
  });

  describe("Concurrency & Client Compatibility Modes", () => {
    it("should handle SETNX race condition where concurrent process set wallet during resolution", async () => {
      const client = new MockRedisClient();
      mockGetUserCreditBalance.mockImplementation(async () => {
        // Another concurrent request populated the wallet while this one was querying PostgreSQL
        client.store.set(walletKey, "8000000");
        return BigInt(5000000);
      });

      // ensureWalletLoadedFlushFirst should resolve without throwing
      const balance = await ensureWalletLoadedFlushFirst(userId, client as any);
      expect(balance).toBe(BigInt(5000000));

      // Key should not be overwritten by SETNX
      expect(client.store.get(walletKey)).toBe("8000000");
    });

    it("should support in-memory Map clients without direct methods (Map fallback path)", async () => {
      const mapClient = {
        wallets: new Map<string, number>(),
        pendingSettlements: new Map<string, Map<string, string>>(),
      };
      mockGetUserCreditBalance.mockResolvedValue(BigInt(1250000));

      const balance = await ensureWalletLoadedFlushFirst(userId, mapClient as any);

      expect(balance).toBe(BigInt(1250000));
      expect(mapClient.wallets.get(walletKey)).toBe(1250000);

      // Subsequent call should hit warm Map check
      const warmBalance = await ensureWalletLoadedFlushFirst(userId, mapClient as any);
      expect(warmBalance).toBe(BigInt(1250000));
      expect(mockGetUserCreditBalance).toHaveBeenCalledTimes(1);
    });

    it("should support Lua script eval fallback clients", async () => {
      const luaOnlyClient = {
        eval: vi.fn().mockImplementation(async (script: string, keys: string[]) => {
          if (script.includes("EXISTS")) return 0;
          if (script.includes("HLEN")) return 0;
          if (script.includes("SETNX")) return 1;
          return null;
        }),
      };
      mockGetUserCreditBalance.mockResolvedValue(BigInt(990000));

      const balance = await ensureWalletLoadedFlushFirst(userId, luaOnlyClient as any);

      expect(balance).toBe(BigInt(990000));
      expect(luaOnlyClient.eval).toHaveBeenCalled();
    });
  });
});
