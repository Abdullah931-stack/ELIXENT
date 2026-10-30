/**
 * Path-Coupled Hybrid Lexical BM25 Search Engine
 *
 * Implements Okapi BM25 information retrieval (k1 = 1.5, b = 0.75) with
 * Robertson-Spärck Jones non-negative IDF, Arabic & Latin text normalization,
 * identifier subword extraction (camelCase, snake_case, kebab-case), and
 * ReDoS-protected Exact / Regex Token Boosting.
 *
 * Coupled with CommonMark AST heading hierarchies from `@/core/ast/heading-slicer`,
 * annotating every matched semantic chunk (paragraphs, GFM tables, fenced code blocks)
 * with `headingSlug`, `headingBreadcrumb`, and 1-based `lineRange`.
 */

import { parseMarkdownHeadingTree, type HeadingNode } from "@/core/ast/heading-slicer";

// ============================================================================
// 1. Frozen Type Contracts
// ============================================================================

export interface LexicalMatchResult {
  fileId: string;
  fileName: string;
  headingSlug: string;
  headingBreadcrumb: string;
  matchedExcerpt: string;
  lineRange: [number, number]; // 1-based [startLine, endLine]
  bm25Score: number;
}

export interface SearchDocumentTarget {
  fileId: string;
  fileName: string;
  content: string;
}

export interface BM25SearchOptions {
  maxResults?: number; // default: 10
  k1?: number;         // default: 1.5
  b?: number;          // default: 0.75
  exactBoost?: number; // default: 2.0
}

export interface DocumentChunk {
  fileId: string;
  fileName: string;
  headingSlug: string;
  headingBreadcrumb: string;
  content: string;
  lineRange: [number, number];
  tokens: string[];
}

// ============================================================================
// 2. Normalization & Tokenization
// ============================================================================

/**
 * Normalizes text for lexical search across Arabic and Latin scripts:
 * - Strips BiDi control characters (\u200E\u200F\u202A-\u202E, \u2066-\u2069).
 * - Strips Arabic Tashkeel / diacritics ([\u064B-\u065F\u0670]).
 * - Strips Arabic Tatweel / Kashida (\u0640).
 * - Unifies Alef variants ([إأآٱ] -> ا).
 * - Unifies Teh Marbuta (ة -> ه).
 * - Unifies Yeh variants ([ىئ] -> ي).
 * - Unifies Waw with Hamza (ؤ -> و).
 * - Converts Persian & Arabic-Indic digits ([٠-٩۰-۹] -> 0-9).
 * - Applies Latin case-folding (toLocaleLowerCase()).
 * - Strips non-alphanumeric punctuation.
 */
export function normalizeLexicalText(text: string): string {
  if (!text) return "";

  let s = text.toLocaleLowerCase();

  // Strip BiDi control characters
  s = s.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");

  // Strip Arabic Tashkeel / diacritics
  s = s.replace(/[\u064B-\u065F\u0670]/g, "");

  // Strip Arabic Tatweel / Kashida
  s = s.replace(/\u0640/g, "");

  // Unify Alef variants
  s = s.replace(/[إأآٱ]/g, "ا");

  // Unify Teh Marbuta
  s = s.replace(/ة/g, "ه");

  // Unify Yeh / Alef Maksura / Hamza on Yeh
  s = s.replace(/[ىئ]/g, "ي");

  // Unify Waw with Hamza
  s = s.replace(/ؤ/g, "و");

  // Convert Arabic-Indic digits (٠-٩) to standard ASCII 0-9
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

  // Convert Eastern Arabic-Indic / Persian digits (۰-۹) to standard ASCII 0-9
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

  // Strip non-alphanumeric punctuation (replace with space to avoid word coalescence)
  s = s.replace(/[^\p{L}\p{N}\s_-]/gu, " ");

  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

/**
 * Tokenizes lexical text with full identifier and Unicode word boundary support:
 * - Detects compound identifiers: camelCase, snake_case, and kebab-case.
 * - Extracts both the unified/full token and individual subwords.
 * - Normalizes tokens and matches word boundaries via Unicode `[\p{L}\p{N}]+`.
 */
export function tokenizeLexicalText(text: string): string[] {
  if (!text) return [];

  // Pre-strip BiDi controls and Tashkeel/Tatweel so letter matching succeeds without splitting
  const preCleaned = text
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "");

  // Match contiguous sequences of letters, numbers, underscores, and hyphens
  const rawWordMatches = preCleaned.match(/[\p{L}\p{N}_-]+/gu) || [];
  const tokens: string[] = [];

  for (const raw of rawWordMatches) {
    const hasSnake = raw.includes("_");
    const hasKebab = raw.includes("-");

    // Split camelCase: 'getUserById' -> 'get User By Id', 'ASTNode' -> 'AST Node'
    const splitCamel = raw
      .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
      .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2");

    const parts = splitCamel.split(/[\s_-]+/);
    const isCompound = hasSnake || hasKebab || parts.length > 1;

    if (isCompound) {
      // Add compound full token (delimiters removed)
      const unified = normalizeLexicalText(raw.replace(/[_-]+/g, ""));
      if (unified.length > 0) {
        tokens.push(unified);
      }
      // Add individual subwords
      for (const part of parts) {
        const normPart = normalizeLexicalText(part);
        if (normPart.length > 0 && normPart !== unified) {
          tokens.push(normPart);
        }
      }
    } else {
      const norm = normalizeLexicalText(raw);
      if (norm.length > 0) {
        tokens.push(norm);
      }
    }
  }

  return tokens;
}

// ============================================================================
// 3. Document Chunk Partitioning
// ============================================================================

/**
 * Validates whether a line constitutes a GitHub Flavored Markdown (GFM)
 * table delimiter row (e.g. `| :--- | :---: | ---: |`).
 */
function isTableDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const parts = inner.split("|");
  if (parts.length === 0) return false;
  return parts.every((p) => /^\s*:?-+:?\s*$/.test(p));
}

/**
 * Partitions a document into atomic semantic chunks (GFM tables, fenced code blocks,
 * paragraphs/lists), associating each chunk with its nearest enclosing `HeadingNode`.
 */
export function partitionDocumentIntoChunks(doc: SearchDocumentTarget): DocumentChunk[] {
  const content = doc.content;
  if (!content || content.trim().length === 0) {
    return [];
  }

  const lines = content.split(/\r?\n/);
  const headings: HeadingNode[] = parseMarkdownHeadingTree(content);
  const headingStartLines = new Set<number>(headings.map((h) => h.startLine));

  const findNearestHeading = (chunkStartLine: number): { slug: string; breadcrumb: string } => {
    // Nearest enclosing HeadingNode whose startLine <= chunk.startLine <= heading.endLine
    const enclosing = headings.filter(
      (h) => h.startLine <= chunkStartLine && chunkStartLine <= h.endLine
    );
    if (enclosing.length === 0) {
      return { slug: "preamble", breadcrumb: doc.fileName };
    }
    // Nearest heading is the one with highest startLine (deepest / innermost)
    enclosing.sort((a, b) => b.startLine - a.startLine || a.level - b.level);
    return { slug: enclosing[0].headingSlug, breadcrumb: enclosing[0].breadcrumb };
  };

  const chunks: DocumentChunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineNum = i + 1;
    const line = lines[i];

    // 1. Skip empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 2. Skip heading lines (they serve as structural boundaries)
    if (headingStartLines.has(lineNum)) {
      i++;
      continue;
    }

    // 3. Fenced code block: opening fence ``` or ~~~
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const startLine = lineNum;
      const blockLines: string[] = [line];
      i++;

      while (i < lines.length) {
        const curLine = lines[i];
        blockLines.push(curLine);
        const closeMatch = curLine.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
          i++;
          break;
        }
        i++;
      }

      const endLine = startLine + blockLines.length - 1;
      const blockContent = blockLines.join("\n");
      const { slug, breadcrumb } = findNearestHeading(startLine);

      chunks.push({
        fileId: doc.fileId,
        fileName: doc.fileName,
        headingSlug: slug,
        headingBreadcrumb: breadcrumb,
        content: blockContent,
        lineRange: [startLine, endLine],
        tokens: tokenizeLexicalText(blockContent),
      });
      continue;
    }

    // 4. GFM table: line contains '|' and the subsequent line is a delimiter row
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiterRow(lines[i + 1])) {
      const startLine = lineNum;
      const tableLines: string[] = [line, lines[i + 1]];
      i += 2;

      while (i < lines.length) {
        const curLine = lines[i];
        const curLineNum = i + 1;
        if (
          curLine.trim() === "" ||
          headingStartLines.has(curLineNum) ||
          !curLine.includes("|") ||
          /^ {0,3}(`{3,}|~{3,})/.test(curLine)
        ) {
          break;
        }
        tableLines.push(curLine);
        i++;
      }

      const endLine = startLine + tableLines.length - 1;
      const tableContent = tableLines.join("\n");
      const { slug, breadcrumb } = findNearestHeading(startLine);

      chunks.push({
        fileId: doc.fileId,
        fileName: doc.fileName,
        headingSlug: slug,
        headingBreadcrumb: breadcrumb,
        content: tableContent,
        lineRange: [startLine, endLine],
        tokens: tokenizeLexicalText(tableContent),
      });
      continue;
    }

    // 5. Paragraphs and lists: contiguous non-empty lines separated by empty lines,
    // headings, code blocks, or tables
    const startLine = lineNum;
    const paraLines: string[] = [line];
    i++;

    while (i < lines.length) {
      const curLine = lines[i];
      const curLineNum = i + 1;

      if (curLine.trim() === "" || headingStartLines.has(curLineNum)) {
        break;
      }
      // Boundary: code block begins
      if (/^ {0,3}(`{3,}|~{3,})/.test(curLine)) {
        break;
      }
      // Boundary: GFM table begins
      if (curLine.includes("|") && i + 1 < lines.length && isTableDelimiterRow(lines[i + 1])) {
        break;
      }

      paraLines.push(curLine);
      i++;
    }

    const endLine = startLine + paraLines.length - 1;
    const paraContent = paraLines.join("\n");
    const { slug, breadcrumb } = findNearestHeading(startLine);

    chunks.push({
      fileId: doc.fileId,
      fileName: doc.fileName,
      headingSlug: slug,
      headingBreadcrumb: breadcrumb,
      content: paraContent,
      lineRange: [startLine, endLine],
      tokens: tokenizeLexicalText(paraContent),
    });
  }

  return chunks;
}

// ============================================================================
// 4. Exact / Regex Match Evaluator (ReDoS Protected)
// ============================================================================

/**
 * Checks whether the query matches the target content literally or via regular expression.
 * Protected against ReDoS via:
 * - Length restriction (pattern <= 100 characters).
 * - Static analysis detecting catastrophic nested quantifiers (e.g. `([*+]){2,}`).
 * - Guaranteed try/catch fallback to case-insensitive literal substring matching.
 */
function isExactOrRegexMatch(query: string, content: string): boolean {
  if (!query || !content) return false;

  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // 1. Fast literal substring match
  if (lowerContent.includes(lowerQuery)) {
    return true;
  }

  // 2. Safe regular expression matching
  let pattern = query;
  let flags = "iu";

  // Handle explicit `/pattern/flags` syntax
  if (query.length > 2 && query.startsWith("/") && query.lastIndexOf("/") > 0) {
    const lastSlash = query.lastIndexOf("/");
    pattern = query.slice(1, lastSlash);
    const customFlags = query.slice(lastSlash + 1);
    if (customFlags) {
      flags = Array.from(new Set((customFlags + "iu").split(""))).join("");
    }
  }

  // ReDoS Protection 1: Length cap
  if (pattern.length > 100) {
    return false;
  }

  // ReDoS Protection 2: Nested quantifier guard
  const hasDangerousNestedQuantifier =
    /([*+]|\{\d+,?\d*\})\s*([*+]|\{\d+,?\d*\})/.test(pattern) ||
    /\([^)]*([*+]|\{\d+,?\d*\})[^)]*\)\s*([*+]|\{\d+,?\d*\})/.test(pattern) ||
    /\.\*.*\.\*/.test(pattern);

  if (hasDangerousNestedQuantifier) {
    return false;
  }

  // ReDoS Protection 3: Execution inside try/catch
  try {
    const regex = new RegExp(pattern, flags);
    return regex.test(content);
  } catch {
    return false;
  }
}

// ============================================================================
// 5. Okapi BM25 Search Engine
// ============================================================================

export class LexicalBM25SearchEngine {
  private chunks: DocumentChunk[] = [];
  private options: Required<BM25SearchOptions>;
  private docFreq: Map<string, number> = new Map();
  private avgdl: number = 0;

  constructor(chunks: DocumentChunk[] = [], options?: BM25SearchOptions) {
    this.options = {
      maxResults: options?.maxResults ?? 10,
      k1: options?.k1 ?? 1.5,
      b: options?.b ?? 0.75,
      exactBoost: options?.exactBoost ?? 2.0,
    };
    if (chunks.length > 0) {
      this.indexChunks(chunks);
    }
  }

  /**
   * Replaces all indexed chunks and rebuilds document frequencies and average document length.
   */
  public indexChunks(chunks: DocumentChunk[]): void {
    this.chunks = [...chunks];
    this.docFreq.clear();

    const N = this.chunks.length;
    if (N === 0) {
      this.avgdl = 0;
      return;
    }

    let totalTokens = 0;
    for (const chunk of this.chunks) {
      totalTokens += chunk.tokens.length;
      const seenTerms = new Set(chunk.tokens);
      for (const term of seenTerms) {
        this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
      }
    }

    this.avgdl = totalTokens / N;
  }

  /**
   * Appends additional chunks to the index and updates corpus statistics.
   */
  public addChunks(chunks: DocumentChunk[]): void {
    this.indexChunks([...this.chunks, ...chunks]);
  }

  /**
   * Returns a copy of the currently indexed document chunks.
   */
  public getChunks(): DocumentChunk[] {
    return [...this.chunks];
  }

  /**
   * Searches indexed chunks using Okapi BM25 scoring with exact/regex boosting.
   *
   * Okapi BM25 Parameters:
   * - k1 = 1.5, b = 0.75
   * - Robertson-Spärck Jones non-negative IDF: ln(1 + (N - n(q_i) + 0.5) / (n(q_i) + 0.5))
   * - Guarded against division by zero (empty index, avgdl = 0).
   * - Deterministic tie-breaking: bm25Score desc, fileId asc, lineRange[0] asc.
   */
  public search(query: string, searchOptions?: BM25SearchOptions): LexicalMatchResult[] {
    const N = this.chunks.length;
    if (N === 0 || !query || query.trim().length === 0) {
      return [];
    }

    const maxResults = searchOptions?.maxResults ?? this.options.maxResults;
    const k1 = searchOptions?.k1 ?? this.options.k1;
    const b = searchOptions?.b ?? this.options.b;
    const exactBoost = searchOptions?.exactBoost ?? this.options.exactBoost;

    const queryTokens = tokenizeLexicalText(query);
    const uniqueQueryTerms = Array.from(new Set(queryTokens));

    const scoredMatches: { chunk: DocumentChunk; score: number }[] = [];

    for (const chunk of this.chunks) {
      const chunkLen = chunk.tokens.length;
      // Protected division by zero when avgdl === 0
      const dlRatio = this.avgdl > 0 ? chunkLen / this.avgdl : 0;

      // Calculate term frequencies f(q_i, D) in the current chunk
      const termFreqs = new Map<string, number>();
      for (const token of chunk.tokens) {
        termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
      }

      let bm25Score = 0;
      for (const term of uniqueQueryTerms) {
        const freq = termFreqs.get(term) || 0;
        if (freq === 0) continue;

        const n_qi = this.docFreq.get(term) || 0;
        // Robertson-Spärck Jones non-negative IDF
        const idf = Math.log(1 + (N - n_qi + 0.5) / (n_qi + 0.5));
        // BM25 term frequency saturation
        const denom = freq + k1 * (1 - b + b * dlRatio);
        const termScore = denom > 0 ? (idf * (freq * (k1 + 1))) / denom : 0;
        bm25Score += termScore;
      }

      // Exact / Regex Token Boost
      const matchesExact =
        isExactOrRegexMatch(query, chunk.content) ||
        (chunk.headingBreadcrumb ? isExactOrRegexMatch(query, chunk.headingBreadcrumb) : false);

      let finalScore = bm25Score;
      if (matchesExact) {
        const baseScore = finalScore > 0 ? finalScore : (uniqueQueryTerms.length === 0 ? 1.0 : 0);
        if (baseScore > 0) {
          finalScore = baseScore * exactBoost;
        }
      }

      if (finalScore > 0) {
        scoredMatches.push({ chunk, score: finalScore });
      }
    }

    // Deterministic sort: bm25Score desc, tie-breaker fileId asc, lineRange[0] asc
    scoredMatches.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const fileCmp = a.chunk.fileId.localeCompare(b.chunk.fileId);
      if (fileCmp !== 0) {
        return fileCmp;
      }
      return a.chunk.lineRange[0] - b.chunk.lineRange[0];
    });

    return scoredMatches.slice(0, maxResults).map(({ chunk, score }) => ({
      fileId: chunk.fileId,
      fileName: chunk.fileName,
      headingSlug: chunk.headingSlug,
      headingBreadcrumb: chunk.headingBreadcrumb,
      matchedExcerpt: chunk.content,
      lineRange: chunk.lineRange,
      bm25Score: score,
    }));
  }
}

// ============================================================================
// 6. searchLexicalWithASTBreadcrumb High-Level Orchestrator
// ============================================================================

/**
 * Executes a path-coupled lexical search across multiple document targets:
 * 1. Partitions all documents into semantic chunks via AST heading slicing.
 * 2. Indexes chunks with corpus statistics (Robertson-Spärck Jones IDF, avgdl).
 * 3. Applies Okapi BM25 scoring with exact/regex boosting and deterministic ordering.
 *
 * @param params - Search parameters: documents, query, maxResults, options.
 * @returns Array of LexicalMatchResult annotated with AST breadcrumbs and line ranges.
 */
export function searchLexicalWithASTBreadcrumb(params: {
  documents: SearchDocumentTarget[];
  query: string;
  maxResults?: number;
  options?: BM25SearchOptions;
}): LexicalMatchResult[] {
  if (
    !params.documents ||
    params.documents.length === 0 ||
    !params.query ||
    params.query.trim().length === 0
  ) {
    return [];
  }

  const allChunks: DocumentChunk[] = [];
  for (const doc of params.documents) {
    const docChunks = partitionDocumentIntoChunks(doc);
    allChunks.push(...docChunks);
  }

  if (allChunks.length === 0) {
    return [];
  }

  const effectiveOptions: BM25SearchOptions = {
    maxResults: params.maxResults ?? params.options?.maxResults ?? 10,
    k1: params.options?.k1 ?? 1.5,
    b: params.options?.b ?? 0.75,
    exactBoost: params.options?.exactBoost ?? 2.0,
  };

  const engine = new LexicalBM25SearchEngine(allChunks, effectiveOptions);
  return engine.search(params.query, effectiveOptions);
}
