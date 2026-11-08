/**
 * Editor Formatting & Architectural Agent Toolbar
 *
 * Provides document history (undo/redo), Markdown formatting controls,
 * Architectural Agent Panel toggle, Multi-Hunk Ghost batch review actions
 * (Accept All / Reject All), Zero-Knowledge Vault AI shield indicators,
 * and mode/direction/export utilities.
 */

import { ExportButton } from "@/components/editor/export-button";
import { DirectionMenu } from "@/components/editor/direction-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  EditorMode,
  DirectionSettings,
} from "@/components/editor/markdown/types";
import {
  Undo2,
  Redo2,
  Copy,
  Search,
  Check,
  Sparkles,
  Square,
  Bold,
  Italic,
  Code,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Link,
  Eye,
  FileCode,
  Lock,
  Bot,
  X,
  ShieldCheck,
  WifiOff,
} from "lucide-react";

export interface AIToolbarProps {
  /** Toggles the Architectural Agent Chat Panel */
  onToggleAgentPanel?: () => void;
  /** Whether the Architectural Agent Chat Panel is currently open */
  isAgentPanelOpen?: boolean;
  /** Count of active Multi-Hunk Ghost previews awaiting user review */
  activeGhostHunksCount?: number;
  /** Accepts all remaining Multi-Hunk Ghost previews in a single transaction */
  onAcceptAllGhostHunks?: () => void;
  /** Rejects and clears all remaining Multi-Hunk Ghost previews */
  onRejectAllGhostHunks?: () => void;

  /** Document history & utility callbacks */
  onUndo?: () => void;
  onRedo?: () => void;
  onExport?: (format: "md" | "txt") => void;
  onCopy?: () => void;
  onSearch?: () => void;
  onStop?: () => void;
  onFormat?: (prefix: string, suffix?: string, placeholder?: string) => void;
  mode?: EditorMode;
  onToggleMode?: () => void;
  directionSettings?: DirectionSettings;
  onDirectionSettingsChange?: (settings: Partial<DirectionSettings>) => void;
  canUndo?: boolean;
  canRedo?: boolean;

  /** Streaming & lock state flags */
  isLoading?: boolean;
  isStreaming?: boolean;
  isWriteLocked?: boolean;
  isOffline?: boolean;

  /** Zero-Knowledge Vault & AI privacy controls */
  isEncrypted?: boolean;
  isVaultUnlocked?: boolean;
  allowAIOnEncryptedFiles?: boolean;
  allowAIOnEncrypted?: boolean;
  onToggleAllowAI?: (allow: boolean) => void;

  /** Optional legacy callback props retained for caller compatibility */
  onCorrect?: () => void;
  onImprove?: () => void;
  onSummarize?: () => void;
  onTranslate?: () => void;
  onToPrompt?: () => void;
  showToPrompt?: boolean;

  className?: string;
}

export function AIToolbar({
  onToggleAgentPanel,
  isAgentPanelOpen = false,
  activeGhostHunksCount = 0,
  onAcceptAllGhostHunks,
  onRejectAllGhostHunks,
  onUndo,
  onRedo,
  onExport,
  onCopy,
  onSearch,
  onStop,
  onFormat,
  mode = "live",
  onToggleMode,
  directionSettings,
  onDirectionSettingsChange,
  canUndo = false,
  canRedo = false,
  isLoading = false,
  isStreaming = false,
  isWriteLocked = false,
  isOffline = false,
  isEncrypted = false,
  isVaultUnlocked = true,
  allowAIOnEncryptedFiles,
  allowAIOnEncrypted,
  onToggleAllowAI,
  className,
}: AIToolbarProps) {
  const effectiveAllowAI =
    allowAIOnEncryptedFiles ?? allowAIOnEncrypted ?? false;
  const isBusy = isLoading || isStreaming;
  const hasGhostHunks = (activeGhostHunksCount ?? 0) > 0;
  const isVaultShieldBlocking = isEncrypted && !effectiveAllowAI;
  const isVaultLockedBlocking =
    isEncrypted && effectiveAllowAI && !isVaultUnlocked;

  return (
    <div
      data-testid="ai-toolbar"
      className={cn(
        "flex items-center gap-1 p-2 border-b border-zinc-800/50 bg-zinc-900/30 overflow-x-auto custom-scrollbar",
        className
      )}
    >
      <div className="flex items-center gap-1 pr-2 border-r border-zinc-800/50 flex-shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onUndo}
          disabled={!canUndo || isBusy}
          title="Undo (Ctrl+Z)"
          data-testid="toolbar-undo-button"
        >
          <Undo2 className="w-4 h-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRedo}
          disabled={!canRedo || isBusy}
          title="Redo (Ctrl+Y)"
          data-testid="toolbar-redo-button"
        >
          <Redo2 className="w-4 h-4" />
        </Button>
      </div>

      {onFormat && (
        <div className="flex items-center gap-1 px-2 border-r border-zinc-800/50 flex-shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onFormat("# ", "", "Heading 1")}
            disabled={isBusy}
            title="Heading 1 (H1)"
          >
            <Heading1 className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onFormat("## ", "", "Heading 2")}
            disabled={isBusy}
            title="Heading 2 (H2)"
          >
            <Heading2 className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onFormat("**", "**", "bold text")}
            disabled={isBusy}
            title="Bold"
          >
            <Bold className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onFormat("*", "*", "italic text")}
            disabled={isBusy}
            title="Italic"
          >
            <Italic className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onFormat("`", "`", "code")}
            disabled={isBusy}
            title="Inline Code"
          >
            <Code className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onFormat("- ", "", "list item")}
            disabled={isBusy}
            title="Bullet List"
          >
            <List className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onFormat("1. ", "", "list item")}
            disabled={isBusy}
            title="Numbered List"
          >
            <ListOrdered className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onFormat("> ", "", "quote")}
            disabled={isBusy}
            title="Blockquote"
          >
            <Quote className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onFormat("[", "](https://)", "link text")}
            disabled={isBusy}
            title="Insert Link"
          >
            <Link className="w-4 h-4" />
          </Button>
        </div>
      )}

      <div className="flex items-center gap-1.5 px-2 border-r border-zinc-800/50 flex-shrink-0">
        <Button
          type="button"
          variant="ai"
          size="sm"
          onClick={onToggleAgentPanel}
          aria-pressed={isAgentPanelOpen}
          data-testid="ai-toolbar-agent-toggle"
          title={
            isAgentPanelOpen
              ? "Close Architectural Agent Panel"
              : "Open Architectural Agent Panel"
          }
          className={cn(
            "gap-1.5",
            isAgentPanelOpen &&
              "bg-indigo-600/25 border-indigo-400 text-indigo-100 shadow-[0_0_15px_rgba(99,102,241,0.35)]"
          )}
        >
          <Bot className="w-4 h-4 text-indigo-400" />
          <span>Architectural Agent</span>
          <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
        </Button>

        {hasGhostHunks && (
          <div
            data-testid="ai-toolbar-ghost-actions"
            className="flex items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-950/30 px-2 py-0.5"
          >
            <span
              data-testid="ai-toolbar-ghost-count"
              className="inline-flex items-center rounded-full bg-indigo-500/20 px-2 py-0.5 font-mono text-[11px] font-semibold text-indigo-200"
            >
              {activeGhostHunksCount}{" "}
              {activeGhostHunksCount === 1 ? "hunk" : "hunks"}
            </span>
            {onAcceptAllGhostHunks && (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={onAcceptAllGhostHunks}
                disabled={isBusy}
                data-testid="ai-toolbar-accept-all"
                title="Accept All Ghost Hunks"
                className="h-7 px-2.5 text-xs gap-1"
              >
                <Check className="w-3.5 h-3.5" />
                <span>Accept All</span>
              </Button>
            )}
            {onRejectAllGhostHunks && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onRejectAllGhostHunks}
                disabled={isBusy}
                data-testid="ai-toolbar-reject-all"
                title="Reject All Ghost Hunks"
                className="h-7 px-2.5 text-xs gap-1"
              >
                <X className="w-3.5 h-3.5" />
                <span>Reject All</span>
              </Button>
            )}
          </div>
        )}

        {isBusy && onStop && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="gap-1.5 animate-pulse bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30"
            onClick={onStop}
            title="Stop Agent Stream (Esc)"
            data-testid="ai-toolbar-stop-button"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
            <span>Stop</span>
          </Button>
        )}

        {isVaultShieldBlocking && (
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/25 text-amber-300 text-xs font-medium"
            title="AI features are disabled on encrypted files by Zero-Knowledge Vault policy"
            data-testid="ai-encrypted-badge"
          >
            <Lock className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">
              AI Shield Active (Encrypted)
            </span>
            <span className="sm:hidden">Encrypted</span>
            {onToggleAllowAI && (
              <button
                type="button"
                onClick={() => onToggleAllowAI(true)}
                data-testid="ai-vault-shield-toggle"
                className="ml-1 underline text-amber-200 hover:text-white text-[11px]"
              >
                Allow AI
              </button>
            )}
          </div>
        )}

        {isEncrypted && effectiveAllowAI && (
          <div className="flex items-center gap-1.5">
            {isVaultLockedBlocking ? (
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-500/10 border border-indigo-500/25 text-indigo-300 text-xs font-medium"
                title="Unlock the Zero-Knowledge Vault to run AI on this encrypted document"
                data-testid="ai-vault-locked-badge"
              >
                <Lock className="w-3.5 h-3.5 text-indigo-400" />
                <span>Vault Locked</span>
              </div>
            ) : (
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-xs font-medium"
                title="Ephemeral Zero-Knowledge AI access is enabled for this encrypted document"
                data-testid="ai-vault-opted-in-badge"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span className="hidden sm:inline">ZK AI Enabled</span>
              </div>
            )}
            {onToggleAllowAI && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onToggleAllowAI(false)}
                data-testid="ai-vault-shield-toggle"
                title="Disable AI on Encrypted Files"
                className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-200"
              >
                Shield
              </Button>
            )}
          </div>
        )}

        {isWriteLocked && (
          <span
            data-testid="ai-toolbar-write-lock-badge"
            className="inline-flex items-center gap-1 rounded-md bg-zinc-800/80 border border-zinc-700 px-2 py-0.5 text-[11px] font-mono text-zinc-300"
            title="Auto-save is suspended while an AI operation is active"
          >
            <Lock className="w-3 h-3 text-indigo-400" />
            <span>Write-Locked</span>
          </span>
        )}

        {isOffline && (
          <span
            data-testid="ai-toolbar-offline-badge"
            className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 text-[11px] font-medium text-amber-300"
            title="Offline mode active"
          >
            <WifiOff className="w-3 h-3 text-amber-400" />
            <span>Offline</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 ml-auto flex-shrink-0">
        {directionSettings && onDirectionSettingsChange && (
          <DirectionMenu
            settings={directionSettings}
            onSettingsChange={onDirectionSettingsChange}
            disabled={isBusy}
          />
        )}
        {onToggleMode && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "gap-1.5 text-xs font-mono",
              mode === "source" &&
                "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
            )}
            onClick={onToggleMode}
            disabled={isBusy}
            title={
              mode === "live"
                ? "Switch to Raw Markdown Source Mode"
                : "Switch to Live Preview Mode"
            }
          >
            {mode === "live" ? (
              <>
                <Eye className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Live</span>
              </>
            ) : (
              <>
                <FileCode className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Source</span>
              </>
            )}
          </Button>
        )}
        {onCopy && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={onCopy}
            disabled={isBusy}
            title="Copy Raw Markdown"
          >
            <Copy className="w-4 h-4" />
            <span className="hidden sm:inline">Copy</span>
          </Button>
        )}
        {onSearch && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={onSearch}
            disabled={isBusy}
            title="Search and Replace (Ctrl+F)"
          >
            <Search className="w-4 h-4" />
            <span className="hidden sm:inline">Search</span>
          </Button>
        )}
        {onExport && <ExportButton onExport={onExport} disabled={isBusy} />}
      </div>
    </div>
  );
}
