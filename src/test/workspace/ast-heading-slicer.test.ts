import { describe, it, expect } from 'vitest';
import {
  parseMarkdownHeadingTree,
  extractSectionBySlug,
  generateHeadingSlug,
  computeSectionHash,
  type ExtractedSection,
} from '@/core/ast/heading-slicer';

describe('Fence-Aware AST Heading Slicer (heading-slicer.ts)', () => {
  // ==========================================================================
  // 1. Heading Slug Generation & Collision Resolution
  // ==========================================================================
  describe('generateHeadingSlug', () => {
    it('normalizes Latin titles with punctuation and whitespace to URL-friendly slugs', () => {
      const slug = generateHeadingSlug('Chapter 1: The Beginning (Part A!)');
      expect(slug).toBe('chapter-1-the-beginning-part-a');
    });

    it('preserves Arabic Unicode characters in slugs', () => {
      const slug = generateHeadingSlug('المقدمة والخلفية الهندسية');
      expect(slug).toBe('المقدمة-والخلفية-الهندسية');
    });

    it('handles mixed Arabic, English, and numeric alphanumeric characters', () => {
      const slug = generateHeadingSlug('المعيار FIPS 180-4 للأمان');
      expect(slug).toBe('المعيار-fips-180-4-للأمان');
    });

    it('resolves duplicate collisions sequentially using existingSlugs set', () => {
      const existing = new Set<string>();
      const slug1 = generateHeadingSlug('Overview', existing);
      const slug2 = generateHeadingSlug('Overview', existing);
      const slug3 = generateHeadingSlug('Overview', existing);

      expect(slug1).toBe('overview');
      expect(slug2).toBe('overview-1');
      expect(slug3).toBe('overview-2');
      expect(existing.has('overview')).toBe(true);
      expect(existing.has('overview-1')).toBe(true);
      expect(existing.has('overview-2')).toBe(true);
    });

    it('falls back to "section" when title contains only punctuation or whitespace', () => {
      expect(generateHeadingSlug('   ')).toBe('section');
      expect(generateHeadingSlug('!@#$%^&*()')).toBe('section');
      expect(generateHeadingSlug('---')).toBe('section');
    });

    it('resolves collision on fallback section title', () => {
      const existing = new Set<string>();
      const slug1 = generateHeadingSlug('???', existing);
      const slug2 = generateHeadingSlug('***', existing);
      expect(slug1).toBe('section');
      expect(slug2).toBe('section-1');
    });
  });

  // ==========================================================================
  // 2. Pure Bitwise FIPS 180-4 SHA-256 Engine & Normalization
  // ==========================================================================
  describe('computeSectionHash', () => {
    it('computes exact SHA-256 digest for standard NIST test vectors', () => {
      // Empty string NIST vector
      expect(computeSectionHash('')).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );

      // "abc" NIST vector
      expect(computeSectionHash('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );

      // 43-byte phrase NIST vector ("The quick brown fox jumps over the lazy dog")
      expect(computeSectionHash('The quick brown fox jumps over the lazy dog')).toBe(
        'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'
      );

      // With period NIST vector ("The quick brown fox jumps over the lazy dog.")
      expect(computeSectionHash('The quick brown fox jumps over the lazy dog.')).toBe(
        'ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c'
      );
    });

    it('normalizes CRLF and legacy CR line breaks to LF before hashing', () => {
      const lfText = 'Line 1\nLine 2\nLine 3';
      const crlfText = 'Line 1\r\nLine 2\r\nLine 3';
      const crText = 'Line 1\rLine 2\rLine 3';

      const lfHash = computeSectionHash(lfText);
      const crlfHash = computeSectionHash(crlfText);
      const crHash = computeSectionHash(crText);

      expect(crlfHash).toBe(lfHash);
      expect(crHash).toBe(lfHash);
    });

    it('strips null bytes before hashing to prevent poisoning', () => {
      const clean = 'Secure Payload';
      const poisoned = 'Sec\0ure Pay\0load\0';

      expect(computeSectionHash(poisoned)).toBe(computeSectionHash(clean));
    });

    it('normalizes Unicode strings to NFC before hashing', () => {
      // "é" in precomposed NFC (\u00e9) vs decomposed NFD (e + \u0301)
      const nfc = 'caf\u00e9';
      const nfd = 'cafe\u0301';

      expect(computeSectionHash(nfd)).toBe(computeSectionHash(nfc));
    });

    it('computes identical hashes for multi-block text exceeding 64 bytes (SHA-256 chunk boundary)', () => {
      const longText = 'A'.repeat(500);
      const hash1 = computeSectionHash(longText);
      const hash2 = computeSectionHash(longText);

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
    });
  });

  // ==========================================================================
  // 3. ATX Heading Detection (CommonMark §4.2)
  // ==========================================================================
  describe('parseMarkdownHeadingTree - ATX Headings', () => {
    it('parses all heading levels from 1 to 6 with appropriate hierarchy', () => {
      const md = [
        '# Level 1',
        '## Level 2',
        '### Level 3',
        '#### Level 4',
        '##### Level 5',
        '###### Level 6',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(6);
      expect(headings.map(h => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(headings.map(h => h.title)).toEqual([
        'Level 1',
        'Level 2',
        'Level 3',
        'Level 4',
        'Level 5',
        'Level 6',
      ]);
    });

    it('permits up to 3 leading spaces before # per CommonMark §4.2', () => {
      const md = [
        '# Zero Space',
        ' # One Space',
        '  ## Two Spaces',
        '   ### Three Spaces',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(4);
      expect(headings[0].title).toBe('Zero Space');
      expect(headings[1].title).toBe('One Space');
      expect(headings[2].title).toBe('Two Spaces');
      expect(headings[3].title).toBe('Three Spaces');
    });

    it('rejects lines with 4 or more leading spaces as indented code blocks', () => {
      const md = [
        '# Valid Heading',
        '    # Not A Heading (Indented 4 spaces)',
        '     ## Not A Heading (Indented 5 spaces)',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(1);
      expect(headings[0].title).toBe('Valid Heading');
    });

    it('rejects lines where # is immediately followed by non-space/non-tab characters', () => {
      const md = [
        '#Valid Heading',
        '#NotAHeading',
        '##AlsoNotAHeading',
        '### Real Heading',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(1);
      expect(headings[0].title).toBe('Real Heading');
      expect(headings[0].level).toBe(3);
    });

    it('strips optional trailing # sequences per CommonMark §4.2', () => {
      const md = [
        '# Heading 1 #',
        '## Heading 2 ###',
        '### Heading 3 #######   ',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(3);
      expect(headings[0].title).toBe('Heading 1');
      expect(headings[1].title).toBe('Heading 2');
      expect(headings[2].title).toBe('Heading 3');
    });

    it('handles empty heading titles correctly', () => {
      const md = ['#', '##   '].join('\n');
      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(2);
      expect(headings[0].title).toBe('');
      expect(headings[0].headingSlug).toBe('section');
      expect(headings[1].title).toBe('');
      expect(headings[1].headingSlug).toBe('section-1');
    });
  });

  // ==========================================================================
  // 4. CommonMark §4.5 Fenced Code Block Immunity
  // ==========================================================================
  describe('parseMarkdownHeadingTree - Fenced Code Block Immunity', () => {
    it('ignores # heading patterns inside backtick code fences', () => {
      const md = [
        '# Real Outer Heading',
        '```markdown',
        '# Fake Heading Inside Code',
        '## Another Fake Heading',
        '```',
        '## Real Subheading',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(2);
      expect(headings[0].title).toBe('Real Outer Heading');
      expect(headings[1].title).toBe('Real Subheading');
    });

    it('ignores # heading patterns inside tilde code fences', () => {
      const md = [
        '# Tilde Outer Heading',
        '~~~python',
        '# This is a Python comment',
        '## Comment block',
        '~~~',
        '## Next Section',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(2);
      expect(headings[0].title).toBe('Tilde Outer Heading');
      expect(headings[1].title).toBe('Next Section');
    });

    it('handles code fences longer than 3 characters correctly', () => {
      const md = [
        '# Outer Section',
        '````',
        '```',
        '# Still inside 4-backtick fence',
        '```',
        '````',
        '# Subsequent Section',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(2);
      expect(headings[0].title).toBe('Outer Section');
      expect(headings[1].title).toBe('Subsequent Section');
    });

    it('treats unclosed code fences as extending to document end without parsing headings', () => {
      const md = [
        '# Valid Initial Heading',
        '```typescript',
        '# Unclosed code fence line',
        '## Still inside unclosed fence',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(1);
      expect(headings[0].title).toBe('Valid Initial Heading');
    });
  });

  // ==========================================================================
  // 5. YAML Frontmatter Skipping
  // ==========================================================================
  describe('parseMarkdownHeadingTree - YAML Frontmatter Skipping', () => {
    it('skips # patterns inside frontmatter delimited by --- and ---', () => {
      const md = [
        '---',
        'title: # Ignored Title',
        'description: ## Ignored Description',
        '---',
        '# First Real Heading',
        'Content under real heading',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(1);
      expect(headings[0].title).toBe('First Real Heading');
      expect((headings[0] as unknown as Record<string, unknown>).lineNumber).toBeUndefined(); // HeadingNode uses startLine
      expect(headings[0].startLine).toBe(5);
    });

    it('skips frontmatter closed with ... delimiter', () => {
      const md = [
        '---',
        'author: John Doe',
        '# Not a heading in frontmatter',
        '...',
        '# Document Body Heading',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(1);
      expect(headings[0].title).toBe('Document Body Heading');
      expect(headings[0].startLine).toBe(5);
    });

    it('does not treat --- appearing after content as frontmatter', () => {
      const md = [
        '# Top Heading',
        'Some intro paragraph',
        '---',
        '# Section After Horizontal Rule',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(2);
      expect(headings[0].title).toBe('Top Heading');
      expect(headings[1].title).toBe('Section After Horizontal Rule');
    });
  });

  // ==========================================================================
  // 6. Breadcrumb Hierarchy & Stack Transitions
  // ==========================================================================
  describe('parseMarkdownHeadingTree - Breadcrumb Hierarchy', () => {
    it('builds strictly nested breadcrumb path for descending levels (H1 > H2 > H3)', () => {
      const md = [
        '# Architecture',
        '## Storage Layer',
        '### IndexedDB Engine',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings[0].breadcrumb).toBe('Architecture');
      expect(headings[1].breadcrumb).toBe('Architecture > Storage Layer');
      expect(headings[2].breadcrumb).toBe('Architecture > Storage Layer > IndexedDB Engine');
    });

    it('pops sibling and deeper headings when returning to equal or higher level', () => {
      const md = [
        '# Root',
        '## Section A',
        '### Subsection A.1',
        '## Section B',
        '# Next Root',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings[0].breadcrumb).toBe('Root');
      expect(headings[1].breadcrumb).toBe('Root > Section A');
      expect(headings[2].breadcrumb).toBe('Root > Section A > Subsection A.1');
      expect(headings[3].breadcrumb).toBe('Root > Section B');
      expect(headings[4].breadcrumb).toBe('Next Root');
    });

    it('handles non-consecutive level jumps (e.g. H1 directly to H4)', () => {
      const md = [
        '# Direct Root',
        '#### Deep Subsection',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings[0].breadcrumb).toBe('Direct Root');
      expect(headings[1].breadcrumb).toBe('Direct Root > Deep Subsection');
    });
  });

  // ==========================================================================
  // 7. Section Spans, Line Ranges & Exact Offsets
  // ==========================================================================
  describe('parseMarkdownHeadingTree - Section Spans & Offsets', () => {
    it('calculates startLine, endLine, startOffset, and endOffset accurately', () => {
      const md = [
        '# Section One',     // Line 1: len = 13 + \n (1) = 14
        'Content line 1.',   // Line 2: len = 15 + \n (1) = 16
        'Content line 2.',   // Line 3: len = 15 + \n (1) = 16
        '# Section Two',     // Line 4: starts at 46
        'Final text.',       // Line 5: len = 11
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(2);

      // Section One
      expect(headings[0].startLine).toBe(1);
      expect(headings[0].endLine).toBe(3);
      expect(headings[0].startOffset).toBe(0);
      expect(headings[0].endOffset).toBe(45); // Line 3 endOffset, excluding separator \n
      expect(md.slice(headings[0].startOffset, headings[0].endOffset)).toBe(
        '# Section One\nContent line 1.\nContent line 2.'
      );

      // Section Two
      expect(headings[1].startLine).toBe(4);
      expect(headings[1].endLine).toBe(5);
      expect(headings[1].startOffset).toBe(46);
      expect(headings[1].endOffset).toBe(md.length);
      expect(md.slice(headings[1].startOffset, headings[1].endOffset)).toBe(
        '# Section Two\nFinal text.'
      );
    });

    it('spans parent section over subordinate child headings (level > parent)', () => {
      const md = [
        '# Parent H1',      // Line 1
        'Parent content',   // Line 2
        '## Child H2',      // Line 3
        'Child content',    // Line 4
        '# Next H1',        // Line 5
      ].join('\n');

      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(3);

      // Parent H1 should span lines 1..4 because Line 5 is next H1 (level <= 1)
      expect(headings[0].startLine).toBe(1);
      expect(headings[0].endLine).toBe(4);

      // Child H2 should span lines 3..4
      expect(headings[1].startLine).toBe(3);
      expect(headings[1].endLine).toBe(4);

      // Next H1 should span line 5
      expect(headings[2].startLine).toBe(5);
      expect(headings[2].endLine).toBe(5);
    });

    it('accurately preserves CRLF line breaks in offset slicing', () => {
      const crlfMd = '# CRLF Heading\r\nBody line 1\r\nBody line 2\r\n# Next CRLF\r\nEnd';
      const headings = parseMarkdownHeadingTree(crlfMd);

      expect(headings).toHaveLength(2);
      expect(headings[0].startLine).toBe(1);
      expect(headings[0].endLine).toBe(3);

      const slice0 = crlfMd.slice(headings[0].startOffset, headings[0].endOffset);
      expect(slice0).toBe('# CRLF Heading\r\nBody line 1\r\nBody line 2');
    });

    it('generates deterministic 64-character hex contentHash on each heading', () => {
      const md = '# Title\nSome content';
      const headings = parseMarkdownHeadingTree(md);
      expect(headings[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(headings[0].contentHash).toBe(computeSectionHash('# Title\nSome content'));
    });
  });

  // ==========================================================================
  // 8. extractSectionBySlug Invariants
  // ==========================================================================
  describe('extractSectionBySlug', () => {
    const doc = [
      '# Introduction',
      'This is the intro body.',
      'Second intro line.',
      '## Background',
      'Background context text.',
      '# Empty Section',
      '# Conclusion',
      'The end.',
    ].join('\n');

    it('extracts complete sectionContent and subordinate sectionBody cleanly (including subordinate subsections)', () => {
      const section = extractSectionBySlug(doc, 'introduction');
      expect(section).not.toBeNull();
      const s = section as ExtractedSection;

      expect(s.heading.title).toBe('Introduction');
      expect(s.heading.headingSlug).toBe('introduction');
      expect(s.sectionContent).toBe(doc.slice(s.startOffset, s.endOffset));
      expect(s.sectionBody).toBe(
        'This is the intro body.\nSecond intro line.\n## Background\nBackground context text.'
      );
      expect(s.startLine).toBe(1);
      expect(s.endLine).toBe(5);

      // Subordinate H2 section extraction
      const subSection = extractSectionBySlug(doc, 'background');
      expect(subSection).not.toBeNull();
      expect(subSection!.heading.title).toBe('Background');
      expect(subSection!.sectionBody).toBe('Background context text.');
      expect(subSection!.startLine).toBe(4);
      expect(subSection!.endLine).toBe(5);
    });

    it('returns empty string for sectionBody when startLine === endLine (no body lines)', () => {
      const section = extractSectionBySlug(doc, 'empty-section');
      expect(section).not.toBeNull();
      const s = section as ExtractedSection;

      expect(s.startLine).toBe(s.endLine);
      expect(s.sectionBody).toBe('');
      expect(s.sectionContent).toBe('# Empty Section');
    });

    it('returns null when heading slug is not found', () => {
      const section = extractSectionBySlug(doc, 'non-existent-slug');
      expect(section).toBeNull();
    });

    it('extracts section with duplicate slug resolving via counter suffix', () => {
      const dupDoc = [
        '# Duplicate',
        'First copy',
        '# Duplicate',
        'Second copy',
      ].join('\n');

      const s1 = extractSectionBySlug(dupDoc, 'duplicate');
      const s2 = extractSectionBySlug(dupDoc, 'duplicate-1');

      expect(s1).not.toBeNull();
      expect(s2).not.toBeNull();
      expect(s1!.sectionBody).toBe('First copy');
      expect(s2!.sectionBody).toBe('Second copy');
    });
  });

  // ==========================================================================
  // 9. Document Edge Cases & Degenerate Inputs
  // ==========================================================================
  describe('Degenerate & Edge Case Handling', () => {
    it('returns empty array for empty string input', () => {
      expect(parseMarkdownHeadingTree('')).toEqual([]);
    });

    it('returns empty array for whitespace-only input', () => {
      expect(parseMarkdownHeadingTree('   \n\n  \t  \n')).toEqual([]);
    });

    it('returns empty array for document with no headings', () => {
      const noHeadings = [
        'Just some text',
        'Another line without markdown headers',
        '- list item 1',
        '- list item 2',
      ].join('\n');
      expect(parseMarkdownHeadingTree(noHeadings)).toEqual([]);
    });

    it('handles document ending with heading and no trailing newline', () => {
      const md = '# Lone Heading at EOF';
      const headings = parseMarkdownHeadingTree(md);
      expect(headings).toHaveLength(1);
      expect(headings[0].title).toBe('Lone Heading at EOF');
      expect(headings[0].startLine).toBe(1);
      expect(headings[0].endLine).toBe(1);
      expect(headings[0].startOffset).toBe(0);
      expect(headings[0].endOffset).toBe(md.length);
    });

    it('handles mixed CRLF, CR, and LF in the same document without corrupting offsets', () => {
      const mixed = '# H1\r\nLine 1\rLine 2\n# H2\nBody';
      const headings = parseMarkdownHeadingTree(mixed);
      expect(headings).toHaveLength(2);

      const h1Slice = mixed.slice(headings[0].startOffset, headings[0].endOffset);
      expect(h1Slice).toBe('# H1\r\nLine 1\rLine 2');

      const h2Slice = mixed.slice(headings[1].startOffset, headings[1].endOffset);
      expect(h2Slice).toBe('# H2\nBody');
    });
  });
});
