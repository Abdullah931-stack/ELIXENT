import { describe, test, expect } from "vitest";
import { classifyGeminiError, shouldRotateOnError } from "@/lib/ai/key-rotation";

describe("Phase 11: Gemini HTTP 400 Key-Failure Error Classification", () => {
    const AUTH_400_VECTORS = [
        {
            label: "API key not valid",
            error: Object.assign(new Error("API key not valid. Please pass a valid API key. [400 Bad Request]"), { status: 400 }),
            checkModelRetry: true,
        },
        {
            label: "SERVICE_DISABLED",
            error: {
                message: "Generative Language API has not been used in project 123456 before or it is disabled. Enable it by visiting...",
                status: 400,
            },
            checkModelRetry: false,
        },
        {
            label: "API_KEY_INVALID",
            error: {
                message: "Request failed with error: API_KEY_INVALID",
                status: 400,
            },
            checkModelRetry: false,
        },
        {
            label: "consumer_suspended",
            error: {
                message: "Consumer suspended. The project or API key is suspended.",
                status: 400,
            },
            checkModelRetry: false,
        },
    ];

    test.each(AUTH_400_VECTORS)(
        "classifies HTTP 400 with '$label' as authentication and retryable with key",
        ({ error, checkModelRetry }) => {
            const classification = classifyGeminiError(error);

            expect(classification.category).toBe("authentication");
            expect(classification.statusCode).toBe(400);
            expect(classification.retryableWithKey).toBe(true);
            if (checkModelRetry) {
                expect(classification.retryableWithModel).toBe(false);
            }
        }
    );

    const NON_AUTH_400_VECTORS = [
        {
            label: "invalid argument",
            error: Object.assign(new Error("Invalid argument: prompt exceeds maximum tokens or malformed payload [400 Bad Request]"), { status: 400 }),
        },
    ];

    test.each(NON_AUTH_400_VECTORS)(
        "preserves non-auth HTTP 400 ('$label') as invalid_request and NOT retryable with key",
        ({ error }) => {
            const classification = classifyGeminiError(error);

            expect(classification.category).toBe("invalid_request");
            expect(classification.statusCode).toBe(400);
            expect(classification.retryableWithKey).toBe(false);
            expect(classification.retryableWithModel).toBe(false);
        }
    );

    const MODEL_NOT_FOUND_404_VECTORS = [
        {
            label: "explicit HTTP 404 status",
            error: Object.assign(new Error("Request failed with status 404"), { status: 404 }),
        },
        {
            label: "model not found message",
            error: new Error("Requested model not found in registry"),
        },
        {
            label: "Google v1beta is not found message",
            error: new Error("models/gemini-3.8-flash is not found for API version v1beta"),
        },
        {
            label: "not supported for generateContent message",
            error: new Error("models/embedding-001 is not supported for generateContent"),
        },
    ];

    test.each(MODEL_NOT_FOUND_404_VECTORS)(
        "classifies 404 / model-not-found ('$label') as invalid_request and non-rotatable",
        ({ error }) => {
            const classification = classifyGeminiError(error);

            expect(classification.category).toBe("invalid_request");
            expect(classification.statusCode).toBe(404);
            expect(classification.retryableWithKey).toBe(false);
            expect(classification.retryableWithModel).toBe(false);
            expect(shouldRotateOnError(error)).toBe(false);
        }
    );
});
