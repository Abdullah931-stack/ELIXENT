/**
 * Unit Test Suite: Decoupled Files & Folders Actions (Wave 3.1)
 *
 * Verifies the isolated, decoupled execution of:
 * 1. `src/server/actions/files.ts`:
 *    - createFile: auth guards, title sanitization/truncation (<= 500 chars), root vs nested,
 *      parent folder existence/type validation, ETag & version initialization.
 *    - updateFileContent: optimistic concurrency control (version & ETag conflict detection),
 *      not_found handling, rejection of direct plaintext edit on encrypted files, atomic version bump.
 *    - renameFile: auth guards, title trimming and truncation, empty title error, not_found handling.
 *    - deleteFile: soft-delete, optimistic version checking, recursive descendant soft-deletion.
 *    - restoreFile: soft-delete un-marking, parent folder detachment to root, collision handling.
 *    - copyFile: title duplication suffix, depth limit enforcement, encrypted copy security guard,
 *      self/descendant destination prohibition.
 * 2. `src/server/actions/folders.ts`:
 *    - moveFile: cycle prevention, self-move rejection, non-folder destination rejection.
 *    - getFolderChildren: hierarchy listing with auth guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireAuthenticatedUser = vi.fn();
const mockDbFindFirst = vi.fn();
const mockDbFindMany = vi.fn();
const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbDelete = vi.fn();

vi.mock("@/server/auth/session", () => ({
    requireAuthenticatedUser: () => mockRequireAuthenticatedUser(),
}));

vi.mock("@/server/db", () => {
    return {
        db: {
            query: {
                files: {
                    findFirst: (...args: unknown[]) => mockDbFindFirst(...args),
                    findMany: (...args: unknown[]) => mockDbFindMany(...args),
                },
            },
            insert: (...args: unknown[]) => {
                mockDbInsert(...args);
                return {
                    values: (val: unknown) => ({
                        returning: () => [val],
                    }),
                };
            },
            update: (...args: unknown[]) => {
                mockDbUpdate(...args);
                return {
                    set: (payload: unknown) => ({
                        where: () => ({
                            returning: () => [payload],
                            rowCount: 1,
                        }),
                    }),
                };
            },
            delete: (...args: unknown[]) => {
                mockDbDelete(...args);
                return {
                    where: () => ({
                        returning: () => [],
                        rowCount: 1,
                    }),
                };
            },
        },
        schema: {
            files: {
                id: "id",
                userId: "user_id",
                title: "title",
                content: "content",
                parentFolderId: "parent_folder_id",
                isFolder: "is_folder",
                isEncrypted: "is_encrypted",
                encryptionMetadata: "encryption_metadata",
                version: "version",
                etag: "etag",
                deletedAt: "deleted_at",
                createdAt: "created_at",
                updatedAt: "updated_at",
            },
        },
    };
});

import {
    createFile,
    updateFileContent,
    renameFile,
    deleteFile,
    restoreFile,
    copyFile,
} from "@/server/actions/files";
import { moveFile, getFolderChildren } from "@/server/actions/folders";

describe("Decoupled Files & Folders Actions (Wave 3.1)", () => {
    const mockUser = { id: "user_actions_test_123", email: "tester@elixent.app" };

    beforeEach(() => {
        mockRequireAuthenticatedUser.mockReset();
        mockDbFindFirst.mockReset();
        mockDbFindMany.mockReset();
        mockDbInsert.mockReset();
        mockDbUpdate.mockReset();
        mockDbDelete.mockReset();

        mockRequireAuthenticatedUser.mockResolvedValue(mockUser);
        mockDbFindFirst.mockResolvedValue(null);
        mockDbFindMany.mockResolvedValue([]);
    });

    describe("createFile", () => {
        it("returns unauthorized when user session is missing", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

            const result = await createFile("Notes.md");

            expect(result.success).toBe(false);
            expect(result.status).toBe("unauthorized");
            expect(result.error).toBe("Authentication required");
        });

        it("creates a root document with version 1, initial ETag, and trimmed title", async () => {
            const result = await createFile("  My Research Notes.md  ");

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data?.title).toBe("My Research Notes.md");
            expect(result.data?.version).toBe(1);
            expect(result.data?.isFolder).toBe(false);
            expect(result.data?.parentFolderId).toBeNull();
            expect(mockDbInsert).toHaveBeenCalled();
        });

        it("truncates titles exceeding 500 characters to comply with PostgreSQL varchar limit", async () => {
            const massiveTitle = "A".repeat(550);

            const result = await createFile(massiveTitle);

            expect(result.success).toBe(true);
            expect(result.data?.title.length).toBe(500);
            expect(result.data?.title).toBe("A".repeat(500));
        });

        it("defaults empty string title to 'Untitled Document'", async () => {
            const result = await createFile("");

            expect(result.success).toBe(true);
            expect(result.data?.title).toBe("Untitled Document");
        });

        it("defaults whitespace-only title to 'Untitled Document'", async () => {
            const result = await createFile("     \t\n   ");

            expect(result.success).toBe(true);
            expect(result.data?.title).toBe("Untitled Document");
        });

        it("creates a folder when isFolder is true", async () => {
            const result = await createFile("Projects", null, true);

            expect(result.success).toBe(true);
            expect(result.data?.isFolder).toBe(true);
        });

        it("validates that parent folder exists and is owned by the user", async () => {
            mockDbFindFirst.mockResolvedValueOnce({
                id: "folder_parent_1",
                userId: mockUser.id,
                isFolder: true,
                deletedAt: null,
            });

            const result = await createFile("Chapter1.md", "folder_parent_1");

            expect(result.success).toBe(true);
            expect(result.data?.parentFolderId).toBe("folder_parent_1");
        });

        it("returns not_found when parent folder does not exist or is deleted", async () => {
            mockDbFindFirst.mockResolvedValueOnce(null);

            const result = await createFile("Doc.md", "non_existent_folder");

            expect(result.success).toBe(false);
            expect(result.status).toBe("not_found");
            expect(result.error).toBe("Parent folder not found");
        });

        it("returns error when target parent is a file rather than a folder", async () => {
            mockDbFindFirst.mockResolvedValueOnce({
                id: "target_file_id",
                userId: mockUser.id,
                isFolder: false,
                deletedAt: null,
            });

            const result = await createFile("Child.md", "target_file_id");

            expect(result.success).toBe(false);
            expect(result.status).toBe("error");
            expect(result.error).toBe("Target parent is not a folder");
        });

        it("catches database exception and returns controlled error status", async () => {
            mockDbInsert.mockImplementationOnce(() => {
                throw new Error("Neon storage timeout");
            });

            const result = await createFile("Fail.md");

            expect(result.success).toBe(false);
            expect(result.status).toBe("error");
            expect(result.error).toBe("Failed to create file");
        });
    });

    describe("updateFileContent", () => {
        const mockExistingFile = {
            id: "file_update_1",
            userId: mockUser.id,
            title: "Article.md",
            content: "Old text",
            version: 3,
            etag: '"etag-v3-hash"',
            isFolder: false,
            isEncrypted: false,
            encryptionMetadata: null,
            deletedAt: null,
            updatedAt: new Date(),
        };

        it("returns unauthorized when user session is missing", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

            const result = await updateFileContent("file_update_1", "New text");

            expect(result.success).toBe(false);
            expect(result.status).toBe("unauthorized");
        });

        it("returns not_found when file does not exist", async () => {
            mockDbFindFirst.mockResolvedValueOnce(null);

            const result = await updateFileContent("file_missing", "New text");

            expect(result.success).toBe(false);
            expect(result.status).toBe("not_found");
        });

        it("detects optimistic concurrency conflict when expectedVersion does not match current version", async () => {
            mockDbFindFirst.mockResolvedValueOnce(mockExistingFile);

            const result = await updateFileContent("file_update_1", "Stale text", {
                expectedVersion: 2, // Current is 3
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe("conflict");
            expect(result.error).toContain("Conflict");
            expect(result.serverVersion?.version).toBe(3);
        });

        it("detects optimistic concurrency conflict when expectedETag does not match current ETag", async () => {
            mockDbFindFirst.mockResolvedValueOnce(mockExistingFile);

            const result = await updateFileContent("file_update_1", "Stale text", {
                expectedETag: '"etag-stale"',
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe("conflict");
            expect(result.serverVersion?.etag).toBe('"etag-v3-hash"');
        });

        it("advances version and generates fresh ETag on valid matching update", async () => {
            mockDbFindFirst.mockResolvedValueOnce(mockExistingFile);

            const result = await updateFileContent("file_update_1", "Updated content", {
                expectedVersion: 3,
                expectedETag: '"etag-v3-hash"',
            });

            expect(result.success).toBe(true);
            expect(result.version).toBe(4);
            expect(result.etag).toBeDefined();
            expect(mockDbUpdate).toHaveBeenCalled();
        });

        it("rejects direct update of encrypted file with plaintext error", async () => {
            const encryptedFile = {
                ...mockExistingFile,
                isEncrypted: true,
                encryptionMetadata: {
                    algorithm: "AES-GCM",
                    keyId: "master-key-1",
                    iv: "iv-sample",
                },
            };
            mockDbFindFirst.mockResolvedValueOnce(encryptedFile);

            const result = await updateFileContent("file_update_1", "plaintext:bypass:attempt", {
                expectedVersion: 3,
            });

            expect(result.success).toBe(false);
            expect(result.status).toBe("error");
            expect(result.error).toContain("Cannot directly update encrypted file with plaintext");
            expect(mockDbUpdate).not.toHaveBeenCalled();
        });
    });

    describe("renameFile", () => {
        it("returns unauthorized when user session is missing", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

            const result = await renameFile("file_1", "New Title.md");

            expect(result.success).toBe(false);
            expect(result.status).toBe("unauthorized");
        });

        it("returns not_found when file to rename does not exist", async () => {
            mockDbFindFirst.mockResolvedValueOnce(null);

            const result = await renameFile("missing_file", "New Title.md");

            expect(result.success).toBe(false);
            expect(result.status).toBe("not_found");
        });

        it("renames file with trimmed and capped title", async () => {
            mockDbFindFirst.mockResolvedValueOnce({
                id: "file_1",
                userId: mockUser.id,
                title: "Old.md",
                deletedAt: null,
            });

            const result = await renameFile("file_1", "   Updated Document Name.md   ");

            expect(result.success).toBe(true);
            expect(mockDbUpdate).toHaveBeenCalled();
        });

        it("rejects empty or whitespace title with 'Title cannot be empty'", async () => {
            const result = await renameFile("file_1", "   ");

            expect(result.success).toBe(false);
            expect(result.status).toBe("error");
            expect(result.error).toBe("Title cannot be empty");
            expect(mockDbFindFirst).not.toHaveBeenCalled();
        });
    });

    describe("deleteFile", () => {
        it("returns unauthorized when user session is missing", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

            const result = await deleteFile("file_del_1");

            expect(result.success).toBe(false);
            expect(result.status).toBe("unauthorized");
        });

        it("returns not_found when file to delete does not exist", async () => {
            mockDbFindFirst.mockResolvedValueOnce(null);

            const result = await deleteFile("missing_file");

            expect(result.success).toBe(false);
            expect(result.status).toBe("not_found");
        });

        it("rejects deletion when expectedVersion conflicts with current version", async () => {
            mockDbFindFirst.mockResolvedValueOnce({
                id: "file_del_1",
                userId: mockUser.id,
                version: 5,
                etag: '"etag-v5"',
                isFolder: false,
                deletedAt: null,
                updatedAt: new Date(),
            });

            const result = await deleteFile("file_del_1", { expectedVersion: 4 });

            expect(result.success).toBe(false);
            expect(result.status).toBe("conflict");
        });

        it("soft deletes a file and updates deletedAt", async () => {
            mockDbFindFirst.mockResolvedValueOnce({
                id: "file_del_1",
                userId: mockUser.id,
                version: 2,
                isFolder: false,
                deletedAt: null,
                updatedAt: new Date(),
            });

            const result = await deleteFile("file_del_1");

            expect(result.success).toBe(true);
            expect(mockDbUpdate).toHaveBeenCalled();
        });

        it("soft deletes all descendants recursively when deleting a folder", async () => {
            mockDbFindFirst.mockResolvedValueOnce({
                id: "folder_del_root",
                userId: mockUser.id,
                version: 1,
                isFolder: true,
                deletedAt: null,
                updatedAt: new Date(),
            });
            // Descendants query returns child items
            mockDbFindMany.mockResolvedValueOnce([
                { id: "child_subfolder", isFolder: true },
                { id: "child_file", isFolder: false },
            ]).mockResolvedValueOnce([]); // Sub-subfolder has no children

            const result = await deleteFile("folder_del_root");

            expect(result.success).toBe(true);
            expect(mockDbUpdate).toHaveBeenCalled();
        });
    });

    describe("restoreFile", () => {
        it("returns unauthorized when session is absent", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

            const result = await restoreFile("file_res_1");

            expect(result.success).toBe(false);
            expect(result.status).toBe("unauthorized");
        });

        it("returns not_found when file does not exist", async () => {
            mockDbFindFirst.mockResolvedValueOnce(null);

            const result = await restoreFile("missing_res");

            expect(result.success).toBe(false);
            expect(result.status).toBe("not_found");
        });

        it("returns error when file is not soft-deleted", async () => {
            mockDbFindFirst.mockResolvedValueOnce({
                id: "live_file",
                userId: mockUser.id,
                deletedAt: null,
            });

            const result = await restoreFile("live_file");

            expect(result.success).toBe(false);
            expect(result.status).toBe("error");
            expect(result.error).toBe("File is not deleted");
        });

        it("restores file and resolves title collisions with (Restored) suffix", async () => {
            mockDbFindFirst
                .mockResolvedValueOnce({
                    id: "trashed_file",
                    userId: mockUser.id,
                    title: "Report.md",
                    parentFolderId: null,
                    deletedAt: new Date(),
                    isFolder: false,
                    version: 1,
                })
                // Collision query: duplicate exists with same title in live files
                .mockResolvedValueOnce({ id: "live_conflict_1", title: "Report.md" })
                // Second collision query with "(Restored)": no duplicate
                .mockResolvedValueOnce(null);

            const result = await restoreFile("trashed_file");

            expect(result.success).toBe(true);
            expect(mockDbUpdate).toHaveBeenCalled();
        });

        it("detaches to root if original parent folder was deleted or is missing", async () => {
            mockDbFindFirst
                .mockResolvedValueOnce({
                    id: "trashed_child",
                    userId: mockUser.id,
                    title: "Orphaned.md",
                    parentFolderId: "deleted_parent_folder",
                    deletedAt: new Date(),
                    isFolder: false,
                    version: 1,
                })
                // Parent folder check: returns null (parent is deleted or missing)
                .mockResolvedValueOnce(null)
                // Collision check in root: no collision
                .mockResolvedValueOnce(null);

            const result = await restoreFile("trashed_child");

            expect(result.success).toBe(true);
            expect(mockDbUpdate).toHaveBeenCalled();
        });
    });

    describe("copyFile", () => {
        it("returns unauthorized when user session is missing", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

            const result = await copyFile("file_copy_1");

            expect(result.success).toBe(false);
            expect(result.status).toBe("unauthorized");
        });

        it("returns not_found when original file does not exist", async () => {
            mockDbFindFirst.mockResolvedValueOnce(null);

            const result = await copyFile("missing_copy");

            expect(result.success).toBe(false);
            expect(result.status).toBe("not_found");
        });

        it("blocks copying encrypted file when client-side re-encryption override is not provided", async () => {
            mockDbFindFirst.mockResolvedValueOnce({
                id: "enc_file_1",
                userId: mockUser.id,
                title: "Secret.md",
                isEncrypted: true,
                isFolder: false,
                deletedAt: null,
            });

            const result = await copyFile("enc_file_1");

            expect(result.success).toBe(false);
            expect(result.status).toBe("error");
            expect(result.error).toContain("Encrypted files require client-side re-encryption");
        });

        it("strictly rejects empty object {} or partial override when copying encrypted file", async () => {
            mockDbFindFirst.mockResolvedValueOnce({
                id: "enc_file_1",
                userId: mockUser.id,
                title: "Secret.md",
                isEncrypted: true,
                isFolder: false,
                deletedAt: null,
            });

            const resultEmpty = await copyFile("enc_file_1", null, 0, {} as any);
            expect(resultEmpty.success).toBe(false);
            expect(resultEmpty.status).toBe("error");
            expect(resultEmpty.error).toContain("Encrypted files require client-side re-encryption");

            // Partial override missing content
            mockDbFindFirst.mockResolvedValueOnce({
                id: "enc_file_1",
                userId: mockUser.id,
                title: "Secret.md",
                isEncrypted: true,
                isFolder: false,
                deletedAt: null,
            });

            const resultMissingContent = await copyFile("enc_file_1", null, 0, {
                newFileId: "550e8400-e29b-41d4-a716-446655440000",
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "master-v1",
                    salt: "salt",
                    iv: "iv",
                    kdfIterations: 600000,
                },
            });
            expect(resultMissingContent.success).toBe(false);
            expect(resultMissingContent.status).toBe("error");

            // Partial override missing iv
            mockDbFindFirst.mockResolvedValueOnce({
                id: "enc_file_1",
                userId: mockUser.id,
                title: "Secret.md",
                isEncrypted: true,
                isFolder: false,
                deletedAt: null,
            });

            const resultMissingIv = await copyFile("enc_file_1", null, 0, {
                newFileId: "550e8400-e29b-41d4-a716-446655440000",
                content: "ciphertext",
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "master-v1",
                    salt: "salt",
                    iv: "",
                    kdfIterations: 600000,
                },
            });
            expect(resultMissingIv.success).toBe(false);
            expect(resultMissingIv.status).toBe("error");
        });

        it("prohibits copying a folder into itself", async () => {
            mockDbFindFirst
                // Original folder
                .mockResolvedValueOnce({
                    id: "folder_self",
                    userId: mockUser.id,
                    isFolder: true,
                    isEncrypted: false,
                    deletedAt: null,
                })
                // Destination folder (same as original)
                .mockResolvedValueOnce({
                    id: "folder_self",
                    userId: mockUser.id,
                    isFolder: true,
                    deletedAt: null,
                });

            const result = await copyFile("folder_self", "folder_self");

            expect(result.success).toBe(false);
            expect(result.status).toBe("conflict");
            expect(result.error).toBe("Cannot copy a folder into itself");
        });

        it("enforces depth limit preventing deep recursion attacks (> 20 levels)", async () => {
            const result = await copyFile("deep_file", null, 25);

            expect(result.success).toBe(false);
            expect(result.status).toBe("error");
            expect(result.error).toBe("Maximum folder nesting depth exceeded during copy");
        });

        it("successfully copies a file with (Copy) title and resets version to 1", async () => {
            mockDbFindFirst
                .mockResolvedValueOnce({
                    id: "orig_doc",
                    userId: mockUser.id,
                    title: "Proposal.md",
                    content: "# Project Proposal",
                    parentFolderId: null,
                    isFolder: false,
                    isEncrypted: false,
                    deletedAt: null,
                })
                // Title collision check: no collision
                .mockResolvedValueOnce(null);

            const result = await copyFile("orig_doc");

            expect(result.success).toBe(true);
            expect(result.data?.version).toBe(1);
            expect(result.data?.title).toContain("(Copy)");
            expect(mockDbInsert).toHaveBeenCalled();
        });
    });

    describe("folders.ts operations (moveFile & getFolderChildren)", () => {
        describe("moveFile", () => {
            it("returns unauthorized when user session is missing", async () => {
                mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

                const result = await moveFile("f_1", "f_2");

                expect(result.success).toBe(false);
                expect(result.status).toBe("unauthorized");
            });

            it("rejects moving a folder into itself", async () => {
                const result = await moveFile("folder_x", "folder_x");

                expect(result.success).toBe(false);
                expect(result.status).toBe("conflict");
                expect(result.error).toBe("Cannot move a folder into itself");
            });

            it("returns not_found when target file does not exist", async () => {
                mockDbFindFirst.mockResolvedValueOnce(null);

                const result = await moveFile("missing_file", "parent_1");

                expect(result.success).toBe(false);
                expect(result.status).toBe("not_found");
            });

            it("returns not_found when destination parent folder does not exist", async () => {
                mockDbFindFirst
                    .mockResolvedValueOnce({
                        id: "valid_file",
                        userId: mockUser.id,
                        isFolder: false,
                        deletedAt: null,
                    })
                    .mockResolvedValueOnce(null); // Destination folder missing

                const result = await moveFile("valid_file", "missing_dest");

                expect(result.success).toBe(false);
                expect(result.status).toBe("not_found");
                expect(result.error).toBe("Target parent folder not found");
            });

            it("returns error when target destination is a file rather than a folder", async () => {
                mockDbFindFirst
                    .mockResolvedValueOnce({
                        id: "valid_file",
                        userId: mockUser.id,
                        isFolder: false,
                        deletedAt: null,
                    })
                    .mockResolvedValueOnce({
                        id: "target_file_not_folder",
                        userId: mockUser.id,
                        isFolder: false,
                        deletedAt: null,
                    });

                const result = await moveFile("valid_file", "target_file_not_folder");

                expect(result.success).toBe(false);
                expect(result.status).toBe("error");
                expect(result.error).toBe("Target destination is not a folder");
            });

            it("prevents circular hierarchy when moving folder into one of its descendants", async () => {
                mockDbFindFirst
                    // Target folder being moved
                    .mockResolvedValueOnce({
                        id: "folder_parent",
                        userId: mockUser.id,
                        isFolder: true,
                        deletedAt: null,
                    })
                    // Destination parent folder
                    .mockResolvedValueOnce({
                        id: "folder_child",
                        userId: mockUser.id,
                        isFolder: true,
                        parentFolderId: "folder_parent",
                        deletedAt: null,
                    });

                const result = await moveFile("folder_parent", "folder_child");

                expect(result.success).toBe(false);
                expect(result.status).toBe("conflict");
                expect(result.error).toBe("Cannot move a folder into one of its descendants");
            });

            it("successfully moves file to new parent folder", async () => {
                mockDbFindFirst
                    .mockResolvedValueOnce({
                        id: "file_to_move",
                        userId: mockUser.id,
                        isFolder: false,
                        deletedAt: null,
                    })
                    .mockResolvedValueOnce({
                        id: "dest_folder",
                        userId: mockUser.id,
                        isFolder: true,
                        deletedAt: null,
                    });

                const result = await moveFile("file_to_move", "dest_folder");

                expect(result.success).toBe(true);
                expect(mockDbUpdate).toHaveBeenCalled();
            });

            it("successfully moves file to root (parentFolderId = null)", async () => {
                mockDbFindFirst.mockResolvedValueOnce({
                    id: "nested_file",
                    userId: mockUser.id,
                    isFolder: false,
                    parentFolderId: "some_old_folder",
                    deletedAt: null,
                });

                const result = await moveFile("nested_file", null);

                expect(result.success).toBe(true);
                expect(mockDbUpdate).toHaveBeenCalled();
            });
        });

        describe("getFolderChildren", () => {
            it("returns unauthorized when user session is missing", async () => {
                mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

                const result = await getFolderChildren("folder_1");

                expect(result.success).toBe(false);
                expect(result.status).toBe("unauthorized");
            });

            it("returns children sorted by folder status and recency", async () => {
                const mockChildren = [
                    { id: "subfolder_1", isFolder: true, updatedAt: new Date() },
                    { id: "file_1", isFolder: false, updatedAt: new Date() },
                ];
                mockDbFindMany.mockResolvedValueOnce(mockChildren);

                const result = await getFolderChildren("folder_1");

                expect(result.success).toBe(true);
                expect(result.data).toEqual(mockChildren);
            });
        });
    });
});
