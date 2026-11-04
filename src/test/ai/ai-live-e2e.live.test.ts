import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeStreamingGeneration, executeStructuredGeneration } from "@/lib/ai/client";
import { getRotationStatus } from "@/lib/ai/key-rotation";
import dotenv from "dotenv";

// Load actual local environment keys for live testing
dotenv.config({ path: ".env.local" });

describe("AI Live Integration & Key Rotation", () => {
    it("should successfully stream generation chunks using live keys", async () => {
        const streamResult = await executeStreamingGeneration({
            modelId: "gemini-2.5-flash",
            prompt: "Translate to Arabic: Artificial intelligence in LUGX is resilient and scalable.",
        });

        let fullOutput = "";
        let chunks = 0;

        for await (const chunk of streamResult.textStream) {
            chunks++;
            fullOutput += chunk;
        }

        expect(chunks).toBeGreaterThan(0);
        expect(fullOutput.trim().length).toBeGreaterThan(0);
    });

    it("should successfully execute structured generation using live keys", async () => {
        const schema = z.object({
            correctedText: z.string(),
        });

        const result = await executeStructuredGeneration({
            modelId: "gemini-2.5-flash",
            schema,
            prompt: "Improve grammar: This application have very good code architecture.",
        });

        expect(typeof result.object.correctedText).toBe("string");
        expect(result.object.correctedText.trim().length).toBeGreaterThan(0);
    });

    it("should inspect live rotation status in Upstash Redis", async () => {
        const status = await getRotationStatus();
        expect(status).toBeDefined();
        expect(typeof status.currentKeyIndex).toBe("number");
        expect(status.totalKeys).toBeGreaterThanOrEqual(1);
    });
});
