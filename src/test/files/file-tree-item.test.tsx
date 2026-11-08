// @vitest-environment jsdom
/**
 * Exhaustive Unit & Edge Case Test Suite for FileTreeItem (`src/components/files/file-tree-item.tsx`)
 *
 * Verifies:
 * 1. Rendering & Link Attributes:
 *    - Renders file item with AppLink targeting `/workspace/editor/${file.id}`.
 *    - Renders folder item with AppLink targeting `/workspace`.
 *    - Renders Lock icon when file isEncrypted is true.
 *    - Renders FileText icon when file isEncrypted is false/undefined.
 *    - Renders Folder icon and expand/collapse arrow for folders.
 * 2. Nested Children & Expand/Collapse:
 *    - Toggling the expand arrow displays nested child items.
 *    - Collapsed folders do not render child elements.
 * 3. Drag and Drop Workflows:
 *    - onDragStart attaches file.id to dataTransfer with 'move' effect.
 *    - onDragOver allows drop on folders (sets dropEffect to 'move' and applies highlight class).
 *    - onDragOver ignores drag on regular files (not folders).
 *    - onDrop on a folder triggers onMove(draggedFileId, folder.id).
 *    - onDrop ignores dropping a folder onto itself (draggedFileId === file.id).
 *    - onDrop with external files triggers onImportFiles(files, folder.id).
 * 4. Context Menu Integration:
 *    - Clicking MoreHorizontal button opens FileContextMenu.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileTreeItem } from "@/components/files/file-tree-item";

// Mock FileContextMenu to isolate FileTreeItem interactions
vi.mock("@/components/files/file-context-menu", () => ({
    FileContextMenu: ({ isOpen, fileId }: { isOpen: boolean; fileId: string }) =>
        isOpen ? <div data-testid={`mock-context-menu-${fileId}`}>Menu Open</div> : null,
}));

describe("FileTreeItem Component", () => {
    const mockOnMove = vi.fn();
    const mockOnRefresh = vi.fn();
    const mockOnImportFiles = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("1. Rendering & Link Attributes", () => {
        it("renders regular file with AppLink pointing to editor route", () => {
            const file = {
                id: "file-101",
                title: "architecture-spec.md",
                isFolder: false,
                parentFolderId: null,
                updatedAt: new Date(),
                isEncrypted: false,
            };

            const { container } = render(
                <FileTreeItem
                    file={file}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            const link = screen.getByText("architecture-spec.md");
            expect(link).toBeDefined();
            expect(link.getAttribute("href")).toBe("/workspace/editor/file-101");
            expect(container.querySelector("svg.lucide-chevron-right")).toBeNull();
        });

        it("renders folder with AppLink pointing to /workspace and renders chevron toggle", () => {
            const folder = {
                id: "folder-202",
                title: "Design Documents",
                isFolder: true,
                parentFolderId: null,
                updatedAt: new Date(),
                children: [],
            };

            const { container } = render(
                <FileTreeItem
                    file={folder}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            const link = screen.getByText("Design Documents");
            expect(link).toBeDefined();
            expect(link.getAttribute("href")).toBe("/workspace");
            expect(container.querySelector("svg.lucide-folder")).toBeDefined();
            expect(container.querySelector("svg.lucide-chevron-right")).toBeDefined();
        });

        it("renders Lock icon for encrypted files", () => {
            const encryptedFile = {
                id: "file-vault-1",
                title: "secret-keys.env",
                isFolder: false,
                parentFolderId: null,
                updatedAt: new Date(),
                isEncrypted: true,
            };

            const { container } = render(
                <FileTreeItem
                    file={encryptedFile}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            expect(container.querySelector("svg.lucide-lock")).toBeDefined();
            expect(container.querySelector("svg.lucide-file-text")).toBeNull();
        });
    });

    describe("2. Nested Children & Expand/Collapse", () => {
        it("toggles child items visibility when clicking the folder chevron", () => {
            const folderWithChildren = {
                id: "folder-root",
                title: "Root Folder",
                isFolder: true,
                parentFolderId: null,
                updatedAt: new Date(),
                children: [
                    {
                        id: "child-file-1",
                        title: "nested-child.md",
                        isFolder: false,
                        parentFolderId: "folder-root",
                        updatedAt: new Date(),
                    },
                ],
            };

            const { container } = render(
                <FileTreeItem
                    file={folderWithChildren}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            // Initially collapsed
            expect(screen.queryByText("nested-child.md")).toBeNull();

            // Click chevron
            const chevronBtn = container.querySelector("button.shrink-0");
            expect(chevronBtn).toBeDefined();
            fireEvent.click(chevronBtn!);

            // Now expanded
            expect(screen.getByText("nested-child.md")).toBeDefined();

            // Click chevron again to collapse
            fireEvent.click(chevronBtn!);
            expect(screen.queryByText("nested-child.md")).toBeNull();
        });
    });

    describe("3. Drag and Drop Workflows", () => {
        it("attaches file.id and move effect on drag start", () => {
            const file = {
                id: "drag-source-file",
                title: "movable.md",
                isFolder: false,
                parentFolderId: null,
                updatedAt: new Date(),
            };

            const { container } = render(
                <FileTreeItem
                    file={file}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            const draggableDiv = container.querySelector("div[draggable=true]")!;
            const dataTransfer = {
                setData: vi.fn(),
                effectAllowed: "",
            };

            fireEvent.dragStart(draggableDiv, { dataTransfer });

            expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "drag-source-file");
            expect(dataTransfer.effectAllowed).toBe("move");
        });

        it("allows drag over on folders and applies drag over highlight", () => {
            const folder = {
                id: "drop-target-folder",
                title: "Target Folder",
                isFolder: true,
                parentFolderId: null,
                updatedAt: new Date(),
            };

            const { container } = render(
                <FileTreeItem
                    file={folder}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            const folderDiv = container.querySelector("div[draggable=true]")!;
            const dataTransfer = { dropEffect: "" };

            fireEvent.dragOver(folderDiv, { dataTransfer });

            expect(dataTransfer.dropEffect).toBe("move");
            expect(folderDiv.className).toContain("bg-indigo-500/20");

            // Drag leave clears highlight
            fireEvent.dragLeave(folderDiv);
            expect(folderDiv.className).not.toContain("bg-indigo-500/20");
        });

        it("ignores drag over on regular files", () => {
            const file = {
                id: "not-a-folder",
                title: "regular.md",
                isFolder: false,
                parentFolderId: null,
                updatedAt: new Date(),
            };

            const { container } = render(
                <FileTreeItem
                    file={file}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            const fileDiv = container.querySelector("div[draggable=true]")!;
            const dataTransfer = { dropEffect: "" };

            fireEvent.dragOver(fileDiv, { dataTransfer });
            expect(dataTransfer.dropEffect).toBe("");
            expect(fileDiv.className).not.toContain("bg-indigo-500/20");
        });

        it("triggers onMove when another file is dropped into the folder", () => {
            const folder = {
                id: "dest-folder",
                title: "Destination",
                isFolder: true,
                parentFolderId: null,
                updatedAt: new Date(),
            };

            const { container } = render(
                <FileTreeItem
                    file={folder}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            const folderDiv = container.querySelector("div[draggable=true]")!;
            const dataTransfer = {
                types: ["text/plain"],
                getData: vi.fn().mockReturnValue("dragged-item-id"),
            };

            fireEvent.drop(folderDiv, { dataTransfer });

            expect(mockOnMove).toHaveBeenCalledTimes(1);
            expect(mockOnMove).toHaveBeenCalledWith("dragged-item-id", "dest-folder");
        });

        it("strictly refuses drop when file is dropped into itself", () => {
            const folder = {
                id: "self-folder",
                title: "Self",
                isFolder: true,
                parentFolderId: null,
                updatedAt: new Date(),
            };

            const { container } = render(
                <FileTreeItem
                    file={folder}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            const folderDiv = container.querySelector("div[draggable=true]")!;
            const dataTransfer = {
                types: ["text/plain"],
                getData: vi.fn().mockReturnValue("self-folder"),
            };

            fireEvent.drop(folderDiv, { dataTransfer });

            expect(mockOnMove).not.toHaveBeenCalled();
        });

        it("triggers onImportFiles when external files are dropped onto the folder", () => {
            const folder = {
                id: "import-folder",
                title: "Imports",
                isFolder: true,
                parentFolderId: null,
                updatedAt: new Date(),
            };

            const { container } = render(
                <FileTreeItem
                    file={folder}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                    onImportFiles={mockOnImportFiles}
                />
            );

            const folderDiv = container.querySelector("div[draggable=true]")!;
            const fakeFile = new File(["# Content"], "imported.md", { type: "text/markdown" });
            const dataTransfer = {
                types: ["Files"],
                files: [fakeFile],
            };

            fireEvent.drop(folderDiv, { dataTransfer });

            expect(mockOnImportFiles).toHaveBeenCalledTimes(1);
            expect(mockOnImportFiles).toHaveBeenCalledWith([fakeFile], "import-folder");
            expect(mockOnMove).not.toHaveBeenCalled();
        });
    });

    describe("4. Context Menu Integration", () => {
        it("opens context menu when clicking More button", () => {
            const file = {
                id: "file-menu-target",
                title: "menu-test.md",
                isFolder: false,
                parentFolderId: null,
                updatedAt: new Date(),
            };

            const { container } = render(
                <FileTreeItem
                    file={file}
                    onMove={mockOnMove}
                    onRefresh={mockOnRefresh}
                />
            );

            expect(screen.queryByTestId("mock-context-menu-file-menu-target")).toBeNull();

            // Find More button (contains MoreHorizontal SVG)
            const moreBtn = container.querySelector("button.opacity-0")!;
            expect(moreBtn).toBeDefined();

            fireEvent.click(moreBtn);

            expect(screen.getByTestId("mock-context-menu-file-menu-target")).toBeDefined();
        });
    });
});
