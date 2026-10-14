import { describe, it, expect } from "vitest";
import { parseFileContent, parseTextFile } from "@/lib/parsers/text-parser";
import { countWords } from "@/lib/utils";

describe("Text and Markdown Parser (text-parser.ts)", () => {
    it("should parse standard UTF-8 text and count words accurately", async () => {
        const content = "Hello world from vitest suite";
        const file = new File([content], "sample.txt", { type: "text/plain" });

        const result = await parseTextFile(file);
        expect(result.text).toBe(content);
        expect(result.wordCount).toBe(5);
        expect(result.language?.language).toBe("eng");
        expect(result.language?.hasEnglish).toBe(true);

        const clientParsed = await parseFileContent(file);
        expect(clientParsed).toBe(content);
    });

    it("should parse UTF-8 Arabic text file correctly", async () => {
        const content = "مرحبا بكم في منصة التحبير والتوثيق";
        const file = new File([content], "arabic.md", { type: "text/markdown" });

        const result = await parseTextFile(file);
        expect(result.text).toBe(content);
        expect(result.wordCount).toBe(6);
        expect(result.language?.language).toBe("ara");
        expect(result.language?.hasArabic).toBe(true);
    });

    it("should seamlessly decode Windows-1256 encoded Arabic text via fallback", async () => {
        // Windows-1256 byte sequence for "مرحبا بالعالم" (13 bytes)
        // مرحبا (0xE3, 0xD1, 0xCD, 0xC8, 0xC7) + space (0x20) + بالعالم (0xC8, 0xC7, 0xE1, 0xDA, 0xC7, 0xE1, 0xE3)
        const windows1256Bytes = new Uint8Array([
            0xE3, 0xD1, 0xCD, 0xC8, 0xC7, 0x20, 0xC8, 0xC7, 0xE1, 0xDA, 0xC7, 0xE1, 0xE3
        ]);

        const file = new File([windows1256Bytes], "legacy_arabic.txt", { type: "text/plain" });

        const result = await parseTextFile(file);
        expect(result.text).toBe("مرحبا بالعالم");
        // countWords uses Math.max(spaceSeparated, Math.ceil(length / 6))
        expect(result.wordCount).toBe(countWords("مرحبا بالعالم"));
        expect(result.language?.language).toBe("ara");
        expect(result.language?.hasArabic).toBe(true);

        const content = await parseFileContent(file);
        expect(content).toBe("مرحبا بالعالم");
    });

    it("should reject unsupported file extensions in parseFileContent", async () => {
        const file = new File(["some content"], "document.pdf", { type: "application/pdf" });

        await expect(parseFileContent(file)).rejects.toThrow(
            "Unsupported file type for client-side parsing: .pdf"
        );
    });
});
