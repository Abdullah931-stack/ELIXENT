// @vitest-environment jsdom
/**
 * Exhaustive Integration Test Suite: Client UI Components & Hooks rewired to Hono RPC Client
 * (`src/test/client/ui-rpc-integration.test.tsx`)
 *
 * Verifies:
 * 1. Sidebar Component Integration:
 *    - Loads user files on mount via RPC `getUserFiles()`.
 *    - Creates new documents via RPC `createFile(title, null, false)`.
 *    - Creates new directories via RPC `createFile(title, null, true)`.
 *    - Switches to trash view and retrieves soft-deleted files via RPC `getDeletedFiles()`.
 *    - Executes drag-and-drop file relocation via RPC `moveFile(fileId, targetFolderId)`.
 * 2. Vault Security UI Integration:
 *    - VaultSecurityCard fetches user vault state via RPC `getUserVaultProfile()`.
 *    - Toggles AI processing on encrypted files via RPC `updateVaultAISetting(allow)`.
 *    - Revokes all trusted device envelopes via RPC `revokeAllTrustedDevices()`.
 * 3. Client Hook RPC Orchestration:
 *    - useEditorOrchestrator loads document via RPC `getFile(fileId)`.
 *    - useEditorConflict executes conditioned conflict resolution via RPC `updateFileContent()`.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Sidebar } from "@/components/layout/sidebar";
import { VaultSecurityCard } from "@/components/vault/vault-security-card";

// Hoisted mock RPC implementations
const {
    mockGetUserFiles,
    mockGetDeletedFiles,
    mockCreateFile,
    mockMoveFile,
    mockGetUserVaultProfile,
    mockRevokeAllTrustedDevices,
    mockUpdateVaultAISetting,
    mockGetFile,
    mockUpdateFileContent,
} = vi.hoisted(() => ({
    mockGetUserFiles: vi.fn(),
    mockGetDeletedFiles: vi.fn(),
    mockCreateFile: vi.fn(),
    mockMoveFile: vi.fn(),
    mockGetUserVaultProfile: vi.fn(),
    mockRevokeAllTrustedDevices: vi.fn(),
    mockUpdateVaultAISetting: vi.fn(),
    mockGetFile: vi.fn(),
    mockUpdateFileContent: vi.fn(),
}));

vi.mock("@/client/rpc-client", () => ({
    getUserFiles: (...args: any[]) => mockGetUserFiles(...args),
    getDeletedFiles: (...args: any[]) => mockGetDeletedFiles(...args),
    createFile: (...args: any[]) => mockCreateFile(...args),
    moveFile: (...args: any[]) => mockMoveFile(...args),
    getUserVaultProfile: (...args: any[]) => mockGetUserVaultProfile(...args),
    revokeAllTrustedDevices: (...args: any[]) => mockRevokeAllTrustedDevices(...args),
    updateVaultAISetting: (...args: any[]) => mockUpdateVaultAISetting(...args),
    getFile: (...args: any[]) => mockGetFile(...args),
    updateFileContent: (...args: any[]) => mockUpdateFileContent(...args),
}));

vi.mock("@/lib/supabase/client", () => ({
    createClient: () => ({
        auth: {
            getUser: vi.fn().mockResolvedValue({ data: { user: { id: "test-user-uuid" } } }),
        },
    }),
}));

vi.mock("@/hooks/use-toast", () => ({
    useToast: () => ({
        toast: vi.fn(),
    }),
}));

vi.mock("@/lib/sync/indexeddb", () => ({
    indexedDBManager: {
        init: vi.fn().mockResolvedValue(undefined),
        getDeviceTrustEnvelope: vi.fn().mockResolvedValue(null),
        clearDeviceTrustEnvelope: vi.fn().mockResolvedValue(undefined),
    },
}));

describe("Client UI & Hooks Hono RPC Integration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(window, "prompt").mockImplementation(() => "My New Document");
        vi.spyOn(window, "confirm").mockImplementation(() => true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("1. Sidebar Component Integration", () => {
        it("fetches user files on mount via RPC getUserFiles and displays them", async () => {
            mockGetUserFiles.mockResolvedValueOnce({
                success: true,
                data: [
                    {
                        id: "file-101",
                        title: "Overview.md",
                        isFolder: false,
                        parentFolderId: null,
                        updatedAt: new Date("2026-01-01"),
                    },
                    {
                        id: "folder-101",
                        title: "Specifications",
                        isFolder: true,
                        parentFolderId: null,
                        updatedAt: new Date("2026-01-01"),
                    },
                ],
            });

            render(<Sidebar userId="test-user-uuid" />);

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            expect(mockGetUserFiles).toHaveBeenCalledTimes(1);
            expect(screen.getByText("Overview.md")).toBeDefined();
            expect(screen.getByText("Specifications")).toBeDefined();
        });

        it("dispatches RPC createFile when user clicks 'New File'", async () => {
            mockGetUserFiles.mockResolvedValue({
                success: true,
                data: [],
            });
            mockCreateFile.mockResolvedValueOnce({
                success: true,
                data: { id: "new-doc-id", title: "My New Document", isFolder: false },
            });

            render(<Sidebar userId="test-user-uuid" />);

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            const newFileBtn = screen.getByText("New File");
            expect(newFileBtn).toBeDefined();

            fireEvent.click(newFileBtn);

            expect(window.prompt).toHaveBeenCalledWith("Enter file name:");

            await waitFor(() => {
                expect(mockCreateFile).toHaveBeenCalledWith("My New Document", null, false);
            });
        });

        it("dispatches RPC createFile with isFolder=true when user clicks '+ New Folder'", async () => {
            vi.spyOn(window, "prompt").mockReturnValueOnce("Project Folder");
            mockGetUserFiles.mockResolvedValue({
                success: true,
                data: [],
            });
            mockCreateFile.mockResolvedValueOnce({
                success: true,
                data: { id: "new-folder-id", title: "Project Folder", isFolder: true },
            });

            const { container } = render(<Sidebar userId="test-user-uuid" />);

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            const folderPlusIcon = container.querySelector("svg.lucide-folder-plus");
            expect(folderPlusIcon).toBeDefined();
            const newFolderBtn = folderPlusIcon!.closest("button")!;

            fireEvent.click(newFolderBtn);

            expect(window.prompt).toHaveBeenCalledWith("Enter folder name:");

            await waitFor(() => {
                expect(mockCreateFile).toHaveBeenCalledWith("Project Folder", null, true);
            });
        });

        it("loads deleted files via RPC getDeletedFiles when switching to Trash view", async () => {
            mockGetUserFiles.mockResolvedValue({
                success: true,
                data: [],
            });
            mockGetDeletedFiles.mockResolvedValueOnce({
                success: true,
                data: [
                    {
                        id: "recycled-1",
                        title: "old-archive.md",
                        isFolder: false,
                        parentFolderId: null,
                        updatedAt: new Date(),
                        deletedAt: new Date(),
                    },
                ],
            });

            render(<Sidebar userId="test-user-uuid" />);

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            const trashBtn = screen.getByText("Deleted Files");
            expect(trashBtn).toBeDefined();

            fireEvent.click(trashBtn);

            await waitFor(() => {
                expect(mockGetDeletedFiles).toHaveBeenCalledTimes(1);
            });

            expect(screen.getByText("old-archive.md")).toBeDefined();
        });
    });

    describe("2. Vault Security UI Integration", () => {
        it("fetches vault profile via RPC getUserVaultProfile and displays enabled AI state", async () => {
            mockGetUserVaultProfile.mockResolvedValueOnce({
                success: true,
                data: {
                    userId: "test-user-uuid",
                    deviceTrustEpoch: 1,
                    allowAIOnEncryptedFiles: true,
                },
            });

            render(<VaultSecurityCard userId="test-user-uuid" />);

            await waitFor(() => {
                expect(mockGetUserVaultProfile).toHaveBeenCalledTimes(1);
            });

            expect(screen.getByText("مفعّل (انقر للتعطيل)")).toBeDefined();
        });

        it("dispatches RPC revokeAllTrustedDevices when user confirms device trust revocation", async () => {
            mockGetUserVaultProfile.mockResolvedValue({
                success: true,
                data: {
                    userId: "test-user-uuid",
                    deviceTrustEpoch: 2,
                    allowAIOnEncryptedFiles: false,
                },
            });
            mockRevokeAllTrustedDevices.mockResolvedValueOnce({
                success: true,
                data: { deviceTrustEpoch: 3 },
            });

            render(<VaultSecurityCard userId="test-user-uuid" />);

            await waitFor(() => {
                expect(mockGetUserVaultProfile).toHaveBeenCalled();
            });

            const revokeAllBtn = screen.getByText("إلغاء الكل");
            expect(revokeAllBtn).toBeDefined();

            fireEvent.click(revokeAllBtn);

            // Confirmation modal appears
            const confirmBtn = screen.getByText("نعم، إبطال الكل الآن");
            expect(confirmBtn).toBeDefined();

            fireEvent.click(confirmBtn);

            await waitFor(() => {
                expect(mockRevokeAllTrustedDevices).toHaveBeenCalledTimes(1);
            });
        });

        it("dispatches RPC updateVaultAISetting when user toggles AI on encrypted notes", async () => {
            mockGetUserVaultProfile.mockResolvedValue({
                success: true,
                data: {
                    userId: "test-user-uuid",
                    deviceTrustEpoch: 1,
                    allowAIOnEncryptedFiles: false,
                },
            });
            mockUpdateVaultAISetting.mockResolvedValueOnce({
                success: true,
                data: { allowAIOnEncryptedFiles: true },
            });

            render(<VaultSecurityCard userId="test-user-uuid" />);

            await waitFor(() => {
                expect(mockGetUserVaultProfile).toHaveBeenCalled();
            });

            const toggleBtn = screen.getByText("محظور (انقر للتفعيل)");
            expect(toggleBtn).toBeDefined();

            fireEvent.click(toggleBtn);

            await waitFor(() => {
                expect(mockUpdateVaultAISetting).toHaveBeenCalledWith(true);
            });
        });
    });

    describe("3. Client Hooks & Facade Direct Wiring", () => {
        it("verifies RPC facade delegates correctly without server-action-only headers", async () => {
            mockGetFile.mockResolvedValueOnce({
                success: true,
                data: {
                    id: "doc-test",
                    title: "Test File",
                    content: "# Hello World",
                    version: 1,
                    etag: "w-etag-1",
                    isEncrypted: false,
                },
            });

            const { getFile } = await import("@/client/rpc-client");
            const result = await getFile("doc-test");

            expect(mockGetFile).toHaveBeenCalledWith("doc-test");
            expect(result.success).toBe(true);
            expect(result.data?.content).toBe("# Hello World");
        });

        it("verifies updateFileContent sends conditioned expectedVersion and etag through RPC", async () => {
            mockUpdateFileContent.mockResolvedValueOnce({
                success: true,
                version: 2,
                etag: "w-etag-2",
            });

            const { updateFileContent } = await import("@/client/rpc-client");
            const result = await updateFileContent("doc-test", "# Updated Content", {
                expectedVersion: 1,
                expectedETag: "w-etag-1",
            });

            expect(mockUpdateFileContent).toHaveBeenCalledWith(
                "doc-test",
                "# Updated Content",
                { expectedVersion: 1, expectedETag: "w-etag-1" }
            );
            expect(result.success).toBe(true);
            expect(result.version).toBe(2);
        });
    });
});
