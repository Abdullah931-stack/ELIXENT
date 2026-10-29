/**
 * Unit Tests for PDF Worker Bridge & Direct Extraction Engine
 *
 * Validates:
 * 1. Mock-free PDF text extraction using the real pdfjs-dist engine.
 * 2. Progress reporting callback accuracy.
 * 3. Immediate cancellation via AbortSignal.
 * 4. Error classification for empty/scanned PDFs and corrupted payloads.
 * 5. Text normalization and linear Markdown formatting.
 */

import { describe, it, expect, vi } from "vitest";
import { pdfWorkerBridge, PdfWorkerBridge, ExtractPdfOptions } from "@/lib/parsers/pdf-worker-bridge";
import {
    extractPdfTextDirect,
    normalizeExtractedText,
} from "@/lib/workers/pdf.worker";

/**
 * Generates a valid minimal PDF 1.4 document in memory with specified text stream.
 */
function createMinimalPdfBuffer(textContent: string): Uint8Array {
    const streamContent = `BT /F1 12 Tf 100 700 Td (${textContent}) Tj ET`;
    const streamLength = streamContent.length;

    const pdfSource = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${streamLength} >> stream
${streamContent}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
0000000253 00000 n 
0000000350 00000 n 
trailer << /Root 1 0 R /Size 6 >>
startxref
450
%%EOF`;

    return new TextEncoder().encode(pdfSource);
}

/**
 * Generates an empty PDF document (representing a scanned PDF or blank document).
 */
function createEmptyPdfBuffer(): Uint8Array {
    const streamLength = 0;

    const pdfSource = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >> endobj
4 0 obj << /Length ${streamLength} >> stream
endstream endobj
xref
0 5
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
0000000235 00000 n 
trailer << /Root 1 0 R /Size 5 >>
startxref
320
%%EOF`;

    return new TextEncoder().encode(pdfSource);
}

describe("PDF Worker Bridge & Extraction Engine", () => {
    it("extracts text correctly from valid PDF via pdfWorkerBridge", async () => {
        const testText = "LUGX Local PDF Extraction Engine";
        const pdfBytes = createMinimalPdfBuffer(testText);

        const result = await pdfWorkerBridge.extractText(pdfBytes);

        expect(result).toBeDefined();
        expect(result.text).toBe("LUGX Local PDF Extraction Engine");
        expect(result.numPages).toBe(1);
        expect(result.wordCount).toBe(5);
    });

    it("reports onProgress events during extraction", async () => {
        const testText = "Progress Reporting Test";
        const pdfBytes = createMinimalPdfBuffer(testText);

        const progressUpdates: any[] = [];
        const options: ExtractPdfOptions = {
            onProgress: (p) => progressUpdates.push(p),
        };

        const result = await pdfWorkerBridge.extractText(pdfBytes, options);

        expect(result.text).toBe("Progress Reporting Test");
        expect(progressUpdates.length).toBeGreaterThanOrEqual(1);
        expect(progressUpdates[0].currentPage).toBe(1);
        expect(progressUpdates[0].totalPages).toBe(1);
        expect(progressUpdates[0].percent).toBe(100);
    });

    it("rejects immediately when AbortSignal is pre-aborted", async () => {
        const pdfBytes = createMinimalPdfBuffer("Cancelled text");
        const controller = new AbortController();
        controller.abort();

        await expect(
            pdfWorkerBridge.extractText(pdfBytes, { signal: controller.signal })
        ).rejects.toThrow("Extraction aborted by user");
    });

    it("rejects scanned / empty PDF files with isScannedOrEmpty indicator", async () => {
        const emptyPdf = createEmptyPdfBuffer();

        await expect(pdfWorkerBridge.extractText(emptyPdf)).rejects.toThrow(
            /PDF contains no extractable text/i
        );
    });

    it("rejects invalid or corrupted binary payloads", async () => {
        const corruptedData = new TextEncoder().encode("NOT_A_VALID_PDF_HEADER");

        await expect(pdfWorkerBridge.extractText(corruptedData)).rejects.toThrow(
            /Failed to load PDF/i
        );
    });

    it("extracts text directly via extractPdfTextDirect engine", async () => {
        const testText = "Direct Engine Execution";
        const pdfBytes = createMinimalPdfBuffer(testText);

        const result = await extractPdfTextDirect(pdfBytes);

        expect(result.text).toBe("Direct Engine Execution");
        expect(result.numPages).toBe(1);
        expect(result.wordCount).toBe(3);
    });

    it("normalizes extracted text by collapsing multiple blank lines and spacing", () => {
        const raw = "Heading 1\r\n\r\n\r\nParagraph 1   with   spaces.\r\n\r\n\r\n\r\nParagraph 2";
        const normalized = normalizeExtractedText(raw);

        expect(normalized).toBe("Heading 1\n\nParagraph 1 with spaces.\n\nParagraph 2");
    });

    it("resets inactivity watchdog timer upon receiving PROGRESS message", async () => {
        vi.useFakeTimers();

        const mockWorkerInstance: any = {
            onmessage: null,
            onerror: null,
            postMessage: vi.fn(),
            terminate: vi.fn(),
        };
        class MockWorker {
            constructor() {
                return mockWorkerInstance;
            }
        }

        const originalWindow = (globalThis as any).window;
        const originalWorker = (globalThis as any).Worker;
        (globalThis as any).window = globalThis;
        (globalThis as any).Worker = MockWorker;

        try {
            const bridge = new PdfWorkerBridge(100);
            const pdfBytes = new Uint8Array([1, 2, 3]);

            const extractPromise = bridge.extractText(pdfBytes);

            expect(mockWorkerInstance).not.toBeNull();
            const requestId = mockWorkerInstance.postMessage.mock.calls[0][0].id;

            // Advance by 70ms (initial timer has 30ms remaining)
            vi.advanceTimersByTime(70);

            // Emit PROGRESS message from worker -> resets 100ms inactivity watchdog timer
            mockWorkerInstance.onmessage?.({
                data: {
                    id: requestId,
                    type: "PROGRESS",
                    currentPage: 1,
                    totalPages: 10,
                    percent: 10,
                },
            });

            // Advance by 50ms (total 120ms from start, but only 50ms since progress)
            vi.advanceTimersByTime(50);

            // Advance by remaining 60ms to trigger the reset 100ms inactivity timeout (50 + 60 = 110ms > 100ms)
            vi.advanceTimersByTime(60);

            await expect(extractPromise).rejects.toThrow(
                "PDF extraction timed out after 100ms of inactivity"
            );
        } finally {
            (globalThis as any).window = originalWindow;
            (globalThis as any).Worker = originalWorker;
            vi.useRealTimers();
        }
    });
});
