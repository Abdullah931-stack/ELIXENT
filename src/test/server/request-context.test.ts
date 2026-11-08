import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    createInMemoryCookieStore,
    runWithServerRequestContext,
    getActiveRequestContext,
    resolveCookiesAndHeaders,
    scheduleAfterResponse,
    setScheduleAfterResponseListener,
    type ServerRequestContext,
} from "@/server/context/request-context";

describe("Server Request Context & Concurrency Isolation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setScheduleAfterResponseListener(null);
    });

    afterEach(() => {
        setScheduleAfterResponseListener(null);
        vi.restoreAllMocks();
    });

    describe("createInMemoryCookieStore", () => {
        it("initializes an empty cookie store when no initial cookies are passed", () => {
            const store = createInMemoryCookieStore();
            expect(store.getAll()).toEqual([]);
        });

        it("initializes an empty cookie store when an empty array is passed", () => {
            const store = createInMemoryCookieStore([]);
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
                    domain: "lugx.test",
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

        it("returns an isolated array from getAll() preventing external array mutation from corrupting state", () => {
            const store = createInMemoryCookieStore([{ name: "fixed", value: "true" }]);
            const all = store.getAll();
            all.push({ name: "injected", value: "malicious" });

            expect(store.getAll()).toEqual([{ name: "fixed", value: "true" }]);
        });

        it("preserves case sensitivity of distinct cookie names", () => {
            const store = createInMemoryCookieStore();
            store.set("SessionToken", "upper");
            store.set("sessiontoken", "lower");

            expect(store.getAll()).toEqual([
                { name: "SessionToken", value: "upper" },
                { name: "sessiontoken", value: "lower" },
            ]);
        });

        it("handles empty string cookie values and special characters correctly", () => {
            const store = createInMemoryCookieStore();
            store.set("empty_val", "");
            store.set("complex_val", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload==; value");

            expect(store.getAll()).toEqual([
                { name: "empty_val", value: "" },
                { name: "complex_val", value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload==; value" },
            ]);
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

        it("restores context to null even if the executed function throws synchronously", async () => {
            const mockContext: ServerRequestContext = {
                cookies: createInMemoryCookieStore(),
                headers: new Headers(),
            };

            await expect(
                runWithServerRequestContext(mockContext, () => {
                    throw new Error("unhandled sync error inside context");
                })
            ).rejects.toThrow("unhandled sync error inside context");

            expect(getActiveRequestContext()).toBeNull();
        });

        it("restores context to null even if the executed function throws asynchronously", async () => {
            const mockContext: ServerRequestContext = {
                cookies: createInMemoryCookieStore(),
                headers: new Headers(),
            };

            await expect(
                runWithServerRequestContext(mockContext, async () => {
                    await new Promise((r) => setTimeout(r, 5));
                    throw new Error("unhandled async error inside context");
                })
            ).rejects.toThrow("unhandled async error inside context");

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

        it("preserves parent context when inner nested context throws an error", async () => {
            const parentContext: ServerRequestContext = {
                cookies: createInMemoryCookieStore(),
                headers: new Headers({ "x-parent": "preserved" }),
            };

            const childContext: ServerRequestContext = {
                cookies: createInMemoryCookieStore(),
                headers: new Headers({ "x-child": "exploding" }),
            };

            await runWithServerRequestContext(parentContext, async () => {
                await expect(
                    runWithServerRequestContext(childContext, () => {
                        throw new Error("inner child failure");
                    })
                ).rejects.toThrow("inner child failure");

                expect(getActiveRequestContext()?.headers.get("x-parent")).toBe("preserved");
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

        it("transparently supports primitive return values, null, undefined and objects", async () => {
            const ctx: ServerRequestContext = {
                cookies: createInMemoryCookieStore(),
                headers: new Headers(),
            };

            expect(await runWithServerRequestContext(ctx, () => 42)).toBe(42);
            expect(await runWithServerRequestContext(ctx, () => false)).toBe(false);
            expect(await runWithServerRequestContext(ctx, () => null)).toBeNull();
            expect(await runWithServerRequestContext(ctx, () => undefined)).toBeUndefined();
            expect(await runWithServerRequestContext(ctx, () => ({ payload: "ok" }))).toEqual({ payload: "ok" });
        });
    });

    describe("resolveCookiesAndHeaders", () => {
        it("returns active AsyncLocalStorage context with highest priority when available", async () => {
            const activeCtx: ServerRequestContext = {
                cookies: createInMemoryCookieStore([{ name: "als_cookie", value: "yes" }]),
                headers: new Headers({ "x-from-als": "true" }),
            };

            await runWithServerRequestContext(activeCtx, async () => {
                const resolved = await resolveCookiesAndHeaders();
                expect(resolved).toBe(activeCtx);
                expect(resolved.cookies.getAll()).toEqual([{ name: "als_cookie", value: "yes" }]);
                expect(resolved.headers.get("x-from-als")).toBe("true");
            });
        });

        it("returns ephemeral in-memory cookie store and empty Headers when outside ALS context", async () => {
            const resolved = await resolveCookiesAndHeaders();

            expect(resolved).toBeDefined();
            expect(resolved.cookies.getAll()).toEqual([]);
            expect(resolved.headers).toBeInstanceOf(Headers);
            expect(Array.from(resolved.headers.entries())).toEqual([]);
        });

        it("returns independent ephemeral instances on consecutive outside-ALS calls without state leakage", async () => {
            const first = await resolveCookiesAndHeaders();
            first.cookies.set("ephemeral_leak", "leaked");
            first.headers.set("x-leak", "true");

            const second = await resolveCookiesAndHeaders();
            expect(second.cookies.getAll()).toEqual([]);
            expect(second.headers.get("x-leak")).toBeNull();
        });

        it("allows mutation on ephemeral context without throwing errors", async () => {
            const resolved = await resolveCookiesAndHeaders();
            expect(() => {
                resolved.cookies.set("guest_session", "temp_token", { path: "/" });
                resolved.cookies.delete("guest_session");
                resolved.headers.set("x-custom", "value");
            }).not.toThrow();
        });

        it("reflects mutations made to active context across multiple resolveCookiesAndHeaders() calls in the same scope", async () => {
            const ctx: ServerRequestContext = {
                cookies: createInMemoryCookieStore([{ name: "initial", value: "1" }]),
                headers: new Headers({ "x-count": "1" }),
            };

            await runWithServerRequestContext(ctx, async () => {
                const first = await resolveCookiesAndHeaders();
                first.cookies.set("added_in_scope", "2");
                first.headers.set("x-count", "2");

                const second = await resolveCookiesAndHeaders();
                expect(second.cookies.getAll()).toEqual([
                    { name: "initial", value: "1" },
                    { name: "added_in_scope", value: "2" },
                ]);
                expect(second.headers.get("x-count")).toBe("2");
            });
        });
    });

    describe("setScheduleAfterResponseListener & scheduleAfterResponse", () => {
        it("delegates synchronously to registered test listener when set", () => {
            const capturedTasks: Array<() => Promise<void> | void> = [];
            setScheduleAfterResponseListener((task) => capturedTasks.push(task));

            const taskA = vi.fn();
            const taskB = vi.fn();

            scheduleAfterResponse(taskA);
            scheduleAfterResponse(taskB);

            expect(capturedTasks).toHaveLength(2);
            expect(capturedTasks[0]).toBe(taskA);
            expect(capturedTasks[1]).toBe(taskB);
            expect(taskA).not.toHaveBeenCalled();
            expect(taskB).not.toHaveBeenCalled();

            // Intercepted tasks can be manually invoked deterministically
            capturedTasks[0]();
            expect(taskA).toHaveBeenCalledTimes(1);
        });

        it("allows dynamically swapping and clearing test listeners", () => {
            const listener1Tasks: Array<() => Promise<void> | void> = [];
            const listener2Tasks: Array<() => Promise<void> | void> = [];

            setScheduleAfterResponseListener((task) => listener1Tasks.push(task));
            scheduleAfterResponse(() => {});
            expect(listener1Tasks).toHaveLength(1);

            setScheduleAfterResponseListener((task) => listener2Tasks.push(task));
            scheduleAfterResponse(() => {});
            expect(listener2Tasks).toHaveLength(1);
            expect(listener1Tasks).toHaveLength(1);

            setScheduleAfterResponseListener(null);
        });

        it("executes task in microtask fallback when no listener is active", async () => {
            let executed = false;
            const task = vi.fn(() => {
                executed = true;
            });

            scheduleAfterResponse(task);

            // Wait for Promise microtask turn
            await new Promise((r) => setTimeout(r, 10));

            expect(executed).toBe(true);
            expect(task).toHaveBeenCalledTimes(1);
        });

        it("executes asynchronous promise-returning task in microtask fallback", async () => {
            let asyncFinished = false;
            const asyncTask = vi.fn(async () => {
                await new Promise((r) => setTimeout(r, 5));
                asyncFinished = true;
            });

            scheduleAfterResponse(asyncTask);

            await new Promise((r) => setTimeout(r, 20));

            expect(asyncFinished).toBe(true);
            expect(asyncTask).toHaveBeenCalledTimes(1);
        });

        it("resiliently catches and logs task rejection in microtask fallback without unhandled rejection", async () => {
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

        it("resiliently catches and logs synchronous exceptions thrown inside scheduled task in microtask fallback", async () => {
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            const throwingTask = vi.fn(() => {
                throw new TypeError("Synchronous settlement failure");
            });

            scheduleAfterResponse(throwingTask);

            await new Promise((r) => setTimeout(r, 15));

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "[AgentStream] Settlement flush error:",
                expect.any(TypeError)
            );

            consoleErrorSpy.mockRestore();
        });
    });
});
