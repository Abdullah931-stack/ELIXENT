/**
 * Full-Workspace ZIP Archive Exporter (SRS-02 §3.3 / REQ-WS-06)
 *
 * Reconstructs the workspace folder hierarchy (`parentFolderId` tree -> `relativePath`),
 * decrypts encrypted files locally via SyncCryptoGateway when the vault is unlocked
 * (failing closed if locked or undecryptable), includes `decisions.ledger.json` at the
 * archive root with preserved `affectedSections` mappings, and builds a deterministic
 * zero-dependency binary ZIP archive (STORE method 0, IEEE 802.3 CRC-32, UTF-8 EFS flag).
 *
 * Browser-only Web APIs (`TextEncoder`, `Uint8Array`, `DataView`, `Blob`) — zero Node.js
 * or `@/server/*` imports to satisfy `clientServerBoundaryGuardPlugin`.
 */

import {
  SyncCryptoGateway,
  type InboundPayloadInput,
  type InboundPayloadResult,
} from '@/lib/sync/sync-crypto-gateway';
import type { EncryptedEnvelopeMetadata } from '@/lib/sync/idb-types';

const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_VERSION_NEEDED = 20;
const ZIP_VERSION_MADE_BY = 20;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_METHOD_STORE = 0;

const utf8Encoder = new TextEncoder();

/**
 * Precomputed IEEE 802.3 CRC-32 lookup table (polynomial 0xEDB88320).
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Computes IEEE 802.3 CRC-32 checksum for a byte buffer.
 */
export function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type WorkspaceZipExportErrorCode =
  | 'WORKSPACE_FILES_REQUIRED'
  | 'CROSS_WORKSPACE_FILE_FORBIDDEN'
  | 'ENCRYPTED_EXPORT_UNCONFIRMED'
  | 'VAULT_LOCKED'
  | 'DECRYPTION_FAILED';

export class WorkspaceZipExportError extends Error {
  public readonly code: WorkspaceZipExportErrorCode;

  constructor(code: WorkspaceZipExportErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceZipExportError';
    this.code = code;
  }
}

export interface WorkspaceExportFileInput {
  id: string;
  workspaceId?: string;
  userId?: string;
  title: string;
  content: string | null;
  parentFolderId: string | null;
  isFolder: boolean;
  isEncrypted?: boolean;
  encryptionMetadata?: EncryptedEnvelopeMetadata | Partial<EncryptedEnvelopeMetadata> | null;
  artifactRole?: 'document' | 'decision_ledger' | string | null;
  deletedAt?: string | Date | null;
  updatedAt?: string | Date | null;
  relativePath?: string;
}

export interface AffectedSectionEntry {
  fileId: string;
  relativePath?: string;
  headingSlug: string;
  [key: string]: unknown;
}

export interface WorkspaceDecisionLedgerInput {
  schemaVersion?: string;
  workspaceId?: string;
  updatedAt?: string;
  decisions?: Record<string, unknown> | Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface WorkspaceZipExportOptions {
  /** Workspace files and folders to include in the archive. */
  files?: WorkspaceExportFileInput[];
  /** Optional async loader invoked when `files` is not supplied directly. */
  loadFiles?: (workspaceId: string) => Promise<WorkspaceExportFileInput[]>;
  /** Optional pre-decrypted plaintext map keyed by `fileId`. */
  decryptedContentMap?: Record<string, string>;
  /** Optional custom decryptor; defaults to `SyncCryptoGateway.decryptInbound`. */
  decryptFile?: (payload: InboundPayloadInput) => Promise<InboundPayloadResult>;
  /** Fallback userId for AAD binding when individual files omit `userId`. */
  userId?: string;
  /** Optional explicit decision ledger document or serialized JSON string. */
  decisionLedger?: WorkspaceDecisionLedgerInput | string | null;
  /** Explicit plaintext confirmation flag; required (`true`) when workspace has encrypted files. */
  confirmedPlaintextExport?: boolean;
  /** Optional fixed timestamp for deterministic archive headers. */
  timestamp?: Date;
}

interface ZipEntry {
  path: string;
  data: Uint8Array;
  isDirectory: boolean;
  timestamp: Date;
}

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return fallback;
  }
  return cleaned;
}

function splitNameAndExtension(name: string): { stem: string; ext: string } {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) {
    return { stem: name, ext: '' };
  }
  return {
    stem: name.slice(0, lastDot),
    ext: name.slice(lastDot),
  };
}

function allocateUniquePath(
  desiredPath: string,
  usedPathsLower: Set<string>,
  isDirectory: boolean
): string {
  const normalized = isDirectory ? desiredPath.replace(/\/+$/, '') : desiredPath;
  if (!usedPathsLower.has(normalized.toLowerCase())) {
    usedPathsLower.add(normalized.toLowerCase());
    return isDirectory ? `${normalized}/` : normalized;
  }

  const lastSlash = normalized.lastIndexOf('/');
  const dirPrefix = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : '';
  const leaf = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const { stem, ext } = isDirectory ? { stem: leaf, ext: '' } : splitNameAndExtension(leaf);

  let counter = 2;
  while (true) {
    const candidate = `${dirPrefix}${stem} (${counter})${ext}`;
    if (!usedPathsLower.has(candidate.toLowerCase())) {
      usedPathsLower.add(candidate.toLowerCase());
      return isDirectory ? `${candidate}/` : candidate;
    }
    counter += 1;
  }
}

function toDosTimeAndDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();

  const dosTime =
    ((hours & 0x1f) << 11) |
    ((minutes & 0x3f) << 5) |
    ((seconds >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    ((month & 0x0f) << 5) |
    (day & 0x1f);

  return { dosTime, dosDate };
}

function parseTimestamp(value: string | Date | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function isDecisionLedgerFile(file: WorkspaceExportFileInput): boolean {
  if (file.isFolder) return false;
  if (file.artifactRole === 'decision_ledger') return true;
  return file.parentFolderId === null && file.title.trim().toLowerCase() === 'decisions.ledger.json';
}

function enrichAffectedSections(
  value: unknown,
  fileIdToPath: Map<string, string>
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => enrichAffectedSections(item, fileIdToPath));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      if (key === 'affectedSections' && Array.isArray(val)) {
        next[key] = val.map((section) => {
          if (!section || typeof section !== 'object') return section;
          const sec = section as AffectedSectionEntry;
          const mappedPath = typeof sec.fileId === 'string' ? fileIdToPath.get(sec.fileId) : undefined;
          return {
            ...sec,
            fileId: sec.fileId,
            relativePath: mappedPath ?? sec.relativePath ?? '',
            headingSlug: sec.headingSlug,
          };
        });
      } else {
        next[key] = enrichAffectedSections(val, fileIdToPath);
      }
    }
    return next;
  }
  return value;
}

function serializeDecisionLedger(
  rawOrObject: WorkspaceDecisionLedgerInput | string,
  fileIdToPath: Map<string, string>
): string {
  if (typeof rawOrObject === 'string') {
    try {
      const parsed = JSON.parse(rawOrObject) as unknown;
      const enriched = enrichAffectedSections(parsed, fileIdToPath);
      return JSON.stringify(enriched, null, 2);
    } catch {
      return rawOrObject;
    }
  }
  const enriched = enrichAffectedSections(rawOrObject, fileIdToPath);
  return JSON.stringify(enriched, null, 2);
}

/**
 * Builds a deterministic binary ZIP archive using STORE compression (method 0),
 * IEEE 802.3 CRC-32, and UTF-8 filename encoding (`0x0800`).
 */
export function buildZipArchive(entries: ZipEntry[]): Uint8Array {
  const sortedEntries = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of sortedEntries) {
    const nameBytes = utf8Encoder.encode(entry.path);
    const data = entry.isDirectory ? new Uint8Array(0) : entry.data;
    const crc = computeCrc32(data);
    const { dosTime, dosDate } = toDosTimeAndDate(entry.timestamp);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(localHeader.buffer);
    ldv.setUint32(0, ZIP_LOCAL_FILE_HEADER_SIG, true);
    ldv.setUint16(4, ZIP_VERSION_NEEDED, true);
    ldv.setUint16(6, ZIP_UTF8_FLAG, true);
    ldv.setUint16(8, ZIP_METHOD_STORE, true);
    ldv.setUint16(10, dosTime, true);
    ldv.setUint16(12, dosDate, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.length, true);
    ldv.setUint32(22, data.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader);
    if (data.length > 0) {
      localParts.push(data);
    }

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(centralHeader.buffer);
    cdv.setUint32(0, ZIP_CENTRAL_DIR_HEADER_SIG, true);
    cdv.setUint16(4, ZIP_VERSION_MADE_BY, true);
    cdv.setUint16(6, ZIP_VERSION_NEEDED, true);
    cdv.setUint16(8, ZIP_UTF8_FLAG, true);
    cdv.setUint16(10, ZIP_METHOD_STORE, true);
    cdv.setUint16(12, dosTime, true);
    cdv.setUint16(14, dosDate, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, entry.isDirectory ? 0x10 : 0x20, true);
    cdv.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    localOffset += localHeader.length + data.length;
  }

  let centralSize = 0;
  for (const part of centralParts) {
    centralSize += part.length;
  }

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, ZIP_EOCD_SIG, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, sortedEntries.length, true);
  edv.setUint16(10, sortedEntries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, localOffset, true);
  edv.setUint16(20, 0, true);

  const totalSize = localOffset + centralSize + eocd.length;
  const archive = new Uint8Array(totalSize);
  let cursor = 0;

  for (const part of localParts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  archive.set(eocd, cursor);

  return archive;
}

/**
 * Exports an entire workspace as a `.zip` archive `Blob`.
 */
export async function exportWorkspaceAsZip(
  workspaceId: string,
  options: WorkspaceZipExportOptions = {}
): Promise<Blob> {
  let rawFiles = options.files;
  if (!rawFiles) {
    if (!options.loadFiles) {
      throw new WorkspaceZipExportError(
        'WORKSPACE_FILES_REQUIRED',
        'Workspace files or a loadFiles provider must be supplied to exportWorkspaceAsZip.'
      );
    }
    rawFiles = await options.loadFiles(workspaceId);
  }

  const activeFiles: WorkspaceExportFileInput[] = [];
  for (const entry of rawFiles) {
    if (entry.workspaceId !== undefined && entry.workspaceId !== workspaceId) {
      throw new WorkspaceZipExportError(
        'CROSS_WORKSPACE_FILE_FORBIDDEN',
        `File "${entry.id}" belongs to workspace "${entry.workspaceId}", not "${workspaceId}".`
      );
    }
    if (entry.deletedAt == null) {
      activeFiles.push(entry);
    }
  }

  const hasEncryptedFiles = activeFiles.some((f) => !f.isFolder && f.isEncrypted === true);
  if (hasEncryptedFiles && options.confirmedPlaintextExport !== true) {
    throw new WorkspaceZipExportError(
      'ENCRYPTED_EXPORT_UNCONFIRMED',
      'Export of encrypted workspace files as unencrypted plaintext requires explicit confirmation.'
    );
  }

  const defaultTimestamp = options.timestamp ?? new Date();
  const decryptFile =
    options.decryptFile ?? ((payload: InboundPayloadInput) => SyncCryptoGateway.decryptInbound(payload));

  const folderById = new Map<string, WorkspaceExportFileInput>();
  for (const entry of activeFiles) {
    if (entry.isFolder) {
      folderById.set(entry.id, entry);
    }
  }

  const usedPathsLower = new Set<string>();
  const resolvedFolderPaths = new Map<string, string>();

  const resolveFolderPath = (folderId: string, visiting = new Set<string>()): string => {
    const cached = resolvedFolderPaths.get(folderId);
    if (cached !== undefined) {
      return cached;
    }

    const folder = folderById.get(folderId);
    if (!folder || visiting.has(folderId)) {
      return '';
    }

    visiting.add(folderId);
    const parentPrefix =
      folder.parentFolderId && folderById.has(folder.parentFolderId)
        ? resolveFolderPath(folder.parentFolderId, visiting)
        : '';
    const safeName = sanitizeSegment(folder.title, 'folder');
    const desired = `${parentPrefix}${safeName}`;
    const uniqueDirPath = allocateUniquePath(desired, usedPathsLower, true);
    resolvedFolderPaths.set(folderId, uniqueDirPath);
    return uniqueDirPath;
  };

  const zipEntries: ZipEntry[] = [];
  for (const folder of activeFiles) {
    if (!folder.isFolder) continue;
    const dirPath = resolveFolderPath(folder.id);
    if (dirPath) {
      zipEntries.push({
        path: dirPath,
        data: new Uint8Array(0),
        isDirectory: true,
        timestamp: parseTimestamp(folder.updatedAt, defaultTimestamp),
      });
    }
  }

  const fileIdToRelativePath = new Map<string, string>();
  let ledgerFileEntry: WorkspaceExportFileInput | null = null;

  const resolvePlaintextContent = async (file: WorkspaceExportFileInput): Promise<string> => {
    if (options.decryptedContentMap && Object.prototype.hasOwnProperty.call(options.decryptedContentMap, file.id)) {
      return options.decryptedContentMap[file.id];
    }

    if (!file.isEncrypted) {
      return file.content ?? '';
    }

    const result = await decryptFile({
      fileId: file.id,
      content: file.content ?? '',
      isEncrypted: true,
      encryptionMetadata: file.encryptionMetadata ?? null,
      userId: file.userId ?? options.userId,
    });

    if (result.status === 'locked' || result.isVaultLocked) {
      throw new WorkspaceZipExportError(
        'VAULT_LOCKED',
        `Cannot export encrypted file "${file.title}" (${file.id}): vault is locked.`
      );
    }

    if (result.status === 'error') {
      throw new WorkspaceZipExportError(
        'DECRYPTION_FAILED',
        result.error || `Failed to decrypt file "${file.title}" (${file.id}).`
      );
    }

    return result.content;
  };

  for (const file of activeFiles) {
    if (file.isFolder) continue;
    if (isDecisionLedgerFile(file)) {
      ledgerFileEntry = file;
      continue;
    }

    const parentPrefix =
      file.parentFolderId && folderById.has(file.parentFolderId)
        ? resolveFolderPath(file.parentFolderId)
        : '';
    const safeTitle = sanitizeSegment(file.title, 'untitled');
    const uniqueFilePath = allocateUniquePath(`${parentPrefix}${safeTitle}`, usedPathsLower, false);

    const plaintext = await resolvePlaintextContent(file);
    fileIdToRelativePath.set(file.id, uniqueFilePath);

    zipEntries.push({
      path: uniqueFilePath,
      data: utf8Encoder.encode(plaintext),
      isDirectory: false,
      timestamp: parseTimestamp(file.updatedAt, defaultTimestamp),
    });
  }

  if (options.decisionLedger !== undefined && options.decisionLedger !== null) {
    const ledgerJson = serializeDecisionLedger(options.decisionLedger, fileIdToRelativePath);
    zipEntries.push({
      path: 'decisions.ledger.json',
      data: utf8Encoder.encode(ledgerJson),
      isDirectory: false,
      timestamp: defaultTimestamp,
    });
  } else if (ledgerFileEntry) {
    const rawLedger = await resolvePlaintextContent(ledgerFileEntry);
    const ledgerJson = serializeDecisionLedger(rawLedger, fileIdToRelativePath);
    zipEntries.push({
      path: 'decisions.ledger.json',
      data: utf8Encoder.encode(ledgerJson),
      isDirectory: false,
      timestamp: parseTimestamp(ledgerFileEntry.updatedAt, defaultTimestamp),
    });
  }

  const archiveBytes = buildZipArchive(zipEntries);
  return new Blob([new Uint8Array(archiveBytes)], { type: 'application/zip' });
}
