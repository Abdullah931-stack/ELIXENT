// @vitest-environment jsdom
/**
 * Comprehensive Unit & Integration Test Suite for FileContextMenu RPC Operations
 * (`src/components/files/file-context-menu.tsx`)
 *
 * Verifies:
 * 1. Rename File / Folder Operation:
 *    - Enters rename editing mode upon clicking "إعادة التسمية".
 *    - Dispatches RPC `renameFile(fileId, newName)` upon Enter key.
 *    - Cancels rename upon Escape key without invoking RPC.
 *    - Calls onRefresh() and onClose() on successful rename.
 *    - Shows alert notification on RPC rename failure.
 * 2. Delete File / Folder Operation:
 *    - Prompts user confirmation via window.confirm.
 *    - Dispatches RPC `deleteFile(fileId)` when confirmed.
 *    - Bypasses RPC delete when user cancels the confirm prompt.
 *    - Calls onRefresh() and onClose() on successful delete.
 *    - Shows alert on RPC delete failure.
 * 3. Restore Tombstoned Item:
 *    - Renders "استعادة" button when isDeleted is true.
 *    - Dispatches RPC `restoreFile(fileId)`.
 *    - Calls onRefresh() and onClose() on successful restore.
 *    - Shows alert on RPC restore failure.
 * 4. Copy & Move Integration via RPC Client:
 *    - Clicking "نسخ" opens FolderPickerModal and dispatches RPC `copyFile(fileId, targetFolderId)`.
 *    - Clicking "نقل" opens FolderPickerModal and dispatches RPC `moveFile(fileId, targetFolderId)`.
 *    - Handles RPC failure gracefully during copy and move.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FileContextMenu } from "@/components/files/file-context-menu";

const {
    mockDeleteFile,
    mockRestoreFile,
    mockRenameFile,
    mockCopyFile,
    mockMoveFile,
    mockGetFile,
    mockToggleFileEncryption,
    mockGetUserVaultProfile,
} = vi.hoisted(() => ({
    mockDeleteFile: vi.fn(),
    mockRestoreFile: vi.fn(),
    mockRenameFile: vi.fn(),
    mockCopyFile: vi.fn(),
    mockMoveFile: vi.fn(),
    mockGetFile: vi.fn(),
    mockToggleFileEncryption: vi.fn(),
    mockGetUserVaultProfile: vi.fn(),
}));

vi.mock("@/client/rpc-client", () => ({
    deleteFile: (...args: any[]) => mockDeleteFile(...args),
    restoreFile: (...args: any[]) => mockRestoreFile(...args),
    renameFile: (...args: any[]) => mockRenameFile(...args),
    copyFile: (...args: any[]) => mockCopyFile(...args),
    moveFile: (...args: any[]) => mockMoveFile(...args),
    getFile: (...args: any[]) => mockGetFile(...args),
    toggleFileEncryption: (...args: any[]) => mockToggleFileEncryption(...args),
    getUserVaultProfile: (...args: any[]) => mockGetUserVaultProfile(...args),
    getUserFiles: vi.fn().mockResolvedValue({
        success: true,
        data: [{ id: "target-dir", title: "Target Directory", isFolder: true, parentFolderId: null }],
    }),
}));

vi.mock("@/lib/supabase/client", () => ({
    createClient: () => ({
        auth: {
            getUser: vi.fn().mockResolvedValue({ data: { user: { id: "test-user-id" } } }),
        },
    }),
}));

describe("FileContextMenu RPC Operations", () => {
    const mockOnClose = vi.fn();
    const mockOnRefresh = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(window, "alert").mockImplementation(() => {});
        vi.spyOn(window, "confirm").mockImplementation(() => true);
    });

    describe("1. Rename File / Folder Operation", () => {
        it("invokes RPC renameFile on submit and triggers onRefresh and onClose", async () => {
            mockRenameFile.mockResolvedValueOnce({ success: true, data: { id: "file-1", title: "updated-spec.md" } });

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-1"
                    fileName="initial-spec.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            // Click rename button to switch to input mode
            fireEvent.click(screen.getByText("إعادة التسمية"));

            const input = screen.getByDisplayValue("initial-spec.md");
            expect(input).toBeDefined();

            // Type new name and press Enter
            fireEvent.change(input, { target: { value: "updated-spec.md" } });
            fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

            await waitFor(() => {
                expect(mockRenameFile).toHaveBeenCalledWith("file-1", "updated-spec.md");
            });

            expect(mockOnRefresh).toHaveBeenCalledTimes(1);
            expect(mockOnClose).toHaveBeenCalledTimes(1);
        });

        it("cancels rename on Escape key without invoking RPC renameFile", () => {
            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-1"
                    fileName="initial-spec.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("إعادة التسمية"));
            const input = screen.getByDisplayValue("initial-spec.md");

            fireEvent.change(input, { target: { value: "aborted-name.md" } });
            fireEvent.keyDown(input, { key: "Escape", code: "Escape" });

            expect(mockRenameFile).not.toHaveBeenCalled();
            expect(mockOnRefresh).not.toHaveBeenCalled();
            // Switched back to button view
            expect(screen.getByText("إعادة التسمية")).toBeDefined();
        });

        it("alerts user on RPC rename failure and does not trigger onRefresh", async () => {
            mockRenameFile.mockResolvedValueOnce({ success: false, error: "Database lock contention" });

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-1"
                    fileName="initial-spec.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("إعادة التسمية"));
            const input = screen.getByDisplayValue("initial-spec.md");
            fireEvent.change(input, { target: { value: "collision-name.md" } });
            fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

            await waitFor(() => {
                expect(window.alert).toHaveBeenCalledWith("Database lock contention");
            });

            expect(mockOnRefresh).not.toHaveBeenCalled();
            expect(mockOnClose).not.toHaveBeenCalled();
        });
    });

    describe("2. Delete File / Folder Operation", () => {
        it("prompts confirmation and invokes RPC deleteFile when confirmed", async () => {
            mockDeleteFile.mockResolvedValueOnce({ success: true });

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-to-delete"
                    fileName="obsolete.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("حذف"));

            expect(window.confirm).toHaveBeenCalledWith("Are you sure you want to delete this file?");

            await waitFor(() => {
                expect(mockDeleteFile).toHaveBeenCalledWith("file-to-delete");
            });

            expect(mockOnRefresh).toHaveBeenCalledTimes(1);
            expect(mockOnClose).toHaveBeenCalledTimes(1);
        });

        it("bypasses RPC deleteFile when user declines the confirmation prompt", () => {
            vi.spyOn(window, "confirm").mockReturnValueOnce(false);

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-to-keep"
                    fileName="important.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("حذف"));

            expect(window.confirm).toHaveBeenCalledTimes(1);
            expect(mockDeleteFile).not.toHaveBeenCalled();
            expect(mockOnRefresh).not.toHaveBeenCalled();
        });

        it("alerts error when RPC deleteFile returns failure", async () => {
            mockDeleteFile.mockResolvedValueOnce({ success: false, error: "Permission denied" });

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-protected"
                    fileName="system.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("حذف"));

            await waitFor(() => {
                expect(window.alert).toHaveBeenCalledWith("Permission denied");
            });

            expect(mockOnRefresh).not.toHaveBeenCalled();
        });
    });

    describe("3. Restore Tombstoned Item", () => {
        it("renders restore button for deleted files and invokes RPC restoreFile", async () => {
            mockRestoreFile.mockResolvedValueOnce({ success: true });

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-deleted-id"
                    fileName="recycled.md"
                    isFolder={false}
                    isDeleted={true}
                    onRefresh={mockOnRefresh}
                />
            );

            // "حذف" should not be visible when isDeleted is true
            expect(screen.queryByText("حذف")).toBeNull();

            // "استعادة" button must be visible
            const restoreBtn = screen.getByText("استعادة");
            expect(restoreBtn).toBeDefined();

            fireEvent.click(restoreBtn);

            await waitFor(() => {
                expect(mockRestoreFile).toHaveBeenCalledWith("file-deleted-id");
            });

            expect(mockOnRefresh).toHaveBeenCalledTimes(1);
            expect(mockOnClose).toHaveBeenCalledTimes(1);
        });
    });

    describe("4. Copy & Move Integration via RPC Client", () => {
        it("opens folder picker on Copy and dispatches RPC copyFile on destination selection", async () => {
            mockCopyFile.mockResolvedValueOnce({ success: true });

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-to-copy"
                    fileName="original.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("نسخ"));

            // FolderPickerModal opened
            await waitFor(() => {
                expect(screen.getByText('نسخ "original.md" إلى...')).toBeDefined();
            });

            // Select Root (null)
            fireEvent.click(screen.getByText("Root (No folder)"));

            await waitFor(() => {
                expect(mockCopyFile).toHaveBeenCalledWith("file-to-copy", null);
            });

            expect(mockOnRefresh).toHaveBeenCalledTimes(1);
            expect(mockOnClose).toHaveBeenCalledTimes(1);
        });

        it("opens folder picker on Move and dispatches RPC moveFile on destination selection", async () => {
            mockMoveFile.mockResolvedValueOnce({ success: true });

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-to-move"
                    fileName="movable.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("نقل"));

            // FolderPickerModal opened
            await waitFor(() => {
                expect(screen.getByText('نقل "movable.md" إلى...')).toBeDefined();
            });

            // Select Root (null)
            fireEvent.click(screen.getByText("Root (No folder)"));

            await waitFor(() => {
                expect(mockMoveFile).toHaveBeenCalledWith("file-to-move", null);
            });

            expect(mockOnRefresh).toHaveBeenCalledTimes(1);
            expect(mockOnClose).toHaveBeenCalledTimes(1);
        });
    });

    describe("5. RPC Rejection & Failure Resilience", () => {
        it("handles renameFile RPC rejection gracefully with alert and without crashing", async () => {
            mockRenameFile.mockRejectedValueOnce(new Error("Network connection dropped"));

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-rejection"
                    fileName="old.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("إعادة التسمية"));
            const input = screen.getByDisplayValue("old.md");
            fireEvent.change(input, { target: { value: "failed-rename.md" } });
            fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

            await waitFor(() => {
                expect(window.alert).toHaveBeenCalledWith("Failed to rename: Network connection dropped");
            });

            expect(mockOnRefresh).not.toHaveBeenCalled();
            expect(mockOnClose).not.toHaveBeenCalled();
        });

        it("handles deleteFile RPC rejection gracefully with alert and without crashing", async () => {
            mockDeleteFile.mockRejectedValueOnce(new Error("Timeout waiting for server response"));

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-del-reject"
                    fileName="doomed.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("حذف"));

            await waitFor(() => {
                expect(window.alert).toHaveBeenCalledWith("Failed to delete: Timeout waiting for server response");
            });

            expect(mockOnRefresh).not.toHaveBeenCalled();
            expect(mockOnClose).not.toHaveBeenCalled();
        });

        it("handles restoreFile RPC rejection gracefully with alert and without crashing", async () => {
            mockRestoreFile.mockRejectedValueOnce(new Error("Transaction aborted"));

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-restore-reject"
                    fileName="recycled.md"
                    isFolder={false}
                    isDeleted={true}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("استعادة"));

            await waitFor(() => {
                expect(window.alert).toHaveBeenCalledWith("Failed to restore: Transaction aborted");
            });

            expect(mockOnRefresh).not.toHaveBeenCalled();
            expect(mockOnClose).not.toHaveBeenCalled();
        });

        it("handles copyFile RPC rejection gracefully with alert and without crashing", async () => {
            mockCopyFile.mockRejectedValueOnce(new Error("Storage quota exceeded"));

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-copy-reject"
                    fileName="sample.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("نسخ"));

            await waitFor(() => {
                expect(screen.getByText('نسخ "sample.md" إلى...')).toBeDefined();
            });

            fireEvent.click(screen.getByText("Root (No folder)"));

            await waitFor(() => {
                expect(window.alert).toHaveBeenCalledWith("Failed to copy: Storage quota exceeded");
            });

            expect(mockOnRefresh).not.toHaveBeenCalled();
            expect(mockOnClose).not.toHaveBeenCalled();
        });

        it("handles moveFile RPC rejection gracefully with alert and without crashing", async () => {
            mockMoveFile.mockRejectedValueOnce(new Error("Hierarchy cycle constraint"));

            render(
                <FileContextMenu
                    isOpen={true}
                    onClose={mockOnClose}
                    fileId="file-move-reject"
                    fileName="sample.md"
                    isFolder={false}
                    onRefresh={mockOnRefresh}
                />
            );

            fireEvent.click(screen.getByText("نقل"));

            await waitFor(() => {
                expect(screen.getByText('نقل "sample.md" إلى...')).toBeDefined();
            });

            fireEvent.click(screen.getByText("Root (No folder)"));

            await waitFor(() => {
                expect(window.alert).toHaveBeenCalledWith("Failed to move: Hierarchy cycle constraint");
            });

            expect(mockOnRefresh).not.toHaveBeenCalled();
            expect(mockOnClose).not.toHaveBeenCalled();
        });
    });
});
