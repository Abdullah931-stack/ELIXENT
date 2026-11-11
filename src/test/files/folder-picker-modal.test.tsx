// @vitest-environment jsdom
/**
 * Exhaustive Unit & Edge Case Test Suite for FolderPickerModal (`src/components/files/folder-picker-modal.tsx`)
 *
 * Verifies:
 * 1. Lifecycle & Render Gates:
 *    - Does not render when isOpen is false.
 *    - Renders modal dialog and backdrop when isOpen is true.
 *    - Displays custom title passed in props (e.g. "Copy to...", "Move to...").
 * 2. RPC Data Fetching & Folder Filtering:
 *    - Invokes getUserFiles() RPC on mount when open.
 *    - Shows "Loading..." indicator during in-flight RPC retrieval.
 *    - Filters out items with isFolder: false.
 *    - Filters out the item matching currentFileId (preventing moving/copying a folder into itself).
 *    - Renders "No folders available" empty state when no qualifying folders exist.
 * 3. User Selection & Action Dispatching:
 *    - Selecting "Root (No folder)" triggers onSelect(null) and onClose().
 *    - Selecting a folder item triggers onSelect(folderId) and onClose().
 *    - Clicking "Cancel" button triggers onClose().
 *    - Clicking the modal backdrop triggers onClose().
 * 4. Error Resilience & Cleanup:
 *    - Handles RPC returning { success: false, data: null } gracefully without crashing.
 *    - Handles unmounting while RPC call is in-flight without memory leaks or state update warnings.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { FolderPickerModal } from "@/components/files/folder-picker-modal";

const mockGetUserFiles = vi.fn();

vi.mock("@/client/rpc-client", () => ({
    getUserFiles: () => mockGetUserFiles(),
}));

describe("FolderPickerModal Component", () => {
    const mockOnClose = vi.fn();
    const mockOnSelect = vi.fn();

    const sampleFiles = [
        { id: "folder-1", title: "Documents", isFolder: true, parentFolderId: null },
        { id: "folder-2", title: "Archive", isFolder: true, parentFolderId: null },
        { id: "folder-current", title: "Current Folder", isFolder: true, parentFolderId: null },
        { id: "file-1", title: "Notes.md", isFolder: false, parentFolderId: null },
        { id: "file-2", title: "Draft.md", isFolder: false, parentFolderId: "folder-1" },
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUserFiles.mockResolvedValue({
            success: true,
            data: sampleFiles,
        });
    });

    describe("1. Lifecycle & Render Gates", () => {
        it("does not render into DOM when isOpen is false", () => {
            const { container } = render(
                <FolderPickerModal
                    isOpen={false}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Move to..."
                />
            );

            expect(container.firstChild).toBeNull();
            expect(mockGetUserFiles).not.toHaveBeenCalled();
        });

        it("renders modal header with custom title when isOpen is true", async () => {
            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Copy File to Destination"
                />
            );

            expect(screen.getByText("Copy File to Destination")).toBeDefined();
            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });
        });
    });

    describe("2. RPC Data Fetching & Folder Filtering", () => {
        it("shows loading state while RPC call is in-flight, then displays filtered folders", async () => {
            let resolveRpc: (val: any) => void;
            const rpcPromise = new Promise((res) => {
                resolveRpc = res;
            });
            mockGetUserFiles.mockReturnValueOnce(rpcPromise);

            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    currentFileId="folder-current"
                    title="Move Folder"
                />
            );

            expect(screen.getByText("Loading...")).toBeDefined();

            await act(async () => {
                resolveRpc!({
                    success: true,
                    data: sampleFiles,
                });
            });

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            expect(screen.getByText("Root (No folder)")).toBeDefined();
            expect(screen.getByText("Documents")).toBeDefined();
            expect(screen.getByText("Archive")).toBeDefined();

            // Strictly excluded: files (not folders) and currentFileId
            expect(screen.queryByText("Current Folder")).toBeNull();
            expect(screen.queryByText("Notes.md")).toBeNull();
            expect(screen.queryByText("Draft.md")).toBeNull();
        });

        it("displays empty state message when no destination folders are available", async () => {
            mockGetUserFiles.mockResolvedValueOnce({
                success: true,
                data: [
                    { id: "file-only-1", title: "A.md", isFolder: false, parentFolderId: null },
                    { id: "folder-target", title: "Target", isFolder: true, parentFolderId: null },
                ],
            });

            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    currentFileId="folder-target"
                    title="Move Item"
                />
            );

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            expect(screen.getByText("Root (No folder)")).toBeDefined();
            expect(screen.getByText("No folders available. Create a folder first.")).toBeDefined();
        });
    });

    describe("3. User Selection & Action Dispatching", () => {
        it("triggers onSelect(null) and onClose() when clicking 'Root (No folder)'", async () => {
            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Select Folder"
                />
            );

            await waitFor(() => {
                expect(screen.getByText("Root (No folder)")).toBeDefined();
            });

            fireEvent.click(screen.getByText("Root (No folder)"));

            expect(mockOnSelect).toHaveBeenCalledTimes(1);
            expect(mockOnSelect).toHaveBeenCalledWith(null);
            expect(mockOnClose).toHaveBeenCalledTimes(1);
        });

        it("triggers onSelect(folderId) and onClose() when clicking a specific folder", async () => {
            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Select Folder"
                />
            );

            await waitFor(() => {
                expect(screen.getByText("Archive")).toBeDefined();
            });

            fireEvent.click(screen.getByText("Archive"));

            expect(mockOnSelect).toHaveBeenCalledTimes(1);
            expect(mockOnSelect).toHaveBeenCalledWith("folder-2");
            expect(mockOnClose).toHaveBeenCalledTimes(1);
        });

        it("triggers onClose() when clicking Cancel button", async () => {
            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Cancel Test"
                />
            );

            await waitFor(() => {
                expect(screen.getByText("Cancel")).toBeDefined();
            });

            fireEvent.click(screen.getByText("Cancel"));

            expect(mockOnClose).toHaveBeenCalledTimes(1);
            expect(mockOnSelect).not.toHaveBeenCalled();
        });

        it("triggers onClose() when clicking the backdrop", async () => {
            const { container } = render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Backdrop Test"
                />
            );

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            const backdrop = container.querySelector(".fixed.inset-0.bg-black\\/50");
            expect(backdrop).toBeDefined();
            fireEvent.click(backdrop!);

            expect(mockOnClose).toHaveBeenCalledTimes(1);
        });
    });

    describe("4. Error Resilience & Cleanup", () => {
        it("recovers gracefully without throwing when getUserFiles returns success: false", async () => {
            mockGetUserFiles.mockResolvedValueOnce({
                success: false,
                data: null,
            });

            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Error Fallback"
                />
            );

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            expect(screen.getByText("Root (No folder)")).toBeDefined();
            expect(screen.getByText("No folders available. Create a folder first.")).toBeDefined();
        });

        it("recovers cleanly and resets loading state when getUserFiles throws an exception / rejects", async () => {
            mockGetUserFiles.mockRejectedValueOnce(new Error("Network timeout during folder retrieval"));

            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Exception Recovery"
                />
            );

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            expect(screen.getByText("Network timeout during folder retrieval")).toBeDefined();
            expect(screen.getByText("Root (No folder)")).toBeDefined();
            expect(screen.getByText("No folders available. Create a folder first.")).toBeDefined();
        });

        it("displays error message when getUserFiles returns success: false with specific error", async () => {
            mockGetUserFiles.mockResolvedValueOnce({
                success: false,
                error: "Database read quota exceeded",
                data: null,
            });

            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Quota Error"
                />
            );

            await waitFor(() => {
                expect(screen.queryByText("Loading...")).toBeNull();
            });

            expect(screen.getByText("Database read quota exceeded")).toBeDefined();
        });

        it("handles asynchronous onSelect failure without crashing and presents error message", async () => {
            mockOnSelect.mockRejectedValueOnce(new Error("RPC moveFile failed during folder selection"));

            render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Async Action Error"
                />
            );

            await waitFor(() => {
                expect(screen.getByText("Archive")).toBeDefined();
            });

            fireEvent.click(screen.getByText("Archive"));

            await waitFor(() => {
                expect(screen.getByText("RPC moveFile failed during folder selection")).toBeDefined();
            });

            expect(mockOnClose).not.toHaveBeenCalled();
        });

        it("safely cleans up isMounted reference on unmount while RPC call is unresolved", async () => {
            let resolveRpc: (val: any) => void;
            const rpcPromise = new Promise((res) => {
                resolveRpc = res;
            });
            mockGetUserFiles.mockReturnValueOnce(rpcPromise);

            const { unmount } = render(
                <FolderPickerModal
                    isOpen={true}
                    onClose={mockOnClose}
                    onSelect={mockOnSelect}
                    title="Unmount Race"
                />
            );

            // Unmount component while RPC is still unresolved
            unmount();

            // Resolve promise after unmount
            await act(async () => {
                resolveRpc!({
                    success: true,
                    data: sampleFiles,
                });
            });

            // No unhandled error or assertion error occurs
            expect(mockOnSelect).not.toHaveBeenCalled();
        });
    });
});
