import { describe, it, expect } from 'vitest';
import {
  normalizeLexicalText,
  tokenizeLexicalText,
  partitionDocumentIntoChunks,
  LexicalBM25SearchEngine,
  searchLexicalWithASTBreadcrumb,
  type SearchDocumentTarget,
  type DocumentChunk,
} from '@/core/workspace/lexical-bm25';

describe('Path-Coupled Hybrid BM25 Search Engine (lexical-bm25.ts)', () => {
  // ==========================================================================
  // 1. Text Normalization (Arabic, Latin, Digits, Punctuation)
  // ==========================================================================
  describe('normalizeLexicalText', () => {
    it('strips BiDi control characters', () => {
      // \u200E (LRM), \u200F (RLM), \u202A (LRE), \u202C (PDF)
      const bidiText = '\u200EHello\u200F \u202AWorld\u202C';
      expect(normalizeLexicalText(bidiText)).toBe('hello world');
    });

    it('strips Arabic Tashkeel (diacritics) and Tatweel (kashida)', () => {
      // Fatha, Damma, Kasra, Shadda, Sukun, Tatweel
      const diacriticArabic = 'الْمُسْــــتَخْدِمُ';
      expect(normalizeLexicalText(diacriticArabic)).toBe('المستخدم');
    });

    it('unifies Alef variants (إ, أ, آ, ٱ) into bare Alef (ا)', () => {
      expect(normalizeLexicalText('إدارة')).toBe('اداره'); // also unifies Teh Marbuta to Heh
      expect(normalizeLexicalText('أحمد')).toBe('احمد');
      expect(normalizeLexicalText('آلة')).toBe('اله');
      expect(normalizeLexicalText('ٱسم')).toBe('اسم');
    });

    it('unifies Teh Marbuta (ة) into Heh (ه)', () => {
      expect(normalizeLexicalText('مكتبة جامعة')).toBe('مكتبه جامعه');
    });

    it('unifies Yeh variants (ى, ئ) into Yeh (ي) and Waw with Hamza (ؤ) into Waw (و)', () => {
      expect(normalizeLexicalText('مستشفى')).toBe('مستشفي');
      expect(normalizeLexicalText('شاطئ')).toBe('شاطي');
      expect(normalizeLexicalText('مسؤولية')).toBe('مسووليه');
    });

    it('converts Arabic-Indic (٠-٩) and Persian (۰-۹) digits to standard ASCII digits', () => {
      const arabicIndic = 'الفرع ١٢٣، الغرفة ٤٥٦';
      const persian = 'کد ۷۸۹۰';

      expect(normalizeLexicalText(arabicIndic)).toBe('الفرع 123 الغرفه 456');
      expect(normalizeLexicalText(persian)).toBe('کد 7890');
    });

    it('applies lowercase case-folding to Latin text', () => {
      expect(normalizeLexicalText('Elixent Vault ARCHITECTURE')).toBe(
        'elixent vault architecture'
      );
    });

    it('replaces non-alphanumeric punctuation with spaces avoiding word coalescence', () => {
      expect(normalizeLexicalText('user.profile_data-v2')).toBe('user profile_data-v2');
      expect(normalizeLexicalText('alpha/beta:gamma?delta!')).toBe('alpha beta gamma delta');
    });

    it('collapses whitespace and handles empty or falsy inputs', () => {
      expect(normalizeLexicalText('   multi    space   text   ')).toBe('multi space text');
      expect(normalizeLexicalText('')).toBe('');
      expect(normalizeLexicalText('   ')).toBe('');
    });
  });

  // ==========================================================================
  // 2. Tokenization & Compound Identifier Splitting
  // ==========================================================================
  describe('tokenizeLexicalText', () => {
    it('tokenizes simple Latin and Arabic words', () => {
      const tokens = tokenizeLexicalText('Hello world من الرياض');
      expect(tokens).toEqual(['hello', 'world', 'من', 'الرياض']);
    });

    it('splits camelCase identifiers into unified token and subwords', () => {
      const tokens = tokenizeLexicalText('getUserProfileById');
      expect(tokens).toContain('getuserprofilebyid'); // unified
      expect(tokens).toContain('get');
      expect(tokens).toContain('user');
      expect(tokens).toContain('profile');
      expect(tokens).toContain('by');
      expect(tokens).toContain('id');
    });

    it('splits snake_case identifiers into unified token and subwords', () => {
      const tokens = tokenizeLexicalText('vault_master_key_derivation');
      expect(tokens).toContain('vaultmasterkeyderivation');
      expect(tokens).toContain('vault');
      expect(tokens).toContain('master');
      expect(tokens).toContain('key');
      expect(tokens).toContain('derivation');
    });

    it('splits kebab-case identifiers into unified token and subwords', () => {
      const tokens = tokenizeLexicalText('ast-heading-slicer');
      expect(tokens).toContain('astheadingslicer');
      expect(tokens).toContain('ast');
      expect(tokens).toContain('heading');
      expect(tokens).toContain('slicer');
    });

    it('handles acronym camelCase identifiers (e.g. ASTParser, HTTPServer)', () => {
      const tokens = tokenizeLexicalText('ASTParserHTTPServer');
      expect(tokens).toContain('astparserhttpserver');
      expect(tokens).toContain('ast');
      expect(tokens).toContain('parser');
      expect(tokens).toContain('http');
      expect(tokens).toContain('server');
    });

    it('strips diacritics before matching word boundaries so Arabic tokens remain intact', () => {
      const tokens = tokenizeLexicalText('الْمُحَرِّرُ النَّصِّيُّ');
      expect(tokens).toEqual(['المحرر', 'النصي']);
    });

    it('returns empty array for empty or whitespace text', () => {
      expect(tokenizeLexicalText('')).toEqual([]);
      expect(tokenizeLexicalText('   \n\t   ')).toEqual([]);
    });
  });

  // ==========================================================================
  // 3. Document Chunk Partitioning
  // ==========================================================================
  describe('partitionDocumentIntoChunks', () => {
    it('returns empty array for empty or whitespace document', () => {
      const emptyDoc: SearchDocumentTarget = {
        fileId: 'f-1',
        fileName: 'empty.md',
        content: '   \n  \n  ',
      };
      expect(partitionDocumentIntoChunks(emptyDoc)).toEqual([]);
    });

    it('partitions preamble before any heading with slug "preamble" and doc fileName breadcrumb', () => {
      const doc: SearchDocumentTarget = {
        fileId: 'f-preamble',
        fileName: 'guide.md',
        content: [
          'This is preamble text at the top of the file.',
          'Still preamble.',
          '',
          '# First Heading',
          'Body under first heading.',
        ].join('\n'),
      };

      const chunks = partitionDocumentIntoChunks(doc);
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      const preambleChunk = chunks[0];
      expect(preambleChunk.headingSlug).toBe('preamble');
      expect(preambleChunk.headingBreadcrumb).toBe('guide.md');
      expect(preambleChunk.lineRange).toEqual([1, 2]);
      expect(preambleChunk.content).toBe('This is preamble text at the top of the file.\nStill preamble.');
    });

    it('partitions fenced code blocks as atomic semantic chunks', () => {
      const doc: SearchDocumentTarget = {
        fileId: 'f-code',
        fileName: 'code.md',
        content: [
          '# Code Examples',
          'Paragraph before code.',
          '',
          '```typescript',
          'const x = 10;',
          'console.log(x);',
          '```',
          '',
          'Paragraph after code.',
        ].join('\n'),
      };

      const chunks = partitionDocumentIntoChunks(doc);
      expect(chunks).toHaveLength(3);

      const codeChunk = chunks[1];
      expect(codeChunk.content).toBe('```typescript\nconst x = 10;\nconsole.log(x);\n```');
      expect(codeChunk.lineRange).toEqual([4, 7]);
      expect(codeChunk.headingSlug).toBe('code-examples');
      expect(codeChunk.headingBreadcrumb).toBe('Code Examples');
    });

    it('partitions GFM tables as atomic semantic chunks', () => {
      const doc: SearchDocumentTarget = {
        fileId: 'f-table',
        fileName: 'table.md',
        content: [
          '# Table Specification',
          '',
          '| Name | Type | Description |',
          '| :--- | :---: | ---: |',
          '| fileId | string | Unique UUID |',
          '| size | number | Byte count |',
          '',
          'Post-table paragraph.',
        ].join('\n'),
      };

      const chunks = partitionDocumentIntoChunks(doc);
      expect(chunks).toHaveLength(2);

      const tableChunk = chunks[0];
      expect(tableChunk.lineRange).toEqual([3, 6]);
      expect(tableChunk.content).toContain('| Name | Type | Description |');
      expect(tableChunk.content).toContain('| size | number | Byte count |');
      expect(tableChunk.headingSlug).toBe('table-specification');
    });

    it('associates chunks with innermost nested heading in hierarchy', () => {
      const doc: SearchDocumentTarget = {
        fileId: 'f-nested',
        fileName: 'nested.md',
        content: [
          '# Architecture',
          'Architecture overview paragraph.',
          '',
          '## Storage Engine',
          'Storage engine paragraph.',
          '',
          '### IndexedDB Layer',
          'IndexedDB details paragraph.',
        ].join('\n'),
      };

      const chunks = partitionDocumentIntoChunks(doc);
      expect(chunks).toHaveLength(3);

      expect(chunks[0].headingSlug).toBe('architecture');
      expect(chunks[0].headingBreadcrumb).toBe('Architecture');

      expect(chunks[1].headingSlug).toBe('storage-engine');
      expect(chunks[1].headingBreadcrumb).toBe('Architecture > Storage Engine');

      expect(chunks[2].headingSlug).toBe('indexeddb-layer');
      expect(chunks[2].headingBreadcrumb).toBe('Architecture > Storage Engine > IndexedDB Layer');
    });
  });

  // ==========================================================================
  // 4. Okapi BM25 Ranking Engine
  // ==========================================================================
  describe('LexicalBM25SearchEngine', () => {
    const mockChunks: DocumentChunk[] = [
      {
        fileId: 'doc-1',
        fileName: 'crypto.md',
        headingSlug: 'key-management',
        headingBreadcrumb: 'Security > Key Management',
        content: 'PBKDF2 key derivation provides robust Master Key security and encryption.',
        lineRange: [5, 6],
        tokens: tokenizeLexicalText('PBKDF2 key derivation provides robust Master Key security and encryption.'),
      },
      {
        fileId: 'doc-2',
        fileName: 'sync.md',
        headingSlug: 'offline-sync',
        headingBreadcrumb: 'Sync > Offline Protocol',
        content: 'IndexedDB caching allows offline document synchronization and conflict resolution.',
        lineRange: [10, 11],
        tokens: tokenizeLexicalText('IndexedDB caching allows offline document synchronization and conflict resolution.'),
      },
      {
        fileId: 'doc-3',
        fileName: 'ai.md',
        headingSlug: 'ai-streaming',
        headingBreadcrumb: 'AI > Streaming',
        content: 'AI streaming engine provides real-time token generation and abort latency protection.',
        lineRange: [20, 21],
        tokens: tokenizeLexicalText('AI streaming engine provides real-time token generation and abort latency protection.'),
      },
    ];

    it('ranks relevant documents higher based on term specificity (Robertson-Spärck Jones IDF)', () => {
      const engine = new LexicalBM25SearchEngine(mockChunks);
      const results = engine.search('PBKDF2 Master Key');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].fileId).toBe('doc-1');
      expect(results[0].headingSlug).toBe('key-management');
      expect(results[0].bm25Score).toBeGreaterThan(0);
    });

    it('returns empty array when query does not match any terms or is empty', () => {
      const engine = new LexicalBM25SearchEngine(mockChunks);
      expect(engine.search('')).toEqual([]);
      expect(engine.search('   ')).toEqual([]);
      expect(engine.search('nonexistenttermxyz')).toEqual([]);
    });

    it('applies exact boost when query matches content literally', () => {
      const engine = new LexicalBM25SearchEngine(mockChunks, { exactBoost: 3.0 });
      const results = engine.search('Master Key');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].fileId).toBe('doc-1');
      // The score should reflect the 3.0x multiplier
      expect(results[0].bm25Score).toBeGreaterThan(1.0);
    });

    it('applies exact boost when query matches headingBreadcrumb', () => {
      const engine = new LexicalBM25SearchEngine(mockChunks, { exactBoost: 2.5 });
      const results = engine.search('Key Management');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].fileId).toBe('doc-1');
      expect(results[0].headingBreadcrumb).toBe('Security > Key Management');
    });

    it('supports custom regex search syntax /pattern/flags', () => {
      const engine = new LexicalBM25SearchEngine(mockChunks);
      const results = engine.search('/offline.*synchronization/i');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].fileId).toBe('doc-2');
      expect(results[0].matchedExcerpt).toContain('offline document synchronization');
    });

    it('enforces deterministic tie-breaking (bm25Score desc, fileId asc, lineRange[0] asc)', () => {
      const identicalChunks: DocumentChunk[] = [
        {
          fileId: 'b-doc',
          fileName: 'b.md',
          headingSlug: 'slug-b',
          headingBreadcrumb: 'Breadcrumb',
          content: 'Identical common content token',
          lineRange: [10, 12],
          tokens: ['identical', 'common', 'content', 'token'],
        },
        {
          fileId: 'a-doc',
          fileName: 'a.md',
          headingSlug: 'slug-a2',
          headingBreadcrumb: 'Breadcrumb',
          content: 'Identical common content token',
          lineRange: [20, 22],
          tokens: ['identical', 'common', 'content', 'token'],
        },
        {
          fileId: 'a-doc',
          fileName: 'a.md',
          headingSlug: 'slug-a1',
          headingBreadcrumb: 'Breadcrumb',
          content: 'Identical common content token',
          lineRange: [5, 7],
          tokens: ['identical', 'common', 'content', 'token'],
        },
      ];

      const engine = new LexicalBM25SearchEngine(identicalChunks);
      const results = engine.search('identical common content');

      expect(results).toHaveLength(3);
      // All scores are equal; tie-breaker: fileId asc, then lineRange[0] asc
      expect(results[0].fileId).toBe('a-doc');
      expect(results[0].lineRange[0]).toBe(5);

      expect(results[1].fileId).toBe('a-doc');
      expect(results[1].lineRange[0]).toBe(20);

      expect(results[2].fileId).toBe('b-doc');
      expect(results[2].lineRange[0]).toBe(10);
    });

    it('supports dynamic index modification via addChunks and indexChunks', () => {
      const engine = new LexicalBM25SearchEngine();
      expect(engine.search('PBKDF2')).toEqual([]);

      engine.indexChunks(mockChunks.slice(0, 1));
      expect(engine.getChunks()).toHaveLength(1);
      expect(engine.search('PBKDF2')).toHaveLength(1);

      engine.addChunks(mockChunks.slice(1));
      expect(engine.getChunks()).toHaveLength(3);
      expect(engine.search('IndexedDB')).toHaveLength(1);
    });

    it('respects maxResults pagination option', () => {
      const engine = new LexicalBM25SearchEngine(mockChunks);
      const results = engine.search('provides', { maxResults: 1 });
      expect(results).toHaveLength(1);
    });
  });

  // ==========================================================================
  // 5. ReDoS Resilience & Guard Evaluation
  // ==========================================================================
  describe('ReDoS Resilience & Security Guards', () => {
    const chunk: DocumentChunk = {
      fileId: 'f-sec',
      fileName: 'security.md',
      headingSlug: 'sec-slug',
      headingBreadcrumb: 'Sec',
      content: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      lineRange: [1, 1],
      tokens: ['a'],
    };

    it('blocks regex patterns exceeding 100 characters without crashing', () => {
      const engine = new LexicalBM25SearchEngine([chunk]);
      const longPattern = '/' + 'a'.repeat(120) + '/';
      const results = engine.search(longPattern);
      // Returns no results or does not crash
      expect(Array.isArray(results)).toBe(true);
    });

    it('blocks dangerous catastrophic backtrack patterns with nested quantifiers', () => {
      const engine = new LexicalBM25SearchEngine([chunk]);
      // Classic ReDoS: (a+)+ or (a*)* or a*.*.*b
      const dangerousPatterns = [
        '/(a+)+/i',
        '/(a*)*$/i',
        '/a*.*.*b/i',
        '/([a-z]+){2,}/i',
      ];

      for (const pattern of dangerousPatterns) {
        const start = Date.now();
        const results = engine.search(pattern);
        const elapsed = Date.now() - start;
        // Should return instantly (less than 100ms) without hanging
        expect(elapsed).toBeLessThan(100);
        expect(Array.isArray(results)).toBe(true);
      }
    });

    it('handles malformed regex patterns safely inside try/catch without crashing', () => {
      const engine = new LexicalBM25SearchEngine([chunk]);
      // Malformed regex
      const malformed = '/[unclosed-bracket/i';
      expect(() => engine.search(malformed)).not.toThrow();
      const results = engine.search(malformed);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ==========================================================================
  // 6. searchLexicalWithASTBreadcrumb High-Level Orchestrator
  // ==========================================================================
  describe('searchLexicalWithASTBreadcrumb High-Level Orchestrator', () => {
    const documents: SearchDocumentTarget[] = [
      {
        fileId: 'doc-eng',
        fileName: 'engineering.md',
        content: [
          '# Architecture Overview',
          'Elixent uses client-side encryption and pure WebCrypto.',
          '',
          '## Master Key Derivation',
          'PBKDF2 derives the Master Key using 600,000 iterations.',
          '',
          '```typescript',
          'export async function deriveKey(pin: string) {',
          '  return crypto.subtle.deriveKey(...);',
          '}',
          '```',
        ].join('\n'),
      },
      {
        fileId: 'doc-ar',
        fileName: 'ar-guide.md',
        content: [
          '# دليل التشفير والمزامنة',
          'يوفر النظام مزامنة فورية وحماية تامة للبيانات في الذاكرة.',
          '',
          '## استعادة الحساب',
          'يمكن استعادة المفتاح الرئيسي باستخدام كلمة المرور المشفرة.',
        ].join('\n'),
      },
    ];

    it('searches across multiple documents and decorates matches with AST breadcrumbs', () => {
      const results = searchLexicalWithASTBreadcrumb({
        documents,
        query: 'PBKDF2 600,000',
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      const topMatch = results[0];
      expect(topMatch.fileId).toBe('doc-eng');
      expect(topMatch.fileName).toBe('engineering.md');
      expect(topMatch.headingSlug).toBe('master-key-derivation');
      expect(topMatch.headingBreadcrumb).toBe('Architecture Overview > Master Key Derivation');
      expect(topMatch.matchedExcerpt).toContain('PBKDF2 derives the Master Key');
      expect(topMatch.lineRange[0]).toBeLessThanOrEqual(topMatch.lineRange[1]);
    });

    it('retrieves Arabic documents matching normalized Arabic query', () => {
      const results = searchLexicalWithASTBreadcrumb({
        documents,
        // Query has different Tashkeel / diacritics
        query: 'الْمِفْتَاحُ الرَّئِيسِيُّ',
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      const arMatch = results.find(r => r.fileId === 'doc-ar');
      expect(arMatch).toBeDefined();
      expect(arMatch!.headingBreadcrumb).toContain('استعادة الحساب');
    });

    it('matches code blocks associated with their enclosing heading', () => {
      const results = searchLexicalWithASTBreadcrumb({
        documents,
        query: 'crypto.subtle.deriveKey',
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      const codeMatch = results[0];
      expect(codeMatch.fileId).toBe('doc-eng');
      expect(codeMatch.matchedExcerpt).toContain('```typescript');
      expect(codeMatch.headingBreadcrumb).toBe('Architecture Overview > Master Key Derivation');
    });

    it('returns empty array when documents list is empty or query is empty', () => {
      expect(searchLexicalWithASTBreadcrumb({ documents: [], query: 'test' })).toEqual([]);
      expect(searchLexicalWithASTBreadcrumb({ documents, query: '' })).toEqual([]);
      expect(searchLexicalWithASTBreadcrumb({ documents, query: '   ' })).toEqual([]);
    });

    it('respects maxResults pagination across multi-document corpus', () => {
      const results = searchLexicalWithASTBreadcrumb({
        documents,
        query: 'المفتاح encryption',
        maxResults: 1,
      });

      expect(results).toHaveLength(1);
    });
  });
});
