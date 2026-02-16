'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X,
    ChevronDown,
    ChevronRight,
    Eye,
    Zap,
    Brain,
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
}

const sectionIcons: Record<string, React.ReactNode> = {
    system: <Zap className="h-4 w-4 text-yellow-400" />,
    memory: <Brain className="h-4 w-4 text-purple-400" />,
    fact: <Eye className="h-4 w-4 text-blue-400" />,
    summary: <BookOpen className="h-4 w-4 text-green-400" />,
    lorebook: <BookOpen className="h-4 w-4 text-orange-400" />,
    history: <MessageSquare className="h-4 w-4 text-cyan-400" />,
    'post-history': <FileText className="h-4 w-4 text-pink-400" />,
};

const sectionColors: Record<string, string> = {
    system: 'border-yellow-400/30 bg-yellow-400/5',
    memory: 'border-purple-400/30 bg-purple-400/5',
    fact: 'border-blue-400/30 bg-blue-400/5',
    summary: 'border-green-400/30 bg-green-400/5',
    lorebook: 'border-orange-400/30 bg-orange-400/5',
    history: 'border-cyan-400/30 bg-cyan-400/5',
    'post-history': 'border-pink-400/30 bg-pink-400/5',
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

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.95, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                        className="bg-background border border-white/10 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
                            <div className="flex items-center gap-2">
                                <Eye className="h-5 w-5 text-primary" />
                                <h2 className="font-semibold text-lg">Context Preview</h2>
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
                            <div className="flex items-center justify-between text-sm">
                                <span className="text-muted-foreground">Token Budget</span>
                                <span className="font-mono">
                                    <span className="text-foreground">
                                        {inputTokens.toLocaleString()}
                                    </span>
                                    <span className="text-muted-foreground">
                                        {' '}
                                        + {maxOutputTokens.toLocaleString()} output
                                    </span>
                                    <span className="text-muted-foreground">
                                        {' '}
                                        / {maxTokens.toLocaleString()}
                                    </span>
                                </span>
                            </div>
                            <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                                <div
                                    className={`h-full ${usageColor} rounded-full transition-all duration-300`}
                                    style={{ width: `${usagePercent}%` }}
                                />
                            </div>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span>{usagePercent}% used</span>
                                <span>
                                    {includedMessages} messages included
                                    {droppedMessages > 0 && (
                                        <span className="text-yellow-400 ml-1">
                                            ({droppedMessages} truncated)
                                        </span>
                                    )}
                                </span>
                            </div>
                        </div>

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
                                            className="w-full px-3 py-2 flex items-center gap-2 hover:bg-white/5 transition-colors text-left"
                                        >
                                            {isExpanded ? (
                                                <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                                            ) : (
                                                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                                            )}
                                            {icon}
                                            <span className="text-sm font-medium flex-1">
                                                {section.label}
                                            </span>
                                            <span className="text-xs font-mono text-muted-foreground">
                                                {section.tokens.toLocaleString()} tokens
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
                            <span>Token counts use cl100k_base tokenizer (GPT-4 compatible)</span>
                            <Button variant="outline" size="sm" onClick={onClose}>
                                Close
                            </Button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
