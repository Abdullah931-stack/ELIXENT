import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    createInMemoryCookieStore,
    runWithServerRequestContext,
    getActiveRequestContext,
    resolveCookiesAndHeaders,
    scheduleAfterResponse,
    type ServerRequestContext,
} from "@/server/context/request-context";

// Hoisted state for mocking `next/server` and `next/headers`
const { mockState } = vi.hoisted(() => ({
    mockState: {
        afterFn: undefined as ((task: () => Promise<void> | void) => void) | undefined,
        cookiesFn: undefined as (() => Promise<unknown>) | undefined,
        headersFn: undefined as (() => Promise<unknown>) | undefined,
    },
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return {
        ...actual,
        get after() {
            return mockState.afterFn;
        },
    };
});

vi.mock("next/headers", () => ({
    get cookies() {
        return mockState.cookiesFn;
    },
    get headers() {
        return mockState.headersFn;
    },
}));

describe("Server Request Context & Concurrency Isolation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockState.afterFn = undefined;
        mockState.cookiesFn = undefined;
        mockState.headersFn = undefined;
    });

    describe("createInMemoryCookieStore", () => {
        it("initializes an empty cookie store when no initial cookies are passed", () => {
            const store = createInMemoryCookieStore();
            expect(store.getAll()).toEqual([]);
        });

        it("populates initial cookies correctly", () => {
            const store = createInMemoryCookieStore([
                { name: "theme", value: "dark" },
                { name: "session_id", value: "sess_123" },
            ]);

            expect(store.getAll()).toEqual([
                { name: "theme", value: "dark" },
                { name: "session_id", value: "sess_123" },
            ]);
        });

        it("deduplicates initial cookies by name retaining the latest assignment", () => {
            const store = createInMemoryCookieStore([
                { name: "token", value: "tok_old" },
                { name: "token", value: "tok_new" },
            ]);

            expect(store.getAll()).toEqual([{ name: "token", value: "tok_new" }]);
        });

        it("sets a new cookie and updates getAll() output", () => {
            const store = createInMemoryCookieStore();
            store.set("user_id", "u_999");

            expect(store.getAll()).toEqual([{ name: "user_id", value: "u_999" }]);
        });

        it("overwrites existing cookie value on repeated set()", () => {
            const store = createInMemoryCookieStore([{ name: "role", value: "guest" }]);
            store.set("role", "admin");

            expect(store.getAll()).toEqual([{ name: "role", value: "admin" }]);
        });

        it("accepts and safely tolerates cookie options without throwing or corrupting entries", () => {
            const store = createInMemoryCookieStore();
            expect(() => {
                store.set("auth", "tok", {
                    httpOnly: true,
                    secure: true,
                    sameSite: "lax",
                    path: "/",
                    maxAge: 3600,
                });
            }).not.toThrow();

            expect(store.getAll()).toEqual([{ name: "auth", value: "tok" }]);
        });

        it("deletes a targeted cookie from the store", () => {
            const store = createInMemoryCookieStore([
                { name: "keep", value: "yes" },
                { name: "remove", value: "bye" },
            ]);

            store.delete("remove");
            expect(store.getAll()).toEqual([{ name: "keep", value: "yes" }]);
        });

        it("handles delete() on non-existent cookie key as a harmless no-op", () => {
            const store = createInMemoryCookieStore([{ name: "keep", value: "yes" }]);
            expect(() => store.delete("non_existent")).not.toThrow();
            expect(store.getAll()).toEqual([{ name: "keep", value: "yes" }]);
        });

        it("maintains strict memory isolation between independent store instances", () => {
            const storeA = createInMemoryCookieStore([{ name: "store", value: "A" }]);
            const storeB = createInMemoryCookieStore([{ name: "store", value: "B" }]);

            storeA.set("extra", "A_val");
            storeB.delete("store");

            expect(storeA.getAll()).toEqual([
                { name: "store", value: "A" },
                { name: "extra", value: "A_val" },
            ]);
            expect(storeB.getAll()).toEqual([]);
        });
    });

    describe("runWithServerRequestContext & getActiveRequestContext", () => {
        it("returns null for getActiveRequestContext when outside of an active scope", () => {
            expect(getActiveRequestContext()).toBeNull();
        });

        it("provides active context to synchronous functions within runWithServerRequestContext", async () => {
            const mockContext: ServerRequestContext = {
                cookies: createInMemoryCookieStore([{ name: "test", value: "val" }]),
                headers: new Headers({ "x-request-id": "req-sync-1" }),
            };

            const result = await runWithServerRequestContext(mockContext, () => {
                const active = getActiveRequestContext();
                expect(active).toBe(mockContext);
                expect(active?.headers.get("x-request-id")).toBe("req-sync-1");
                return "sync_return_value";
            });

            expect(result).toBe("sync_return_value");
            expect(getActiveRequestContext()).toBeNull();
        });

        it("provides active context to asynchronous functions across await hops", async () => {
            const mockContext: ServerRequestContext = {
                cookies: createInMemoryCookieStore([{ name: "test", value: "val" }]),
                headers: new Headers({ "x-request-id": "req-async-1" }),
            };

            const result = await runWithServerRequestContext(mockContext, async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                const active = getActiveRequestContext();
                expect(active).toBe(mockContext);
                await new Promise((resolve) => setTimeout(resolve, 5));
                return "async_return_value";
            });

            expect(result).toBe("async_return_value");
            expect(getActiveRequestContext()).toBeNull();
        });

        it("restores context to null even if the executed function throws", async () => {
            const mockContext: ServerRequestContext = {
                cookies: createInMemoryCookieStore(),
                headers: new Headers(),
            };

            await expect(
                runWithServerRequestContext(mockContext, () => {
                    throw new Error("unhandled error inside context");
                })
            ).rejects.toThrow("unhandled error inside context");

            expect(getActiveRequestContext()).toBeNull();
        });

        it("correctly handles nested request contexts overriding and restoring parent context", async () => {
            const parentContext: ServerRequestContext = {
                cookies: createInMemoryCookieStore([{ name: "ctx", value: "parent" }]),
                headers: new Headers({ "x-tier": "parent" }),
            };

            const childContext: ServerRequestContext = {
                cookies: createInMemoryCookieStore([{ name: "ctx", value: "child" }]),
                headers: new Headers({ "x-tier": "child" }),
            };

            await runWithServerRequestContext(parentContext, async () => {
                expect(getActiveRequestContext()?.headers.get("x-tier")).toBe("parent");

                await runWithServerRequestContext(childContext, async () => {
                    expect(getActiveRequestContext()?.headers.get("x-tier")).toBe("child");
                    await new Promise((r) => setTimeout(r, 5));
                    expect(getActiveRequestContext()?.headers.get("x-tier")).toBe("child");
                });

                expect(getActiveRequestContext()?.headers.get("x-tier")).toBe("parent");
            });

            expect(getActiveRequestContext()).toBeNull();
        });

        it("maintains strict storage isolation across concurrent async execution branches without crosstalk", async () => {
            const concurrencyCount = 20;

            const tasks = Array.from({ length: concurrencyCount }, (_, i) => {
                const reqId = `req-branch-${i}`;
                const cookieVal = `user-${i}`;

                const ctx: ServerRequestContext = {
                    cookies: createInMemoryCookieStore([{ name: "auth_user", value: cookieVal }]),
                    headers: new Headers({ "x-request-id": reqId }),
                };

                return runWithServerRequestContext(ctx, async () => {
                    // Tick 1: Immediate check
                    expect(getActiveRequestContext()?.headers.get("x-request-id")).toBe(reqId);
                    expect(getActiveRequestContext()?.cookies.getAll()).toEqual([
                        { name: "auth_user", value: cookieVal },
                    ]);

                    // Tick 2: Interleaved randomized delay simulating async network/IO
                    const jitterMs = Math.floor(Math.random() * 15) + 1;
                    await new Promise((r) => setTimeout(r, jitterMs));

                    expect(getActiveRequestContext()?.headers.get("x-request-id")).toBe(reqId);
                    expect(getActiveRequestContext()?.cookies.getAll()).toEqual([
                        { name: "auth_user", value: cookieVal },
                    ]);

                    // Mutate branch cookie store
                    getActiveRequestContext()?.cookies.set("branch_done", `done-${i}`);

                    // Tick 3: Second delay to test persistence after mutation
                    await new Promise((r) => setTimeout(r, 5));

                    expect(getActiveRequestContext()?.cookies.getAll()).toContainEqual({
                        name: "branch_done",
                        value: `done-${i}`,
                    });

                    return { reqId, cookieVal };
                });
            });

            const results = await Promise.all(tasks);
            expect(results).toHaveLength(concurrencyCount);
            results.forEach((res, i) => {
                expect(res.reqId).toBe(`req-branch-${i}`);
                expect(res.cookieVal).toBe(`user-${i}`);
            });

            expect(getActiveRequestContext()).toBeNull();
        });
    });

    describe("resolveCookiesAndHeaders", () => {
        it("returns active AsyncLocalStorage context with highest priority when available", async () => {
            const activeCtx: ServerRequestContext = {
                cookies: createInMemoryCookieStore([{ name: "als_cookie", value: "yes" }]),
                headers: new Headers({ "x-from-als": "true" }),
            };

            // Setup next/headers mock to verify it is NOT called when ALS is active
            const mockCookiesFn = vi.fn();
            mockState.cookiesFn = mockCookiesFn;

            await runWithServerRequestContext(activeCtx, async () => {
                const resolved = await resolveCookiesAndHeaders();
                expect(resolved).toBe(activeCtx);
                expect(resolved.cookies.getAll()).toEqual([{ name: "als_cookie", value: "yes" }]);
                expect(resolved.headers.get("x-from-als")).toBe("true");
            });

            expect(mockCookiesFn).not.toHaveBeenCalled();
        });

        it("resolves from mocked next/headers when outside ALS context with full cookie store", async () => {
            const mockRawCookies: Array<{ name: string; value: string }> = [
                { name: "next_auth", value: "token_abc" },
            ];
            const rawSetMock = vi.fn();
            const rawDeleteMock = vi.fn();

            mockState.cookiesFn = vi.fn(async () => ({
                getAll: () => [...mockRawCookies],
                set: rawSetMock,
                delete: rawDeleteMock,
            }));

            mockState.headersFn = vi.fn(async () => {
                return new Headers({ "x-forwarded-proto": "https" });
            });

            const resolved = await resolveCookiesAndHeaders();

            // Cookies delegation
            expect(resolved.cookies.getAll()).toEqual([{ name: "next_auth", value: "token_abc" }]);
            resolved.cookies.set("new_c", "v", { path: "/" });
            expect(rawSetMock).toHaveBeenCalledWith("new_c", "v", { path: "/" });

            resolved.cookies.delete("next_auth");
            expect(rawDeleteMock).toHaveBeenCalledWith("next_auth");

            // Headers delegation
            expect(resolved.headers.get("x-forwarded-proto")).toBe("https");
        });

        it("handles partial cookie stores missing set() by falling back to internal store without throwing", async () => {
            // Emulates Server Component read-only store or auth-signout.test.ts mock (only getAll & delete)
            const mockRawCookies: Array<{ name: string; value: string }> = [
                { name: "read_only", value: "immutable" },
            ];
            const rawDeleteMock = vi.fn();

            mockState.cookiesFn = vi.fn(async () => ({
                getAll: () => [...mockRawCookies],
                delete: rawDeleteMock,
            }));

            const resolved = await resolveCookiesAndHeaders();

            // getAll() delegates to rawStore
            expect(resolved.cookies.getAll()).toEqual([{ name: "read_only", value: "immutable" }]);

            // set() must NOT throw TypeError: rawCookieStore.set is not a function
            expect(() => {
                resolved.cookies.set("attempt_write", "value_123");
            }).not.toThrow();

            // delete() delegates to rawStore
            resolved.cookies.delete("read_only");
            expect(rawDeleteMock).toHaveBeenCalledWith("read_only");
        });

        it("handles partial cookie stores missing getAll() or delete() gracefully", async () => {
            const rawSetMock = vi.fn();
            mockState.cookiesFn = vi.fn(async () => ({
                set: rawSetMock,
            }));

            const resolved = await resolveCookiesAndHeaders();

            // getAll() falls back to in-memory store
            expect(resolved.cookies.getAll()).toEqual([]);

            // set() delegates to raw store
            resolved.cookies.set("k", "v");
            expect(rawSetMock).toHaveBeenCalledWith("k", "v", undefined);

            // delete() falls back to in-memory store without throwing
            expect(() => resolved.cookies.delete("k")).not.toThrow();
        });

        it("falls back to in-memory cookie store when next/headers cookies() throws", async () => {
            mockState.cookiesFn = vi.fn(async () => {
                throw new Error("cookies() can only be called in a Server Component or Route Handler");
            });

            const resolved = await resolveCookiesAndHeaders();

            expect(resolved.cookies.getAll()).toEqual([]);
            resolved.cookies.set("fallback_cookie", "123");
            expect(resolved.cookies.getAll()).toEqual([{ name: "fallback_cookie", value: "123" }]);
        });

        it("falls back to empty Headers when next/headers headers() throws", async () => {
            mockState.headersFn = vi.fn(async () => {
                throw new Error("headers() can only be called in a Server Component or Route Handler");
            });

            const resolved = await resolveCookiesAndHeaders();

            expect(resolved.headers).toBeInstanceOf(Headers);
            expect(resolved.headers.get("any-header")).toBeNull();
        });

        it("falls back to clean cookie store and headers when next/headers exports are undefined", async () => {
            mockState.cookiesFn = undefined;
            mockState.headersFn = undefined;

            const resolved = await resolveCookiesAndHeaders();

            expect(resolved.cookies.getAll()).toEqual([]);
            expect(resolved.headers).toBeInstanceOf(Headers);
        });
    });

    describe("scheduleAfterResponse", () => {
        it("delegates synchronously to next/server after() when available", () => {
            const mockTask = vi.fn();
            const afterSpy = vi.fn();
            mockState.afterFn = afterSpy;

            scheduleAfterResponse(mockTask);

            expect(afterSpy).toHaveBeenCalledTimes(1);
            expect(afterSpy).toHaveBeenCalledWith(mockTask);
            expect(mockTask).not.toHaveBeenCalled();
        });

        it("falls back to async microtask execution when next/server after() throws", async () => {
            let taskExecuted = false;
            const mockTask = vi.fn(async () => {
                taskExecuted = true;
            });

            mockState.afterFn = vi.fn(() => {
                throw new Error("`after` was called outside a request scope");
            });

            scheduleAfterResponse(mockTask);

            // Wait for microtask queue flush
            await new Promise((r) => setTimeout(r, 10));

            expect(taskExecuted).toBe(true);
            expect(mockTask).toHaveBeenCalledTimes(1);
        });

        it("falls back to async microtask execution when next/server after is undefined", async () => {
            let taskExecuted = false;
            const mockTask = vi.fn(() => {
                taskExecuted = true;
            });

            mockState.afterFn = undefined;

            scheduleAfterResponse(mockTask);

            await new Promise((r) => setTimeout(r, 10));

            expect(taskExecuted).toBe(true);
            expect(mockTask).toHaveBeenCalledTimes(1);
        });

        it("resiliently catches and logs task rejection in microtask fallback without unhandled promise rejection", async () => {
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            mockState.afterFn = undefined;
            const failingTask = vi.fn(async () => {
                throw new Error("Settlement flush Redis timeout");
            });

            scheduleAfterResponse(failingTask);

            await new Promise((r) => setTimeout(r, 15));

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "[AgentStream] Settlement flush error:",
                expect.any(Error)
            );

            consoleErrorSpy.mockRestore();
        });
    });
});
