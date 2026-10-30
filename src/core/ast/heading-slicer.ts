/**
 * Fence-Aware AST Heading Slicer
 *
 * Implements CommonMark §4.2 and §4.5 compliant ATX heading tree parsing,
 * section span calculation, breadcrumb hierarchy tracking, and pure
 * TypeScript SHA-256 section content hashing.
 *
 * Guaranteed 100% Next.js client-side bundle safety: zero top-level
 * `node:crypto` imports, pure bitwise FIPS 180-4 SHA-256 implementation.
 */

export interface HeadingNode {
  headingSlug: string;
  title: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  breadcrumb: string;
  startLine: number;   // 1-based inclusive
  endLine: number;     // 1-based inclusive
  startOffset: number; // 0-based UTF-16 offset in original content
  endOffset: number;   // 0-based UTF-16 offset in original content (excluding separator newline before next heading)
  contentHash: string; // 64-char lowercase hex SHA-256 of normalized section content
}

export interface ExtractedSection {
  heading: HeadingNode;
  sectionContent: string; // Exact slice: content.slice(startOffset, endOffset)
  sectionBody: string;    // Subordinate lines excluding the heading line itself
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

interface LineRecord {
  lineIndex: number;    // 0-based
  lineNumber: number;   // 1-based
  text: string;         // Line content excluding trailing line break
  startOffset: number;  // UTF-16 start offset in original content
  endOffset: number;    // UTF-16 offset after text, before trailing line break
  breakLength: number;  // Length of trailing line break (0, 1, or 2)
}

interface RawHeadingRecord {
  lineIndex: number;
  lineNumber: number;
  startOffset: number;
  title: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  slug: string;
  breadcrumb: string;
}

// ---------------------------------------------------------------------------
// Pure TypeScript FIPS 180-4 SHA-256 Engine (Zero Node.js crypto dependencies)
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function pureSha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const byteLen = bytes.length;
  const bitLen = byteLen * 8;
  const wordCount = (((byteLen + 8) >> 6) + 1) << 4;
  const w = new Uint32Array(wordCount);

  for (let i = 0; i < byteLen; i++) {
    w[i >> 2] |= bytes[i] << ((3 - (i & 3)) * 8);
  }
  w[byteLen >> 2] |= 0x80 << ((3 - (byteLen & 3)) * 8);
  w[wordCount - 1] = bitLen & 0xffffffff;
  w[wordCount - 2] = Math.floor(bitLen / 0x100000000);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const W = new Uint32Array(64);

  for (let i = 0; i < wordCount; i += 16) {
    for (let j = 0; j < 16; j++) {
      W[j] = w[i + j];
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rightRotate(W[j - 15], 7) ^ rightRotate(W[j - 15], 18) ^ (W[j - 15] >>> 3);
      const s1 = rightRotate(W[j - 2], 17) ^ rightRotate(W[j - 2], 19) ^ (W[j - 2] >>> 10);
      W[j] = (W[j - 16] + s0 + W[j - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let j = 0; j < 64; j++) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[j] + W[j]) >>> 0;
      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(val => val.toString(16).padStart(8, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

/**
 * Generates a URL-friendly, Unicode-aware heading slug preserving Arabic,
 * Latin, and digit characters. Resolves duplicate collisions via `-1`, `-2`, etc.
 *
 * @param title - Raw heading title text.
 * @param existingSlugs - Optional Set of existing slugs in the current document.
 *                        Mutated when provided to track newly allocated slugs.
 * @returns Unique slug string.
 */
export function generateHeadingSlug(title: string, existingSlugs?: Set<string>): string {
  const normalized = title.normalize('NFC').toLowerCase();
  const rawSlug = normalized
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  const base = rawSlug || 'section';

  let candidate = base;
  let counter = 1;

  if (existingSlugs) {
    while (existingSlugs.has(candidate)) {
      candidate = `${base}-${counter}`;
      counter++;
    }
    existingSlugs.add(candidate);
  }

  return candidate;
}

/**
 * Computes a deterministic 64-character lowercase hex SHA-256 digest of
 * normalized section content (`\0` removed, CRLF/CR normalized to LF, Unicode NFC).
 *
 * @param sectionContent - Raw section content string.
 * @returns 64-character lowercase hex SHA-256 digest.
 */
export function computeSectionHash(sectionContent: string): string {
  const normalized = sectionContent
    .replace(/\0/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .normalize('NFC');

  return pureSha256(normalized);
}

/**
 * Parses all lines in the document while preserving exact character offsets
 * and line break sequences (`\r\n`, `\n`, or `\r`).
 */
function parseLines(content: string): LineRecord[] {
  const lines: LineRecord[] = [];
  let start = 0;
  let lineNum = 1;

  while (start < content.length) {
    let newlineIndex = -1;
    let breakLen = 0;

    for (let i = start; i < content.length; i++) {
      const ch = content.charCodeAt(i);
      if (ch === 10) {
        // \n
        newlineIndex = i;
        breakLen = 1;
        break;
      } else if (ch === 13) {
        // \r or \r\n
        if (i + 1 < content.length && content.charCodeAt(i + 1) === 10) {
          newlineIndex = i;
          breakLen = 2;
        } else {
          newlineIndex = i;
          breakLen = 1;
        }
        break;
      }
    }

    if (newlineIndex === -1) {
      lines.push({
        lineIndex: lineNum - 1,
        lineNumber: lineNum,
        text: content.slice(start),
        startOffset: start,
        endOffset: content.length,
        breakLength: 0,
      });
      break;
    } else {
      lines.push({
        lineIndex: lineNum - 1,
        lineNumber: lineNum,
        text: content.slice(start, newlineIndex),
        startOffset: start,
        endOffset: newlineIndex,
        breakLength: breakLen,
      });
      start = newlineIndex + breakLen;
      lineNum++;
    }
  }

  return lines;
}

/**
 * Parses Markdown document content into a hierarchical AST Heading tree.
 *
 * Implements:
 * 1. YAML Frontmatter skipping (delimiters `---` and closing `---` or `...`).
 * 2. CommonMark §4.5 fenced code block tracking (``` or ~~~; `#` lines inside are ignored).
 * 3. CommonMark §4.2 ATX headings (`#{1,6}` followed by space or EOL; optional trailing `#` stripped).
 * 4. Section span calculation ($L_{\text{next}} \le L$).
 * 5. Breadcrumb hierarchy generation via heading stack (`"Parent > Child"`).
 * 6. Section content hashing via pure TypeScript SHA-256.
 *
 * @param content - Full Markdown document content.
 * @returns Array of HeadingNode structures.
 */
export function parseMarkdownHeadingTree(content: string): HeadingNode[] {
  if (!content) {
    return [];
  }

  const lines = parseLines(content);
  if (lines.length === 0) {
    return [];
  }

  // Detect YAML Frontmatter at document start
  let frontmatterEndLineIndex = -1;
  if (lines[0].text.startsWith('---')) {
    for (let i = 1; i < lines.length; i++) {
      const trimmed = lines[i].text.trim();
      if (
        trimmed === '---' ||
        trimmed === '...' ||
        lines[i].text.startsWith('---') ||
        lines[i].text.startsWith('...')
      ) {
        frontmatterEndLineIndex = i;
        break;
      }
    }
  }

  let inCodeFence = false;
  let codeFenceChar = '';
  let codeFenceLength = 0;

  const rawHeadings: RawHeadingRecord[] = [];
  const existingSlugs = new Set<string>();
  const headingStack: Array<{ level: number; title: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Ignore all lines inside YAML Frontmatter
    if (frontmatterEndLineIndex !== -1 && i <= frontmatterEndLineIndex) {
      continue;
    }

    // Fenced Code Block Detection (CommonMark §4.5)
    if (!inCodeFence) {
      const openMatch = line.text.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
      if (openMatch) {
        const fence = openMatch[2];
        const char = fence[0];
        const info = openMatch[3];
        // For backticks, CommonMark §4.5 forbids backticks in the info string
        if (char !== '`' || !info.includes('`')) {
          inCodeFence = true;
          codeFenceChar = char;
          codeFenceLength = fence.length;
          continue;
        }
      }
    } else {
      const closeMatch = line.text.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
      if (
        closeMatch &&
        closeMatch[2][0] === codeFenceChar &&
        closeMatch[2].length >= codeFenceLength
      ) {
        inCodeFence = false;
        codeFenceChar = '';
        codeFenceLength = 0;
      }
      continue;
    }

    // ATX Heading Detection (CommonMark §4.2)
    const atxMatch = line.text.match(/^( {0,3})(#{1,6})(?:[ \t]+(.*)|$)/);
    if (atxMatch) {
      const level = atxMatch[2].length as 1 | 2 | 3 | 4 | 5 | 6;
      let rawTitle = atxMatch[3] !== undefined ? atxMatch[3].trim() : '';

      // Strip optional closing sequence of # characters
      rawTitle = rawTitle.replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();

      // Maintain hierarchical breadcrumb stack
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, title: rawTitle });

      const breadcrumb = headingStack.map(h => h.title).join(' > ');
      const slug = generateHeadingSlug(rawTitle, existingSlugs);

      rawHeadings.push({
        lineIndex: i,
        lineNumber: line.lineNumber,
        startOffset: line.startOffset,
        title: rawTitle,
        level,
        slug,
        breadcrumb,
      });
    }
  }

  // Compute section spans and content hashes
  const headingNodes: HeadingNode[] = [];

  for (let k = 0; k < rawHeadings.length; k++) {
    const current = rawHeadings[k];
    let nextHeading: RawHeadingRecord | null = null;

    // Next heading with level <= current.level defines the end boundary
    for (let m = k + 1; m < rawHeadings.length; m++) {
      if (rawHeadings[m].level <= current.level) {
        nextHeading = rawHeadings[m];
        break;
      }
    }

    const startLine = current.lineNumber;
    const startOffset = current.startOffset;
    let endLine: number;
    let endOffset: number;

    if (nextHeading) {
      // Span extends up to line immediately preceding next heading
      endLine = nextHeading.lineNumber - 1;
      // Separator newline before next heading is excluded
      const prevLineRecord = lines[nextHeading.lineIndex - 1];
      endOffset = prevLineRecord.endOffset;
    } else {
      // Extends to the end of the document
      endLine = lines.length;
      endOffset = content.length;
    }

    const sectionContent = content.slice(startOffset, endOffset);
    const contentHash = computeSectionHash(sectionContent);

    headingNodes.push({
      headingSlug: current.slug,
      title: current.title,
      level: current.level,
      breadcrumb: current.breadcrumb,
      startLine,
      endLine,
      startOffset,
      endOffset,
      contentHash,
    });
  }

  return headingNodes;
}

/**
 * Extracts a specific section and its subordinate body text by heading slug.
 *
 * Invariants:
 * - `content.slice(startOffset, endOffset)` strictly equals `sectionContent`.
 * - `sectionBody` contains subordinate lines excluding the heading line itself.
 * - When `startLine === endLine`, `sectionBody` is empty (`""`).
 *
 * @param content - Full Markdown document content.
 * @param headingSlug - Slug of the target heading to extract.
 * @returns ExtractedSection structure or null if slug not found.
 */
export function extractSectionBySlug(
  content: string,
  headingSlug: string
): ExtractedSection | null {
  const headings = parseMarkdownHeadingTree(content);
  const heading = headings.find(h => h.headingSlug === headingSlug);

  if (!heading) {
    return null;
  }

  const sectionContent = content.slice(heading.startOffset, heading.endOffset);
  let sectionBody = '';

  if (heading.endLine > heading.startLine) {
    const firstNewlineIndex = sectionContent.search(/\r?\n|\r/);
    if (firstNewlineIndex !== -1) {
      const breakLen = sectionContent.startsWith('\r\n', firstNewlineIndex) ? 2 : 1;
      sectionBody = sectionContent.slice(firstNewlineIndex + breakLen);
    }
  }

  return {
    heading,
    sectionContent,
    sectionBody,
    startLine: heading.startLine,
    endLine: heading.endLine,
    startOffset: heading.startOffset,
    endOffset: heading.endOffset,
  };
}
