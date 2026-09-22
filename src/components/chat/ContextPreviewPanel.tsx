'use client';
import { EditorOverlay } from '@/components/ui/editor-overlay';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X,
    ChevronDown,
    ChevronRight,
    Eye,
    Zap,
    BookOpen,
    MessageSquare,
    FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ContextSection } from '@/types/rag';

interface ContextPreviewPanelProps {
    isOpen: boolean;
    onClose: () => void;
    sections: ContextSection[];
    totalTokens: number;
    maxTokens: number;
    maxOutputTokens: number;
    warnings: string[];
    includedMessages: number;
    droppedMessages: number;
    /** History-window accounting: the answer to "why isn't my budget full?". */
    tokenBreakdown?: {
        history: number;
        dynamicReserve: number;
        historyBudget: number;
        historyTarget: number;
        historyHeadroom: number;
        system: number;
    };
    historyWindow?: {
        action: 'unchanged' | 'cut' | 'expanded' | 'transient-trim';
        reason: string;
        recoverableMessageCount: number;
    };
    chronicleStats?: {
        arcs: number;
        sections: number;
        fragments: number;
        omittedSections: number;
        uncoveredEvictedMessages: number;
    };
}

const sectionIcons: Record<string, React.ReactNode> = {
    system: <Zap className="h-4 w-4 text-yellow-400" />,
    summary: <BookOpen className="h-4 w-4 text-green-400" />,
    lorebook: <BookOpen className="h-4 w-4 text-orange-400" />,
    canon: <BookOpen className="h-4 w-4 text-rose-400" />,
    history: <MessageSquare className="h-4 w-4 text-cyan-400" />,
    'post-history': <FileText className="h-4 w-4 text-pink-400" />,
};

const sectionColors: Record<string, string> = {
    system: 'border-yellow-400/30 bg-yellow-400/5',
    summary: 'border-green-400/30 bg-green-400/5',
    lorebook: 'border-orange-400/30 bg-orange-400/5',
    canon: 'border-rose-400/30 bg-rose-400/5',
    history: 'border-cyan-400/30 bg-cyan-400/5',
    'post-history': 'border-pink-400/30 bg-pink-400/5',
};

const windowActionLabels: Record<string, string> = {
    unchanged: 'Inchangée — préfixe en cache',
    cut: 'Recoupée',
    expanded: 'Élargie',
    'transient-trim': 'Rognage temporaire',
};

export function ContextPreviewPanel({
    isOpen,
    onClose,
    sections,
    totalTokens,
    maxTokens,
    maxOutputTokens,
    warnings,
    includedMessages,
    droppedMessages,
    tokenBreakdown,
    historyWindow,
    chronicleStats,
}: ContextPreviewPanelProps) {
    const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());

    const toggleSection = (idx: number) => {
        setExpandedSections((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
        });
    };

    const contextUsed = totalTokens;
    const usagePercent = Math.min(100, Math.round((contextUsed / maxTokens) * 100));
    const inputTokens = contextUsed - maxOutputTokens;

    // Color coding for usage bar
    const usageColor =
        usagePercent > 95 ? 'bg-red-500' : usagePercent > 80 ? 'bg-yellow-500' : 'bg-green-500';

    return (<EditorOverlay open={isOpen} onClose={onClose} title="Aperçu du contexte">
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 max-sm:p-0"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.95, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                        className="mobile-editor bg-background border border-white/10 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl max-sm:h-dvh max-sm:max-h-none max-sm:rounded-none max-sm:border-0"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
                            <div className="flex items-center gap-2">
                                <Eye className="h-5 w-5 text-primary" />
                                <h2 className="font-semibold text-lg">Aperçu du contexte</h2>
                                <span className="text-xs text-muted-foreground px-2 py-0.5 rounded-full bg-white/5">
                                    {sections.length} sections
                                </span>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={onClose}
                                className="h-8 w-8"
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        </div>

                        {/* Token Usage Bar */}
                        <div className="px-4 py-3 border-b border-white/5 space-y-2 shrink-0">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
                                <span className="text-muted-foreground">Budget de tokens</span>
                                <span className="font-mono">
                                    <span className="text-foreground">
                                        {inputTokens.toLocaleString()}
                                    </span>
                                    <span className="text-muted-foreground">
                                        {' '}
                                        + {maxOutputTokens.toLocaleString()} en sortie
                                    </span>
                                    <span className="text-muted-foreground">
                                        {' '}
                                        / {maxTokens.toLocaleString()}
                                    </span>
                                </span>
                            </div>
                            {/* Two segments: what is actually sent, then the slice reserved
                                for the reply. Showing them as one bar made a mostly-empty
                                context look fuller than it was. */}
                            <div className="h-2 bg-white/5 rounded-full overflow-hidden flex">
                                <div
                                    className={`h-full ${usageColor} transition-all duration-300`}
                                    style={{
                                        width: `${Math.min(100, (inputTokens / maxTokens) * 100)}%`,
                                    }}
                                />
                                <div
                                    className="h-full bg-white/15 transition-all duration-300"
                                    style={{
                                        width: `${Math.min(100, (maxOutputTokens / maxTokens) * 100)}%`,
                                    }}
                                    title="Réservé pour la réponse du modèle"
                                />
                            </div>
                            {/* wrap + gap: on a phone these two run into each other and the
                                parenthesised halves end up orphaned on their own lines. */}
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                                <span>
                                    {usagePercent}% engagé{' '}
                                    <span className="whitespace-nowrap">
                                        (dont {maxOutputTokens.toLocaleString()} en sortie)
                                    </span>
                                </span>
                                <span className="whitespace-nowrap">
                                    {includedMessages} msgs inclus
                                    {droppedMessages > 0 && (
                                        <span className="text-yellow-400 ml-1">
                                            ({droppedMessages} évincés)
                                        </span>
                                    )}
                                </span>
                            </div>
                        </div>

                        {/* History window — the accounting that used to be invisible, which is
                            exactly why an under-filled context went unnoticed for so long. */}
                        {tokenBreakdown && historyWindow && (
                            <div className="px-4 py-3 border-b border-white/5 shrink-0 space-y-1.5 text-xs">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                                    <span className="text-muted-foreground font-medium">
                                        Fenêtre d&apos;historique
                                    </span>
                                    <span className="text-muted-foreground">
                                        {windowActionLabels[historyWindow.action] ??
                                            historyWindow.action}
                                    </span>
                                </div>
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 font-mono">
                                    <span className="text-muted-foreground">Utilisé / budget</span>
                                    <span>
                                        <span className="text-foreground">
                                            {tokenBreakdown.history.toLocaleString()}
                                        </span>
                                        <span className="text-muted-foreground">
                                            {' '}
                                            / {tokenBreakdown.historyBudget.toLocaleString()} tk
                                        </span>
                                        {tokenBreakdown.historyBudget > 0 && (
                                            <span className="text-muted-foreground">
                                                {' '}
                                                (
                                                {Math.round(
                                                    (tokenBreakdown.history /
                                                        tokenBreakdown.historyBudget) *
                                                        100
                                                )}
                                                %)
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-cyan-400/70 rounded-full"
                                        style={{
                                            width: `${Math.min(
                                                100,
                                                tokenBreakdown.historyBudget > 0
                                                    ? (tokenBreakdown.history /
                                                          tokenBreakdown.historyBudget) *
                                                          100
                                                    : 0
                                            )}%`,
                                        }}
                                    />
                                </div>
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                                    <span>
                                        Cible {tokenBreakdown.historyTarget.toLocaleString()} ·
                                        réserve dynamique{' '}
                                        {tokenBreakdown.dynamicReserve.toLocaleString()}
                                    </span>
                                    {historyWindow.recoverableMessageCount > 0 && (
                                        <span>
                                            {historyWindow.recoverableMessageCount} récupérables
                                        </span>
                                    )}
                                </div>
                                <p className="text-[11px] text-muted-foreground/80 italic">
                                    {historyWindow.reason}
                                </p>
                                {chronicleStats && (
                                    <p className="text-[11px] text-muted-foreground">
                                        Chronique : {chronicleStats.arcs} arc
                                        {chronicleStats.arcs > 1 ? 's' : ''} ·{' '}
                                        {chronicleStats.sections} section
                                        {chronicleStats.sections > 1 ? 's' : ''} ·{' '}
                                        {chronicleStats.fragments} fragment
                                        {chronicleStats.fragments > 1 ? 's' : ''}
                                        {chronicleStats.omittedSections > 0 && (
                                            <span className="text-yellow-400">
                                                {' '}
                                                ({chronicleStats.omittedSections} section
                                                {chronicleStats.omittedSections > 1
                                                    ? 's omises'
                                                    : ' omise'}{' '}
                                                faute de place)
                                            </span>
                                        )}
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Warnings */}
                        {warnings.length > 0 && (
                            <div className="px-4 py-2 border-b border-white/5 shrink-0">
                                {warnings.map((w, i) => (
                                    <p key={i} className="text-xs text-yellow-400">
                                        {w}
                                    </p>
                                ))}
                            </div>
                        )}

                        {/* Sections */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-2">
                            {sections.map((section, idx) => {
                                const isExpanded = expandedSections.has(idx);
                                const colorClass =
                                    sectionColors[section.type] || 'border-white/10 bg-white/5';
                                const icon = sectionIcons[section.type] || (
                                    <FileText className="h-4 w-4" />
                                );

                                return (
                                    <div
                                        key={idx}
                                        className={`border rounded-lg overflow-hidden ${colorClass}`}
                                    >
                                        <button
                                            onClick={() => toggleSection(idx)}
                                            className="w-full px-3 py-2 flex items-start gap-2 hover:bg-white/5 transition-colors text-left"
                                        >
                                            <span className="shrink-0 pt-0.5">
                                                {isExpanded ? (
                                                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                                ) : (
                                                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                                )}
                                            </span>
                                            <span className="shrink-0 pt-0.5">{icon}</span>

                                            {/* Two rows on a phone, one on wider screens. The
                                                badge and the token count are shrink-0, so side
                                                by side with the label they left it barely 100px
                                                and it wrapped one word per line. */}
                                            <span className="flex-1 min-w-0 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                                                <span className="text-sm font-medium break-words sm:flex-1 sm:min-w-0">
                                                    {section.label}
                                                </span>
                                                <span className="flex items-center gap-1.5 shrink-0">
                                                    {/* Without this, a 900-token section that no
                                                        longer adds to the total reads as a bug. */}
                                                    {section.countedIn && (
                                                        <span className="text-[10px] leading-tight px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-muted-foreground whitespace-nowrap">
                                                            déjà compté&nbsp;:{' '}
                                                            {section.countedIn === 'system'
                                                                ? 'système'
                                                                : 'post-historique'}
                                                        </span>
                                                    )}
                                                    <span
                                                        className={`text-xs font-mono whitespace-nowrap ${
                                                            section.countedIn
                                                                ? 'text-muted-foreground/50 line-through'
                                                                : 'text-muted-foreground'
                                                        }`}
                                                    >
                                                        {section.tokens.toLocaleString()} tk
                                                    </span>
                                                </span>
                                            </span>
                                        </button>

                                        <AnimatePresence>
                                            {isExpanded && (
                                                <motion.div
                                                    initial={{ height: 0 }}
                                                    animate={{ height: 'auto' }}
                                                    exit={{ height: 0 }}
                                                    className="overflow-hidden"
                                                >
                                                    <div className="px-3 pb-3 pt-1 border-t border-white/5">
                                                        <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-words font-mono leading-relaxed max-h-64 overflow-y-auto custom-scrollbar">
                                                            {section.content}
                                                        </pre>
                                                    </div>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Footer */}
                        <div className="p-3 border-t border-white/10 flex items-center justify-between text-xs text-muted-foreground shrink-0">
                            <span>
                                Comptage des tokens via le tokenizer cl100k_base (compatible GPT-4)
                            </span>
                            <Button variant="outline" size="sm" onClick={onClose}>
                                Fermer
                            </Button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
        </EditorOverlay>
    );
}
