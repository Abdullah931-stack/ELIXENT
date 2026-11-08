import React from 'react';
import type { AIStreamStatus as AIStreamSessionStatus } from '@/lib/ai/stream-session';
import { Loader2, AlertCircle, RefreshCw, XCircle, CheckCircle2, GitBranch, Square } from 'lucide-react';

export interface AIStreamStatusProps {
    status: AIStreamSessionStatus;
    currentStage?: string | null;
    error?: string | null;
    errorMessage?: string | null;
    activeGhostHunksCount?: number;
    operation?: string;
    isConflict?: boolean;
    onRetry?: () => void;
    onStop?: () => void;
    onCancel?: () => void;
    className?: string;
}

/**
 * AIStreamStatus Component
 *
 * Ephemeral visual status indicator for active 7-stage architectural agent sessions,
 * HITL clarification gates, multi-hunk preview readiness, and failure states.
 */
export const AIStreamStatus: React.FC<AIStreamStatusProps> = ({
    status,
    currentStage,
    error,
    errorMessage,
    activeGhostHunksCount,
    operation: _operation,
    isConflict = false,
    onRetry,
    onStop,
    onCancel,
    className = '',
}) => {
    const handleStop = onStop || onCancel;
    const displayError = error || errorMessage;

    if (isConflict) {
        return (
            <div
                data-testid="ai-stream-status"
                className={`mx-6 mt-3 p-3 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-200 text-xs flex items-center justify-between shadow-sm ${className}`}
            >
                <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Notice: File was modified in another session during processing. Original text was preserved.</span>
                </div>
                {onRetry && (
                    <button
                        data-testid="ai-stream-retry-btn"
                        onClick={onRetry}
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600/30 hover:bg-amber-600/50 text-amber-100 transition-colors cursor-pointer"
                    >
                        <RefreshCw className="w-3 h-3" />
                        <span>Retry</span>
                    </button>
                )}
            </div>
        );
    }

    if (status === 'idle') {
        return null;
    }

    if (status === 'failed') {
        return (
            <div
                data-testid="ai-stream-status"
                className={`mx-6 mt-3 p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-200 text-xs flex items-center justify-between shadow-sm ${className}`}
            >
                <div className="flex items-center gap-2">
                    <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                    <span data-testid="ai-stream-error">
                        {displayError || 'An error occurred during AI processing. Quota was refunded.'}
                    </span>
                </div>
                {onRetry && (
                    <button
                        data-testid="ai-stream-retry-btn"
                        onClick={onRetry}
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-red-600/30 hover:bg-red-600/50 text-red-100 transition-colors cursor-pointer"
                    >
                        <RefreshCw className="w-3 h-3" />
                        <span>Retry</span>
                    </button>
                )}
            </div>
        );
    }

    if (status === 'running_graph' || (status as string) === 'reserved' || (status as string) === 'committing') {
        const stageLabel = (status as string) === 'committing'
            ? 'Committing changes...'
            : (status as string) === 'reserved'
            ? 'Reserving quota and initiating session...'
            : currentStage
            ? `Agent reasoning: ${currentStage}...`
            : 'Agent reasoning...';

        return (
            <div
                data-testid="ai-stream-status"
                className={`mx-6 mt-3 px-4 py-2 rounded-lg bg-zinc-900/80 border border-indigo-500/30 text-xs flex items-center justify-between backdrop-blur-xs ${className}`}
            >
                <div className="flex items-center gap-2.5 text-indigo-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    <span className="font-mono tracking-wide">{stageLabel}</span>
                </div>
                {handleStop && (status as string) !== 'committing' && (
                    <button
                        data-testid="ai-stream-stop-btn"
                        onClick={handleStop}
                        className="flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer"
                    >
                        <Square className="w-3 h-3 text-red-400" />
                        <span>Stop</span>
                    </button>
                )}
            </div>
        );
    }

    if (status === 'awaiting_hitl') {
        return (
            <div
                data-testid="ai-stream-status"
                className={`mx-6 mt-3 px-4 py-2 rounded-lg bg-zinc-900/80 border border-amber-500/40 text-xs flex items-center justify-between backdrop-blur-xs ${className}`}
            >
                <div className="flex items-center gap-2.5 text-amber-300">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-400 animate-pulse" />
                    <span className="font-mono tracking-wide">Awaiting clarification</span>
                </div>
                {handleStop && (
                    <button
                        data-testid="ai-stream-stop-btn"
                        onClick={handleStop}
                        className="flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer"
                    >
                        <Square className="w-3 h-3 text-red-400" />
                        <span>Stop</span>
                    </button>
                )}
            </div>
        );
    }

    if (status === 'streaming_hunks' || (status as string) === 'streaming') {
        return (
            <div
                data-testid="ai-stream-status"
                className={`mx-6 mt-3 px-4 py-2 rounded-lg bg-zinc-900/80 border border-emerald-500/30 text-xs flex items-center justify-between backdrop-blur-xs ${className}`}
            >
                <div className="flex items-center gap-2.5 text-emerald-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    <span className="font-mono tracking-wide">Synthesizing document hunks...</span>
                </div>
                {handleStop && (
                    <button
                        data-testid="ai-stream-stop-btn"
                        onClick={handleStop}
                        className="flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer"
                    >
                        <Square className="w-3 h-3 text-red-400" />
                        <span>Stop</span>
                    </button>
                )}
            </div>
        );
    }

    if (status === 'preview_ready') {
        const previewLabel =
            activeGhostHunksCount !== undefined && activeGhostHunksCount > 0
                ? `Ghost preview ready (${activeGhostHunksCount} hunk${activeGhostHunksCount > 1 ? 's' : ''})`
                : 'Ghost preview ready';

        return (
            <div
                data-testid="ai-stream-status"
                className={`mx-6 mt-3 px-4 py-2 rounded-lg bg-zinc-900/80 border border-purple-500/40 text-xs flex items-center justify-between backdrop-blur-xs ${className}`}
            >
                <div className="flex items-center gap-2.5 text-purple-300">
                    <GitBranch className="w-3.5 h-3.5 shrink-0 text-purple-400" />
                    <span className="font-mono tracking-wide">{previewLabel}</span>
                </div>
            </div>
        );
    }

    if (status === 'completed') {
        return (
            <div
                data-testid="ai-stream-status"
                className={`mx-6 mt-3 px-4 py-2 rounded-lg bg-zinc-900/80 border border-emerald-500/30 text-xs flex items-center justify-between backdrop-blur-xs ${className}`}
            >
                <div className="flex items-center gap-2.5 text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-mono tracking-wide">Changes applied</span>
                </div>
            </div>
        );
    }

    if (status === 'aborted') {
        return (
            <div
                data-testid="ai-stream-status"
                className={`mx-6 mt-3 px-4 py-2 rounded-lg bg-zinc-900/80 border border-zinc-700 text-xs flex items-center justify-between backdrop-blur-xs ${className}`}
            >
                <div className="flex items-center gap-2.5 text-zinc-400">
                    <XCircle className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-mono tracking-wide">Session aborted</span>
                </div>
            </div>
        );
    }

    return null;
};
