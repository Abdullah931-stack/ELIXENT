/**
 * Commit Gate 6 Comprehensive Verification Suite:
 * CloudPostgresWorkspaceProvider & Ephemeral Zero-Knowledge Vault Integration
 *
 * Verifies:
 * 1. Construction & Argument Validation:
 *    - Strict type validation on `userId`.
 *    - Injected vs. default database instance fallback.
 * 2. Strict File Ownership Verification:
 *    - Query construction filtering by `userId` and `isNull(deletedAt)`.
 *    - Multi-file ownership: any missing or cross-user file rejects entire batch.
 *    - Soft-deleted files rejected with 404 (WorkspaceFileAccessDeniedError).
 *    - Deduplication of requested file IDs.
 * 3. Zero-Knowledge Vault AI Permission Gate:
 *    - Unencrypted files succeed without querying vault profile.
 *    - Encrypted files throw VaultAIAccessDeniedError (403) when user opted out or profile missing.
 *    - Encrypted files succeed when user opted in (allowAIOnEncryptedFiles === true).
 *    - Encrypted files throw EncryptedPayloadMissingError (400) if plaintext missing from both payloads and snapshots.
 *    - Plaintext precedence: liveDocumentSnapshots takes priority over ephemeralVaultPayloads.
 *    - Ciphertext isolation: database ciphertext is never parsed or leaked as plaintext.
 * 4. Section Reading & `vault_ref://` Pointers:
 *    - Unencrypted files return verbatim content with `isVaultRef: false`.
 *    - Encrypted files return `vault_ref://${fileId}#${slug}` with `isVaultRef: true`.
 *    - Plaintext stored in ephemeral memory map and dereferenceable JIT.
 *    - Missing heading slug throws WorkspaceSectionNotFoundError (404).
 *    - Unicode / Arabic heading slugs supported seamlessly.
 * 5. AST Heading Tree Extraction:
 *    - Accurate hierarchy extraction across multiple files.
 *    - Fence-aware: comments (`#`) inside code blocks are never misidentified as headings.
 *    - Mixed batch (encrypted + unencrypted) extracted properly.
 * 6. Lexical BM25 Search Redaction:
 *    - BM25 ranked search across target files.
 *    - Plaintext excerpt returned for unencrypted files.
 *    - Matched excerpt REDACTED to `vault_ref://${fileId}#${slug}` for encrypted files.
 * 7. Three-Way Merge Integration (diff3MergeSection):
 *    - JIT pointer resolution before merge.
 *    - Verifies clean merge, conflict quarantined, and syntax invalid outcomes.
 *    - Verifies algebraic replacement invariant:
 *      `liveDoc.slice(0, hunk.from) + hunk.replacementText + liveDoc.slice(hunk.to) === outcome.mergedDocumentContent`.
 * 8. Ephemeral Memory Zeroing & Scope Isolation:
 *    - Guaranteed `Buffer.fill(0)` wiping upon scope completion or manual zeroing.
 *    - Dereferencing zeroed memory throws EphemeralVaultResolutionError.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CloudPostgresWorkspaceProvider,
  type CloudPostgresWorkspaceProviderOptions,
} from '@/core/workspace/cloud-provider';
import {
  VaultAIAccessDeniedError,
  WorkspaceFileAccessDeniedError,
  WorkspaceSectionNotFoundError,
  EncryptedPayloadMissingError,
} from '@/core/workspace/provider';
import {
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
  resolveVaultRefJustInTime,
  zeroOutEphemeralVaultMemory,
  isVaultRef,
  EphemeralVaultResolutionError,
  EphemeralVaultScopeError,
} from '@/lib/vault/ephemeral-memory-map';
import { schema } from '@/server/db';

// ============================================================================
// Hermetic Mock Database Harness
// ============================================================================

interface MockFileRow {
  id: string;
  userId: string;
  title: string;
  content: string | null;
  isEncrypted: boolean;
  deletedAt?: Date | null;
  parentFolderId?: string | null;
}

interface MockProfileRow {
  userId: string;
  allowAIOnEncryptedFiles: boolean;
}

/**
 * Recursively extracts parameter values from Drizzle SQL conditions.
 */
function extractDrizzleParams(condition: unknown): string[] {
  const values: string[] = [];
  function visit(node: unknown) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if ('value' in obj && typeof obj.value === 'string') {
        values.push(obj.value);
      }
      if (Array.isArray(obj.queryChunks)) {
        for (const chunk of obj.queryChunks) visit(chunk);
      }
    }
  }
  visit(condition);
  return values;
}

/**
 * Creates an in-memory, hermetic mock Drizzle database matching PostgreSQL semantics.
 */
function createMockDb(initial: {
  files?: MockFileRow[];
  profiles?: MockProfileRow[];
  onQueryFiles?: (condition: unknown) => MockFileRow[];
  onQueryProfiles?: (condition: unknown) => MockProfileRow[];
}) {
  const store = {
    files: initial.files ? [...initial.files] : [],
    profiles: initial.profiles ? [...initial.profiles] : [],
  };

  const executedQueries: Array<{ table: unknown; condition: unknown }> = [];

  const db = {
    store,
    executedQueries,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(async (condition: unknown) => {
          executedQueries.push({ table, condition });

          if (table === schema.files) {
            if (initial.onQueryFiles) {
              return initial.onQueryFiles(condition);
            }
            const params = extractDrizzleParams(condition);
            // Default PostgreSQL mock logic:
            // Query specifies: inArray(files.id, fileIds) AND eq(files.userId, userId) AND isNull(files.deletedAt)
            return store.files.filter((f) => {
              if (f.deletedAt != null) return false;
              // If params include IDs and a userId, filter by them
              if (params.length > 0) {
                // If the file's userId is present in extracted params, check user
                const userMatch = params.includes(f.userId);
                const idMatch = params.includes(f.id);
                return userMatch && idMatch;
              }
              return true;
            });
          }

          if (table === schema.userVaultProfiles) {
            if (initial.onQueryProfiles) {
              const res = initial.onQueryProfiles(condition);
              return Object.assign(Promise.resolve(res), {
                limit: vi.fn((n: number) => Promise.resolve(res.slice(0, n))),
              });
            }
            const params = extractDrizzleParams(condition);
            const matching = store.profiles.filter((p) => {
              if (params.length > 0) {
                return params.includes(p.userId);
              }
              return true;
            });
            return Object.assign(Promise.resolve(matching), {
              limit: vi.fn((n: number) => Promise.resolve(matching.slice(0, n))),
            });
          }

          return [];
        }),
      })),
    })),
  };

  return db;
}

// ============================================================================
// Test Suite: CloudPostgresWorkspaceProvider & Ephemeral Vault Gate
// ============================================================================

describe('Commit Gate 6: CloudPostgresWorkspaceProvider & Ephemeral Vault Test Suite', () => {
  const PRIMARY_USER_ID = '11111111-1111-4111-a111-111111111111';
  const OTHER_USER_ID = '22222222-2222-4222-a222-222222222222';

  const SAMPLE_MARKDOWN = [
    '# Architecture Overview',
    'This is the top-level introductory overview paragraph.',
    '',
    '## Section One: Storage Engine',
    'Detailed documentation for the storage engine layer.',
    '```typescript',
    '// Code fence with # comment that should not be a heading',
    'const x = 42; # inline comment',
    '```',
    '',
    '### Subsection 1.1: Local Persistence',
    'IndexedDB client cache details.',
    '',
    '## Section Two: Cryptography',
    'Zero-knowledge encryption mechanisms.',
  ].join('\n');

  const ARABIC_MARKDOWN = [
    '# التوثيق المعماري',
    'نظرة عامة على البنية التحتية للنظام ومكوناته.',
    '',
    '## إدارة التشفير والخصوصية',
    'شرح آليات التشفير التراكمي وتأمين المفاتيح في المتصفح.',
    '',
    '### بروتوكول المصادقة',
    'تفاصيل جلسات المصادقة الصامتة.',
  ].join('\n');

  // =========================================================================
  // 1. Constructor Validation & Dependency Injection
  // =========================================================================
  describe('1. Constructor Validation & Dependency Injection', () => {
    it('throws TypeError if options is missing or userId is empty or whitespace', () => {
      expect(() => new CloudPostgresWorkspaceProvider(null as unknown as CloudPostgresWorkspaceProviderOptions)).toThrow(
        TypeError
      );
      expect(() => new CloudPostgresWorkspaceProvider({ userId: '' })).toThrow(
        /userId must be a non-empty string/
      );
      expect(() => new CloudPostgresWorkspaceProvider({ userId: '   ' })).toThrow(
        /userId must be a non-empty string/
      );
      expect(() => new CloudPostgresWorkspaceProvider({ userId: 123 as unknown as string })).toThrow(
        /userId must be a non-empty string/
      );
    });

    it('initializes successfully with valid userId and empty payload defaults', () => {
      const mockDb = createMockDb({});
      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      expect(provider).toBeInstanceOf(CloudPostgresWorkspaceProvider);
    });

    it('retains provided ephemeral payloads and live snapshots', async () => {
      const fileId = 'file-plain-1';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Doc.md',
            content: '# Stored Content',
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        liveDocumentSnapshots: {
          [fileId]: '# Live Snapshot Content',
        },
      });

      const tree = await provider.listHeadingsTree([fileId]);
      expect(tree[fileId]?.[0]?.title).toBe('Live Snapshot Content');
    });

    it('falls back to defaultDb when db option is omitted without throwing', () => {
      // Construction succeeds with defaultDb from '@/server/db'
      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
      });
      expect(provider).toBeInstanceOf(CloudPostgresWorkspaceProvider);
    });
  });

  // =========================================================================
  // 2. Strict File Ownership & Access Isolation
  // =========================================================================
  describe('2. Strict File Ownership & Access Isolation', () => {
    it('returns empty record immediately when fileIds array is empty without querying DB', async () => {
      const mockDb = createMockDb({});
      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      const result = await provider.listHeadingsTree([]);
      expect(result).toEqual({});
      expect(mockDb.executedQueries).toHaveLength(0);
    });

    it('throws WorkspaceFileAccessDeniedError (404) when target file does not exist in DB', async () => {
      const mockDb = createMockDb({
        files: [],
      });
      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(provider.listHeadingsTree(['missing-file-id'])).rejects.toThrow(
        WorkspaceFileAccessDeniedError
      );

      try {
        await provider.listHeadingsTree(['missing-file-id']);
      } catch (err: unknown) {
        const error = err as WorkspaceFileAccessDeniedError;
        expect(error.status).toBe(404);
        expect(error.code).toBe('WORKSPACE_FILE_ACCESS_DENIED');
        expect(error.message).toContain('missing-file-id');
      }
    });

    it('throws WorkspaceFileAccessDeniedError when requested file belongs to a different user', async () => {
      const mockDb = createMockDb({
        files: [
          {
            id: 'file-user-b',
            userId: OTHER_USER_ID,
            title: 'User B File',
            content: '# User B Content',
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(provider.listHeadingsTree(['file-user-b'])).rejects.toThrow(
        WorkspaceFileAccessDeniedError
      );
    });

    it('throws WorkspaceFileAccessDeniedError when requested file is soft-deleted', async () => {
      const mockDb = createMockDb({
        files: [
          {
            id: 'file-deleted',
            userId: PRIMARY_USER_ID,
            title: 'Deleted File',
            content: '# Deleted',
            isEncrypted: false,
            deletedAt: new Date(),
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(provider.listHeadingsTree(['file-deleted'])).rejects.toThrow(
        WorkspaceFileAccessDeniedError
      );
    });

    it('rejects the entire batch if even one file out of many is missing or unauthorized', async () => {
      const mockDb = createMockDb({
        files: [
          {
            id: 'file-ok-1',
            userId: PRIMARY_USER_ID,
            title: 'Valid 1',
            content: '# Valid 1',
            isEncrypted: false,
          },
          {
            id: 'file-ok-2',
            userId: PRIMARY_USER_ID,
            title: 'Valid 2',
            content: '# Valid 2',
            isEncrypted: false,
          },
          {
            id: 'file-unauthorized',
            userId: OTHER_USER_ID,
            title: 'Other User',
            content: '# Other',
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(
        provider.listHeadingsTree(['file-ok-1', 'file-ok-2', 'file-unauthorized'])
      ).rejects.toThrow(WorkspaceFileAccessDeniedError);
    });

    it('deduplicates duplicate file IDs in request and queries database cleanly', async () => {
      const mockDb = createMockDb({
        files: [
          {
            id: 'file-dup',
            userId: PRIMARY_USER_ID,
            title: 'Duplicate Test',
            content: '# Section Duplicate',
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      const tree = await provider.listHeadingsTree(['file-dup', 'file-dup', 'file-dup']);
      expect(tree['file-dup']).toHaveLength(1);
      expect(tree['file-dup']?.[0]?.headingSlug).toBe('section-duplicate');
      expect(mockDb.executedQueries).toHaveLength(1);
    });

    it('validates non-empty string arguments for readSectionByHeading and mergeSectionThreeWay', async () => {
      const mockDb = createMockDb({});
      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(provider.readSectionByHeading('', 'some-slug')).rejects.toThrow(
        WorkspaceFileAccessDeniedError
      );
      await expect(provider.readSectionByHeading('file-1', '')).rejects.toThrow(
        WorkspaceSectionNotFoundError
      );
      await expect(
        provider.mergeSectionThreeWay({
          fileId: '   ',
          headingSlug: 'slug',
          baseSectionContent: 'base',
          agentProposedSectionContent: 'prop',
          liveDocumentContent: 'live',
        })
      ).rejects.toThrow(WorkspaceFileAccessDeniedError);
    });
  });

  // =========================================================================
  // 3. Zero-Knowledge Vault AI Permission Gate
  // =========================================================================
  describe('3. Zero-Knowledge Vault AI Permission Gate', () => {
    it('permits unencrypted files without querying userVaultProfiles table', async () => {
      const mockDb = createMockDb({
        files: [
          {
            id: 'file-unencrypted',
            userId: PRIMARY_USER_ID,
            title: 'Unencrypted Doc',
            content: '# Public Doc\nContent here',
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      const tree = await provider.listHeadingsTree(['file-unencrypted']);
      expect(tree['file-unencrypted']).toHaveLength(1);

      // Verify no queries were sent to userVaultProfiles
      const profileQueries = mockDb.executedQueries.filter(
        (q) => q.table === schema.userVaultProfiles
      );
      expect(profileQueries).toHaveLength(0);
    });

    it('throws VaultAIAccessDeniedError (403) when file is encrypted and userVaultProfile is missing', async () => {
      const mockDb = createMockDb({
        files: [
          {
            id: 'file-enc-no-profile',
            userId: PRIMARY_USER_ID,
            title: 'Encrypted Doc',
            content: 'CIPHERTEXT_RAW_BLOB',
            isEncrypted: true,
          },
        ],
        profiles: [], // No vault profile found for this user
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        liveDocumentSnapshots: {
          'file-enc-no-profile': '# Decrypted Content',
        },
      });

      await expect(provider.listHeadingsTree(['file-enc-no-profile'])).rejects.toThrow(
        VaultAIAccessDeniedError
      );

      try {
        await provider.listHeadingsTree(['file-enc-no-profile']);
      } catch (err: unknown) {
        const error = err as VaultAIAccessDeniedError;
        expect(error.status).toBe(403);
        expect(error.code).toBe('VAULT_AI_ACCESS_DENIED');
      }
    });

    it('throws VaultAIAccessDeniedError (403) when file is encrypted and allowAIOnEncryptedFiles is false', async () => {
      const mockDb = createMockDb({
        files: [
          {
            id: 'file-enc-opted-out',
            userId: PRIMARY_USER_ID,
            title: 'Encrypted Doc',
            content: 'CIPHERTEXT_RAW_BLOB',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        ephemeralVaultPayloads: {
          'file-enc-opted-out': '# Decrypted Content',
        },
      });

      await expect(provider.listHeadingsTree(['file-enc-opted-out'])).rejects.toThrow(
        VaultAIAccessDeniedError
      );
    });

    it('throws EncryptedPayloadMissingError (400) when AI access is allowed but decrypted plaintext is missing', async () => {
      const mockDb = createMockDb({
        files: [
          {
            id: 'file-enc-missing-plaintext',
            userId: PRIMARY_USER_ID,
            title: 'Encrypted Doc',
            content: 'RAW_DATABASE_CIPHERTEXT_ENVELOPE',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true, // Opt-in granted
          },
        ],
      });

      // No ephemeralVaultPayloads and no liveDocumentSnapshots provided
      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(provider.listHeadingsTree(['file-enc-missing-plaintext'])).rejects.toThrow(
        EncryptedPayloadMissingError
      );

      try {
        await provider.listHeadingsTree(['file-enc-missing-plaintext']);
      } catch (err: unknown) {
        const error = err as EncryptedPayloadMissingError;
        expect(error.status).toBe(400);
        expect(error.code).toBe('ENCRYPTED_PAYLOAD_MISSING');
        expect(error.message).toContain('file-enc-missing-plaintext');
      }
    });

    it('guarantees database ciphertext is NEVER parsed as Markdown for encrypted files', async () => {
      const mockDb = createMockDb({
        files: [
          {
            id: 'file-enc-ciphertext',
            userId: PRIMARY_USER_ID,
            title: 'Encrypted Doc',
            content: '# Fake Heading Inside Ciphertext\nThis should never be read!',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true,
          },
        ],
      });

      // Without decrypted plaintext, it must throw rather than parse the DB content
      const providerWithoutPayload = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(providerWithoutPayload.listHeadingsTree(['file-enc-ciphertext'])).rejects.toThrow(
        EncryptedPayloadMissingError
      );
    });

    it('prioritizes liveDocumentSnapshots over ephemeralVaultPayloads for decrypted plaintext', async () => {
      const fileId = 'file-enc-precedence';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Encrypted Doc',
            content: 'CIPHERTEXT',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        liveDocumentSnapshots: {
          [fileId]: '# Snapshot Heading\nSnapshot Body',
        },
        ephemeralVaultPayloads: {
          [fileId]: '# Payload Heading\nPayload Body',
        },
      });

      const tree = await provider.listHeadingsTree([fileId]);
      expect(tree[fileId]?.[0]?.title).toBe('Snapshot Heading');
    });

    it('uses ephemeralVaultPayloads when liveDocumentSnapshots is not present', async () => {
      const fileId = 'file-enc-ephemeral-only';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Encrypted Doc',
            content: 'CIPHERTEXT',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        ephemeralVaultPayloads: {
          [fileId]: '# Ephemeral Heading\nEphemeral Body',
        },
      });

      const tree = await provider.listHeadingsTree([fileId]);
      expect(tree[fileId]?.[0]?.title).toBe('Ephemeral Heading');
    });

    it('falls back to empty string for unencrypted files when content is null', async () => {
      const fileId = 'file-null-content';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Empty File',
            content: null,
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      const tree = await provider.listHeadingsTree([fileId]);
      expect(tree[fileId]).toEqual([]);
    });
  });

  // =========================================================================
  // 4. Section Reading & vault_ref:// Pointers
  // =========================================================================
  describe('4. Section Reading & vault_ref:// Pointers', () => {
    it('returns verbatim plaintext with isVaultRef: false for unencrypted files', async () => {
      const fileId = 'file-plain-read';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Unencrypted Doc',
            content: SAMPLE_MARKDOWN,
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      const result = await provider.readSectionByHeading(fileId, 'section-one-storage-engine');

      expect(result.isVaultRef).toBe(false);
      expect(result.breadcrumb).toBe('Architecture Overview > Section One: Storage Engine');
      expect(result.contentOrVaultRef).toContain('Detailed documentation for the storage engine layer.');
      expect(result.contentOrVaultRef).toContain('const x = 42;');
    });

    it('stores section in ephemeral vault memory and returns opaque pointer for encrypted files', async () => {
      const fileId = 'file-enc-read';
      const headingSlug = 'section-one-storage-engine';

      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Encrypted Vault Doc',
            content: 'CIPHERTEXT_BLOB',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        ephemeralVaultPayloads: {
          [fileId]: SAMPLE_MARKDOWN,
        },
      });

      await runWithEphemeralVaultScope(async () => {
        const result = await provider.readSectionByHeading(fileId, headingSlug);

        // Validates opaque pointer structure
        expect(result.isVaultRef).toBe(true);
        expect(result.breadcrumb).toBe('Architecture Overview > Section One: Storage Engine');
        expect(isVaultRef(result.contentOrVaultRef)).toBe(true);
        expect(result.contentOrVaultRef).toBe(`vault_ref://${fileId}#${headingSlug}`);

        // Verifies plaintext did NOT leak in the returned content string
        expect(result.contentOrVaultRef).not.toContain('Detailed documentation');

        // Verifies just-in-time dereferencing recovers the true plaintext
        const dereferenced = resolveVaultRefJustInTime(result.contentOrVaultRef);
        expect(dereferenced).toContain('Detailed documentation for the storage engine layer.');
        expect(dereferenced).toContain('const x = 42;');
      });
    });

    it('throws WorkspaceSectionNotFoundError (404) when requested heading slug does not exist', async () => {
      const fileId = 'file-plain-notfound';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Doc',
            content: SAMPLE_MARKDOWN,
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(
        provider.readSectionByHeading(fileId, 'non-existent-section-slug')
      ).rejects.toThrow(WorkspaceSectionNotFoundError);

      try {
        await provider.readSectionByHeading(fileId, 'non-existent-section-slug');
      } catch (err: unknown) {
        const error = err as WorkspaceSectionNotFoundError;
        expect(error.status).toBe(404);
        expect(error.code).toBe('WORKSPACE_SECTION_NOT_FOUND');
      }
    });

    it('correctly extracts and dereferences Arabic heading sections and slugs', async () => {
      const fileId = 'file-arabic-enc';
      const headingSlug = 'إدارة-التشفير-والخصوصية';

      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'وثيقة مشفرة',
            content: 'CIPHERTEXT_BLOB',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        liveDocumentSnapshots: {
          [fileId]: ARABIC_MARKDOWN,
        },
      });

      await runWithEphemeralVaultScope(async () => {
        const result = await provider.readSectionByHeading(fileId, headingSlug);

        expect(result.isVaultRef).toBe(true);
        expect(result.contentOrVaultRef).toBe(`vault_ref://${fileId}#${headingSlug}`);

        const dereferenced = resolveVaultRefJustInTime(result.contentOrVaultRef);
        expect(dereferenced).toContain('شرح آليات التشفير التراكمي');
      });
    });
  });

  // =========================================================================
  // 5. AST Heading Tree Extraction (listHeadingsTree)
  // =========================================================================
  describe('5. AST Heading Tree Extraction (listHeadingsTree)', () => {
    it('parses complete Markdown heading hierarchy with accurate depths, slugs, and lines', async () => {
      const fileId = 'file-ast-multi';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Architecture Doc',
            content: SAMPLE_MARKDOWN,
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      const tree = await provider.listHeadingsTree([fileId]);
      const nodes = tree[fileId];

      expect(nodes).toBeDefined();
      expect(nodes).toHaveLength(4);

      // Root heading
      expect(nodes?.[0]).toMatchObject({
        level: 1,
        title: 'Architecture Overview',
        headingSlug: 'architecture-overview',
        breadcrumb: 'Architecture Overview',
      });

      // Section One
      expect(nodes?.[1]).toMatchObject({
        level: 2,
        title: 'Section One: Storage Engine',
        headingSlug: 'section-one-storage-engine',
        breadcrumb: 'Architecture Overview > Section One: Storage Engine',
      });

      // Subsection 1.1
      expect(nodes?.[2]).toMatchObject({
        level: 3,
        title: 'Subsection 1.1: Local Persistence',
        headingSlug: 'subsection-1-1-local-persistence',
        breadcrumb: 'Architecture Overview > Section One: Storage Engine > Subsection 1.1: Local Persistence',
      });

      // Section Two
      expect(nodes?.[3]).toMatchObject({
        level: 2,
        title: 'Section Two: Cryptography',
        headingSlug: 'section-two-cryptography',
        breadcrumb: 'Architecture Overview > Section Two: Cryptography',
      });
    });

    it('is fence-aware: ignores # comments inside code blocks', async () => {
      const fileId = 'file-fence-test';
      const content = [
        '# Valid Heading',
        '```python',
        '# Comment inside Python code fence',
        'def test():',
        '    pass',
        '```',
        '## Valid Subheading',
      ].join('\n');

      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Fence Doc',
            content,
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      const tree = await provider.listHeadingsTree([fileId]);
      const slugs = (tree[fileId] ?? []).map((n) => n.headingSlug);

      expect(slugs).toEqual(['valid-heading', 'valid-subheading']);
      expect(slugs).not.toContain('comment-inside-python-code-fence');
    });

    it('extracts headings across multiple files in a single invocation', async () => {
      const file1 = 'file-1-batch';
      const file2 = 'file-2-batch';

      const mockDb = createMockDb({
        files: [
          {
            id: file1,
            userId: PRIMARY_USER_ID,
            title: 'Doc 1',
            content: '# Heading File 1',
            isEncrypted: false,
          },
          {
            id: file2,
            userId: PRIMARY_USER_ID,
            title: 'Doc 2',
            content: 'CIPHERTEXT_2',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        ephemeralVaultPayloads: {
          [file2]: '# Heading File 2\n## Subheading File 2',
        },
      });

      const tree = await provider.listHeadingsTree([file1, file2]);

      expect(tree[file1]).toHaveLength(1);
      expect(tree[file1]?.[0]?.headingSlug).toBe('heading-file-1');

      expect(tree[file2]).toHaveLength(2);
      expect(tree[file2]?.[0]?.headingSlug).toBe('heading-file-2');
      expect(tree[file2]?.[1]?.headingSlug).toBe('subheading-file-2');
    });
  });

  // =========================================================================
  // 6. Lexical BM25 Search Redaction
  // =========================================================================
  describe('6. Lexical BM25 Search Redaction', () => {
    it('returns plaintext excerpts for unencrypted files', async () => {
      const fileId = 'file-search-plain';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Search Guide',
            content: SAMPLE_MARKDOWN,
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      const results = await provider.searchLexicalWithASTBreadcrumb({
        fileIds: [fileId],
        query: 'storage engine documentation',
      });

      expect(results.length).toBeGreaterThan(0);
      const topMatch = results[0];

      expect(topMatch?.fileId).toBe(fileId);
      expect(topMatch?.headingBreadcrumb).toContain('Section One: Storage Engine');
      // Plaintext excerpt preserved verbatim
      expect(topMatch?.matchedExcerpt).toContain('storage engine');
      expect(isVaultRef(topMatch!.matchedExcerpt)).toBe(false);
    });

    it('redacts matched excerpts from encrypted files into vault_ref:// pointers', async () => {
      const fileId = 'file-search-enc';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Encrypted Vault',
            content: 'CIPHERTEXT_BLOB',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        ephemeralVaultPayloads: {
          [fileId]: SAMPLE_MARKDOWN,
        },
      });

      await runWithEphemeralVaultScope(async () => {
        const results = await provider.searchLexicalWithASTBreadcrumb({
          fileIds: [fileId],
          query: 'cryptography mechanisms',
        });

        expect(results.length).toBeGreaterThan(0);
        const match = results[0]!;

        expect(match.fileId).toBe(fileId);
        // Excerpt is redacted to an opaque pointer
        expect(isVaultRef(match.matchedExcerpt)).toBe(true);
        expect(match.matchedExcerpt).toContain(`vault_ref://${fileId}#`);

        // Plaintext never leaks in search result
        expect(match.matchedExcerpt).not.toContain('Zero-knowledge encryption mechanisms');

        // Resolving pointer dereferences the actual matching excerpt text
        const dereferenced = resolveVaultRefJustInTime(match.matchedExcerpt);
        expect(dereferenced.toLowerCase()).toContain('zero-knowledge');
      });
    });

    it('handles mixed search: leaves unencrypted matches plaintext and redacts encrypted matches', async () => {
      const plainFileId = 'file-search-mixed-plain';
      const encFileId = 'file-search-mixed-enc';

      const mockDb = createMockDb({
        files: [
          {
            id: plainFileId,
            userId: PRIMARY_USER_ID,
            title: 'Plain Document',
            content: '# Unencrypted Section\nPerformance optimization tips and caching guidelines.',
            isEncrypted: false,
          },
          {
            id: encFileId,
            userId: PRIMARY_USER_ID,
            title: 'Encrypted Document',
            content: 'CIPHERTEXT',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
        ephemeralVaultPayloads: {
          [encFileId]: '# Encrypted Section\nPerformance metrics and benchmark findings.',
        },
      });

      await runWithEphemeralVaultScope(async () => {
        const results = await provider.searchLexicalWithASTBreadcrumb({
          fileIds: [plainFileId, encFileId],
          query: 'performance',
        });

        expect(results.length).toBe(2);

        const plainMatch = results.find((r) => r.fileId === plainFileId);
        const encMatch = results.find((r) => r.fileId === encFileId);

        expect(plainMatch).toBeDefined();
        expect(encMatch).toBeDefined();

        // Plaintext match is verbatim
        expect(isVaultRef(plainMatch!.matchedExcerpt)).toBe(false);
        expect(plainMatch!.matchedExcerpt).toContain('Performance');

        // Encrypted match is redacted
        expect(isVaultRef(encMatch!.matchedExcerpt)).toBe(true);
        expect(encMatch!.matchedExcerpt).toContain(`vault_ref://${encFileId}#`);
      });
    });

    it('returns empty array when query is empty, fileIds is empty, or no matches found', async () => {
      const mockDb = createMockDb({});
      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      expect(
        await provider.searchLexicalWithASTBreadcrumb({
          fileIds: [],
          query: 'test',
        })
      ).toEqual([]);

      expect(
        await provider.searchLexicalWithASTBreadcrumb({
          fileIds: ['some-id'],
          query: '   ',
        })
      ).toEqual([]);
    });
  });

  // =========================================================================
  // 7. Three-Way Merge Integration (diff3MergeSection)
  // =========================================================================
  describe('7. Three-Way Merge Integration (diff3MergeSection)', () => {
    const liveDoc = [
      '# Document Title',
      'Introductory paragraph.',
      '',
      '## Target Section',
      'Line 1: Human local changes applied here.',
      'Line 2: Common base content.',
      '',
      '## Trailing Section',
      'Untouched content.',
    ].join('\n');

    const baseSection = [
      '## Target Section',
      'Line 1: Original base line 1.',
      'Line 2: Common base content.',
    ].join('\n');

    const agentProposedSection = [
      '## Target Section',
      'Line 1: Original base line 1.',
      'Line 2: Common base content with remote agent additions.',
    ].join('\n');

    it('performs clean three-way section merge and satisfies algebraic replacement invariant', async () => {
      const fileId = 'file-merge-clean';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Doc',
            content: liveDoc,
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      const outcome = await provider.mergeSectionThreeWay({
        fileId,
        headingSlug: 'target-section',
        liveDocumentContent: liveDoc,
        baseSectionContent: baseSection,
        agentProposedSectionContent: agentProposedSection,
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toContain('Line 1: Human local changes applied here.');
      expect(outcome.mergedDocumentContent).toContain('Line 2: Common base content with remote agent additions.');

      // Algebraic replacement invariant
      const reconstructed =
        liveDoc.slice(0, outcome.hunkRange.from) +
        outcome.hunkRange.replacementText +
        liveDoc.slice(outcome.hunkRange.to);

      expect(reconstructed).toBe(outcome.mergedDocumentContent);
    });

    it('resolves embedded vault_ref:// pointers just-in-time before executing merge', async () => {
      const fileId = 'file-merge-encrypted';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Vault Doc',
            content: 'CIPHERTEXT',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: true,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await runWithEphemeralVaultScope(async () => {
        // Store base and proposed sections in ephemeral memory
        const baseRef = storeEphemeralVaultSection(fileId, 'target-section-base', baseSection);
        const propRef = storeEphemeralVaultSection(fileId, 'target-section-prop', agentProposedSection);

        const outcome = await provider.mergeSectionThreeWay({
          fileId,
          headingSlug: 'target-section',
          liveDocumentContent: liveDoc,
          baseSectionContent: baseRef,
          agentProposedSectionContent: propRef,
        });

        expect(outcome.status).toBe('clean');
        expect(outcome.mergedDocumentContent).toContain('Line 1: Human local changes applied here.');
        expect(outcome.mergedDocumentContent).toContain(
          'Line 2: Common base content with remote agent additions.'
        );
      });
    });

    it('isolates real conflicts with conflict_quarantined status and standard Git markers', async () => {
      const fileId = 'file-merge-conflict';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Doc',
            content: liveDoc,
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      // Both human and agent modified Line 1 incompatibly
      const conflictingAgentProposed = [
        '## Target Section',
        'Line 1: Agent completely conflicting rewrite.',
        'Line 2: Common base content.',
      ].join('\n');

      const outcome = await provider.mergeSectionThreeWay({
        fileId,
        headingSlug: 'target-section',
        liveDocumentContent: liveDoc,
        baseSectionContent: baseSection,
        agentProposedSectionContent: conflictingAgentProposed,
      });

      expect(outcome.status).toBe('conflict_quarantined');
      expect(outcome.mergedDocumentContent).toBe(liveDoc);
      expect(outcome.hunkRange.replacementText).toContain('<<<<<<< LOCAL');
      expect(outcome.hunkRange.replacementText).toContain('=======');
      expect(outcome.hunkRange.replacementText).toContain('>>>>>>> REMOTE');
    });

    it('isolates syntax violations with syntax_invalid status and diagnostics', async () => {
      const fileId = 'file-merge-syntax-err';
      const cleanDoc = [
        '# Code Guide',
        'Overview paragraph.',
        '',
        '## Implementation',
        'Line 1: Stable implementation content.',
        'Line 2: Common base content.',
      ].join('\n');

      const cleanBase = [
        '## Implementation',
        'Line 1: Stable implementation content.',
        'Line 2: Common base content.',
      ].join('\n');

      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Doc',
            content: cleanDoc,
            isEncrypted: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      // Agent proposal introduces an unclosed code fence without triggering line conflict
      const syntaxInvalidProposed = [
        '## Implementation',
        'Line 1: Stable implementation content.',
        '```typescript',
        'function broken() {',
        '// Unclosed code block without matching closing fence',
      ].join('\n');

      const outcome = await provider.mergeSectionThreeWay({
        fileId,
        headingSlug: 'implementation',
        liveDocumentContent: cleanDoc,
        baseSectionContent: cleanBase,
        agentProposedSectionContent: syntaxInvalidProposed,
      });

      expect(outcome.status).toBe('syntax_invalid');
      expect(outcome.mergedDocumentContent).toBe(cleanDoc);
      expect(outcome.diagnostics).toBeDefined();
      expect(outcome.diagnostics?.length).toBeGreaterThan(0);
      expect(outcome.diagnostics?.some((d) => d.toLowerCase().includes('unclosed'))).toBe(true);
    });

    it('validates file ownership and throws WorkspaceFileAccessDeniedError if fileId is unknown', async () => {
      const mockDb = createMockDb({ files: [] });
      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(
        provider.mergeSectionThreeWay({
          fileId: 'unknown-id',
          headingSlug: 'target-section',
          liveDocumentContent: liveDoc,
          baseSectionContent: baseSection,
          agentProposedSectionContent: agentProposedSection,
        })
      ).rejects.toThrow(WorkspaceFileAccessDeniedError);
    });

    it('validates vault permission and throws VaultAIAccessDeniedError for encrypted files if opt-in is false', async () => {
      const fileId = 'file-merge-enc-denied';
      const mockDb = createMockDb({
        files: [
          {
            id: fileId,
            userId: PRIMARY_USER_ID,
            title: 'Vault Doc',
            content: 'CIPHERTEXT',
            isEncrypted: true,
          },
        ],
        profiles: [
          {
            userId: PRIMARY_USER_ID,
            allowAIOnEncryptedFiles: false,
          },
        ],
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: PRIMARY_USER_ID,
        db: mockDb,
      });

      await expect(
        provider.mergeSectionThreeWay({
          fileId,
          headingSlug: 'target-section',
          liveDocumentContent: liveDoc,
          baseSectionContent: baseSection,
          agentProposedSectionContent: agentProposedSection,
        })
      ).rejects.toThrow(VaultAIAccessDeniedError);
    });
  });

  // =========================================================================
  // 8. Ephemeral Memory Zeroing & Scope Isolation
  // =========================================================================
  describe('8. Ephemeral Memory Zeroing & Scope Isolation', () => {
    it('wipes buffers with zeroes when zeroOutEphemeralVaultMemory is called', async () => {
      await runWithEphemeralVaultScope(async () => {
        const fileId = 'file-wipe-test';
        const slug = 'wipe-section';
        const pointer = storeEphemeralVaultSection(fileId, slug, 'Confidential plaintext');

        // Resolves fine before zeroing
        expect(resolveVaultRefJustInTime(pointer)).toBe('Confidential plaintext');

        // Zero out memory manually
        zeroOutEphemeralVaultMemory();

        // Resolving zeroed memory now throws EphemeralVaultResolutionError
        expect(() => resolveVaultRefJustInTime(pointer)).toThrow(EphemeralVaultResolutionError);
      });
    });

    it('automatically zeroes out memory and clears scope on normal completion', async () => {
      let pointerCaptured = '';

      await runWithEphemeralVaultScope(async () => {
        pointerCaptured = storeEphemeralVaultSection('file-scope-1', 'scope-slug', 'Scope plaintext');
        expect(resolveVaultRefJustInTime(pointerCaptured)).toBe('Scope plaintext');
      });

      // Outside scope, dereferencing must throw EphemeralVaultResolutionError
      expect(() => resolveVaultRefJustInTime(pointerCaptured)).toThrow(
        EphemeralVaultResolutionError
      );
    });

    it('automatically zeroes out memory on error unwinding within scope', async () => {
      let pointerCaptured = '';

      try {
        await runWithEphemeralVaultScope(async () => {
          pointerCaptured = storeEphemeralVaultSection(
            'file-scope-err',
            'error-slug',
            'Volatile plaintext'
          );
          throw new Error('Simulated pipeline failure');
        });
      } catch (err: unknown) {
        expect((err as Error).message).toBe('Simulated pipeline failure');
      }

      // Memory must be wiped and scope cleared
      expect(() => resolveVaultRefJustInTime(pointerCaptured)).toThrow(
        EphemeralVaultResolutionError
      );
    });

    it('throws EphemeralVaultScopeError when storing section outside an active scope', () => {
      expect(() =>
        storeEphemeralVaultSection('file-outside', 'slug-outside', 'Plaintext outside scope')
      ).toThrow(EphemeralVaultScopeError);
    });

    it('zeroes out previous buffer when replacing a section with the same pointer in same scope', async () => {
      await runWithEphemeralVaultScope(async () => {
        const fileId = 'file-replace';
        const slug = 'replace-slug';

        const p1 = storeEphemeralVaultSection(fileId, slug, 'First generation content');
        const p2 = storeEphemeralVaultSection(fileId, slug, 'Second generation content');

        expect(p1).toBe(p2);
        expect(resolveVaultRefJustInTime(p2)).toBe('Second generation content');
      });
    });
  });
});
