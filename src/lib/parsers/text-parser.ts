/**
 * Plain Text and Markdown File Parser
 * Reads content from .txt and .md files with UTF-8 / Windows-1256 encoding support
 */

import { countWords } from "@/lib/utils";
import { detectDocumentLanguage, type LanguageDetectionResult } from "./language-detector";

export interface TextParseResult {
    text: string;
    wordCount: number;
    language?: LanguageDetectionResult;
}

/**
 * Parse plain text or markdown file
 * @param file - File object to parse
 * @returns Parsed text content
 */
export async function parseTextFile(file: File): Promise<TextParseResult> {
    try {
        const buffer = await file.arrayBuffer();
        let text: string;
        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } catch {
            text = new TextDecoder('windows-1256').decode(buffer);
        }

        const wordCount = countWords(text);
        const language = detectDocumentLanguage(text);

        return {
            text,
            wordCount,
            language,
        };
    } catch (error) {
        throw new Error(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Parse file content based on type
 * Client-side helper for MD/TXT files
 */
export async function parseFileContent(file: File): Promise<string> {
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];

    if (extension === '.md' || extension === '.txt') {
        const result = await parseTextFile(file);
        return result.text;
    }

    throw new Error(`Unsupported file type for client-side parsing: ${extension}`);
}
