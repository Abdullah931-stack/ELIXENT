import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Features Configuration (src/config/features.config.ts)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("enforces canonical numeric constants for reservation TTL and preview buffer ceiling", async () => {
        const { FEATURES } = await import("@/config/features.config");
        expect(FEATURES.RESERVATION_TTL_MS).toBe(300_000);
        expect(FEATURES.PREVIEW_BUFFER_MAX_CHARS).toBe(500_000);
    });

    it("resolves AI_STREAMING_ENABLED to true when VITE_AI_STREAMING_ENABLED is string 'true'", async () => {
        process.env.VITE_AI_STREAMING_ENABLED = "true";
        delete process.env.NEXT_PUBLIC_AI_STREAMING_ENABLED;

        const { FEATURES } = await import("@/config/features.config");
        expect(FEATURES.AI_STREAMING_ENABLED).toBe(true);
    });

    it("resolves AI_STREAMING_ENABLED to true when NEXT_PUBLIC_AI_STREAMING_ENABLED is string 'true'", async () => {
        delete process.env.VITE_AI_STREAMING_ENABLED;
        process.env.NEXT_PUBLIC_AI_STREAMING_ENABLED = "true";

        const { FEATURES } = await import("@/config/features.config");
        expect(FEATURES.AI_STREAMING_ENABLED).toBe(true);
    });

    it("evaluates VITE_AI_STREAMING_ENABLED with precedence over NEXT_PUBLIC_AI_STREAMING_ENABLED", async () => {
        process.env.VITE_AI_STREAMING_ENABLED = "false";
        process.env.NEXT_PUBLIC_AI_STREAMING_ENABLED = "true";

        const { FEATURES } = await import("@/config/features.config");
        // "false" is a non-empty string and thus truthy in the logical OR chain; ("false" === "true") -> false
        expect(FEATURES.AI_STREAMING_ENABLED).toBe(false);
    });

    it.each([
        [undefined, "undefined/missing"],
        ["", "empty string"],
        ["false", "string 'false'"],
        ["0", "numeric string '0'"],
        ["no", "string 'no'"],
        ["TRUE", "uppercase string 'TRUE'"],
        ["enabled", "string 'enabled'"],
    ])("evaluates AI_STREAMING_ENABLED to false when flag is %s (%s)", async (val, _label) => {
        vi.resetModules();
        if (val === undefined) {
            delete process.env.VITE_AI_STREAMING_ENABLED;
            delete process.env.NEXT_PUBLIC_AI_STREAMING_ENABLED;
        } else {
            process.env.VITE_AI_STREAMING_ENABLED = val;
            delete process.env.NEXT_PUBLIC_AI_STREAMING_ENABLED;
        }

        const { FEATURES } = await import("@/config/features.config");
        expect(FEATURES.AI_STREAMING_ENABLED).toBe(false);
    });
});
