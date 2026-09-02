'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
    Brain,
    Plus,
    Trash2,
    Sparkles,
    Loader2,
    X,
    Edit2,
    Layers,
    RefreshCw,
    Search,
    BrainCircuit,
    Feather,
} from 'lucide-react';
import { useCharacterStore } from '@/stores/character-store';
import { useChatStore } from '@/stores/chat-store';
import { extractRepeatedPhrases, isAnalysisStale } from '@/lib/ai/style-analyzer';
import { cn } from '@/lib/utils';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { loadRagDataByConversation } from '@/lib/rag-data-loader';
import type { MemorySummary } from '@/types/rag';
import { useSettingsStore } from '@/stores/settings-store';
import { decryptApiKey } from '@/lib/crypto';

interface MemoryPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

type TabType = 'notes' | 'guidance' | 'scratchpad' | 'style' | 'summaries';

export function MemoryPanel({ isOpen, onClose }: MemoryPanelProps) {
    const { getActiveCharacter } = useCharacterStore();
    const scratchpadEnabled = useSettingsStore((s) => s.enableScratchpad);
    const {
        getActiveBranchMessages,
        getActiveBranchBanList,
        conversations,
        activeConversationId,
        updateConversationNotes,
        messages: storeMessages, // subscribe so the branch-aware ban list re-renders on snapshot writes
    } = useChatStore();

    const character = getActiveCharacter();
    const [activeTab, setActiveTab] = useState<TabType>('notes');
    const [newMemory, setNewMemory] = useState('');
    const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [editValue, setEditValue] = useState('');
    const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);

    // Chronicle state
    const [summaries, setSummaries] = useState<MemorySummary[]>([]);
    const [isLoadingRag, setIsLoadingRag] = useState(false);
    const [isReindexing, setIsReindexing] = useState(false);
    const [confirmReindex, setConfirmReindex] = useState(false);
    const [reindexProgress, setReindexProgress] = useState('');
    const [summarySearchTerm, setSummarySearchTerm] = useState('');
    const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
    const [summaryEditValue, setSummaryEditValue] = useState('');
    const [regeneratingSummaryId, setRegeneratingSummaryId] = useState<string | null>(null);
    const [expandedSummaryIds, setExpandedSummaryIds] = useState<Set<string>>(new Set());

    // Style Guard state
    const [styleSuggestions, setStyleSuggestions] = useState<string[]>([]);
    const [isAnalyzingStyle, setIsAnalyzingStyle] = useState(false);
    const [newBanRule, setNewBanRule] = useState('');
    // Monotonic token: any newer analysis OR any conversation/branch-tip change bumps it,
    // invalidating in-flight results (covers swiping away and back to the same tip).
    const analysisRunIdRef = useRef(0);

    // Load the Chronicle when its tab opens
    const loadRagData = useCallback(async () => {
        if (!activeConversationId) return;
        setIsLoadingRag(true);
        try {
            const { summaries: loadedSummaries, errors } =
                await loadRagDataByConversation(activeConversationId);
            setSummaries(loadedSummaries);
            if (errors.summaries) {
                console.error('[MemoryPanel] Failed to load summaries:', errors.summaries);
            }
        } catch (err) {
            console.error('[MemoryPanel] Failed to load the Chronicle:', err);
        } finally {
            setIsLoadingRag(false);
        }
    }, [activeConversationId]);

    useEffect(() => {
        if (isOpen && activeTab === 'summaries') {
            loadRagData();
        }
    }, [isOpen, activeTab, loadRagData]);

    // The active branch's ban list (snapshot on the branch tip, falling back to the
    // conversation-level list). Re-derived whenever messages/conversations change.
    const activeBanList = useMemo(() => {
        void storeMessages;
        void conversations;
        return activeConversationId ? getActiveBranchBanList(activeConversationId) : [];
    }, [activeConversationId, getActiveBranchBanList, storeMessages, conversations]);

    // The id of the active branch tip. A swipe keeps activeConversationId but moves this,
    // so it — not the conversation id — is what scopes a Style Guard analysis to its branch.
    const activeBranchTipId = useMemo(() => {
        void storeMessages;
        if (!activeConversationId) return null;
        const path = getActiveBranchMessages(activeConversationId);
        return path.length ? path[path.length - 1].id : null;
    }, [activeConversationId, getActiveBranchMessages, storeMessages]);

    // Style suggestions are local, per-analysis state — never let one branch's suggestions
    // bleed into another. Switching conversation OR moving the branch tip (swipe / new turn)
    // invalidates any in-flight analysis and clears stale suggestions.
    useEffect(() => {
        analysisRunIdRef.current += 1;
        setStyleSuggestions([]);
        setIsAnalyzingStyle(false);
        setNewBanRule('');
    }, [activeConversationId, activeBranchTipId]);

    if (!character) return null;

    // Use conversation-scoped notes (with fallback to character-level for backward compat)
    const conversation = conversations.find((c) => c.id === activeConversationId);
    const memories = conversation?.notes || [];

    // Read the live active branch tip straight from the store (not React state, which may
    // not have flushed yet when an async result lands).
    const liveBranchTipId = (convId: string): string | null => {
        const path = useChatStore.getState().getActiveBranchMessages(convId);
        return path.length ? path[path.length - 1].id : null;
    };

    // --- Style Guard handlers ---
    const handleAnalyzeStyle = async () => {
        if (!activeConversationId) return;
        // Pin the run to a (runId, conversation, branch tip) key. A swipe keeps the
        // conversation but moves the tip, so the tip is essential to scope the result.
        const started = {
            runId: (analysisRunIdRef.current += 1),
            conversationId: activeConversationId,
            branchTipId: activeBranchTipId,
        };
        setIsAnalyzingStyle(true);
        try {
            const assistantText = getActiveBranchMessages(started.conversationId)
                .filter((m) => m.role === 'assistant')
                .map((m) => m.content);
            const rules = await extractRepeatedPhrases(assistantText);

            const store = useChatStore.getState();
            const current = {
                runId: analysisRunIdRef.current,
                conversationId: store.activeConversationId ?? '',
                branchTipId: liveBranchTipId(started.conversationId),
            };
            // Discard if the user switched conversation, swiped to another branch, or kicked
            // off a newer analysis while this one was running.
            if (isAnalysisStale(started, current)) return;

            const existing = new Set(
                store.getActiveBranchBanList(started.conversationId).map((b) => b.toLowerCase())
            );
            setStyleSuggestions(rules.filter((r) => !existing.has(r.toLowerCase())));
        } catch (err) {
            console.error('[Style] Analysis failed:', err);
        } finally {
            // Only this run owns the spinner; if it was superseded, the newer run (or the
            // reset effect) controls it.
            if (analysisRunIdRef.current === started.runId) setIsAnalyzingStyle(false);
        }
    };

    // Append a single rule, reading the CURRENT branch list fresh from the store (never a
    // stale render-time copy) so successive adds don't clobber each other.
    const addBanRule = (rule: string) => {
        const trimmed = rule.trim();
        if (!activeConversationId || !trimmed) return;
        const store = useChatStore.getState();
        const current = store.getActiveBranchBanList(activeConversationId);
        if (current.some((b) => b.toLowerCase() === trimmed.toLowerCase())) return;
        store.setBanList(activeConversationId, [...current, trimmed]);
    };

    // Merge every (possibly edited) suggestion in a SINGLE write so they don't overwrite
    // one another, then clear the suggestion list.
    const addAllBanRules = () => {
        if (!activeConversationId) return;
        const store = useChatStore.getState();
        const current = store.getActiveBranchBanList(activeConversationId);
        const seen = new Set(current.map((b) => b.toLowerCase()));
        const additions: string[] = [];
        for (const raw of styleSuggestions) {
            const trimmed = raw.trim();
            if (trimmed && !seen.has(trimmed.toLowerCase())) {
                additions.push(trimmed);
                seen.add(trimmed.toLowerCase());
            }
        }
        if (additions.length > 0)
            store.setBanList(activeConversationId, [...current, ...additions]);
        setStyleSuggestions([]);
    };

    const acceptSuggestion = (index: number) => {
        addBanRule(styleSuggestions[index] ?? '');
        setStyleSuggestions((s) => s.filter((_, i) => i !== index));
    };

    const dismissSuggestion = (index: number) => {
        setStyleSuggestions((s) => s.filter((_, i) => i !== index));
    };

    const editSuggestion = (index: number, value: string) => {
        setStyleSuggestions((s) => s.map((x, i) => (i === index ? value : x)));
    };

    const removeBanRule = (rule: string) => {
        if (!activeConversationId) return;
        const store = useChatStore.getState();
        const current = store.getActiveBranchBanList(activeConversationId);
        store.setBanList(
            activeConversationId,
            current.filter((b) => b !== rule)
        );
    };

    const handleAddMemory = async () => {
        if (!newMemory.trim() || !activeConversationId) return;
        // Date-stamped note (was the deleted memory-summarizer's formatMemoryEntry).
        const formattedEntry = `[${new Date().toLocaleDateString()}] ${newMemory.trim()}`;
        const updated = [...memories, formattedEntry];
        updateConversationNotes(activeConversationId, updated);
        setNewMemory('');
    };

    const handleUpdateMemory = async (index: number) => {
        if (!editValue.trim() || !activeConversationId) return;
        const updated = [...memories];
        updated[index] = editValue.trim();
        updateConversationNotes(activeConversationId, updated);
        setEditingIndex(null);
    };

    const handleDeleteMemory = async (index: number) => {
        if (!activeConversationId) return;
        const updated = memories.filter((_, i) => i !== index);
        updateConversationNotes(activeConversationId, updated);
        setConfirmDeleteIndex(null);
    };

    const handleDeleteSummary = async (summaryId: string) => {
        try {
            const { deleteSummary } = await import('@/lib/db');
            await deleteSummary(summaryId);
            setSummaries((prev) => prev.filter((s) => s.id !== summaryId));
        } catch (err) {
            console.error('[MemoryPanel] Failed to delete summary:', err);
        }
    };

    /**
     * Save a hand-edited summary. `saveSummary` is an upsert, so read-patch-write is the whole
     * update path. The `isManuallyEdited` flag is what keeps a full re-index from silently
     * throwing the edit away without warning.
     */
    const handleSaveSummaryEdit = async (summaryId: string) => {
        const target = summaries.find((s) => s.id === summaryId);
        if (!target || !summaryEditValue.trim()) return;
        const updated: MemorySummary = {
            ...target,
            content: summaryEditValue.trim(),
            isManuallyEdited: true,
            editedAt: Date.now(),
        };
        try {
            const { saveSummary } = await import('@/lib/db');
            await saveSummary(updated);
            setSummaries((prev) => prev.map((s) => (s.id === summaryId ? updated : s)));
            setEditingSummaryId(null);
            setSummaryEditValue('');
        } catch (err) {
            console.error('[MemoryPanel] Failed to save summary:', err);
        }
    };

    /**
     * Rebuild ONE summary from its children. Needed because improving the summarization
     * prompts does nothing to summaries already written — and the only alternative, a full
     * re-index, destroys the whole Chronicle including hand-written edits.
     */
    const handleRegenerateSummary = async (summary: MemorySummary) => {
        if (regeneratingSummaryId || summary.level === 0) return;
        setRegeneratingSummaryId(summary.id);
        try {
            const {
                buildL1Prompt,
                buildL2Prompt,
                parseSummarizationResponse,
                SUMMARIZATION_PROMPT_L1,
                SUMMARIZATION_PROMPT_L2,
            } = await import('@/lib/ai/hierarchical-summarizer');
            const { backgroundAICall } = await import('@/lib/ai/background-ai');
            const { saveSummary } = await import('@/lib/db');

            const children = summaries.filter((s) => summary.childIds.includes(s.id));
            if (children.length === 0) {
                setReindexProgress(
                    'Impossible de régénérer : les résumés source ont été supprimés.'
                );
                setTimeout(() => setReindexProgress(''), 5000);
                return;
            }

            const isArc = summary.level === 2;
            const result = await backgroundAICall({
                systemPrompt: isArc ? SUMMARIZATION_PROMPT_L2 : SUMMARIZATION_PROMPT_L1,
                userPrompt: isArc ? buildL2Prompt(children) : buildL1Prompt(children),
                temperature: 0.3,
                backgroundModel: useSettingsStore.getState().backgroundModel,
            });
            if (!result) {
                setReindexProgress('Régénération échouée : aucune réponse du modèle de fond.');
                setTimeout(() => setReindexProgress(''), 5000);
                return;
            }

            const parsed = parseSummarizationResponse(result.content);
            if (!parsed) return;

            // A regenerated summary is machine-written again: the manual-edit flag goes away,
            // otherwise a re-index would spare something the user never wrote.
            const updated: MemorySummary = {
                ...summary,
                content: parsed.summary,
                keyFacts: parsed.keyFacts,
                isManuallyEdited: false,
                editedAt: undefined,
            };
            await saveSummary(updated);
            setSummaries((prev) => prev.map((s) => (s.id === summary.id ? updated : s)));
        } catch (err) {
            console.error('[MemoryPanel] Failed to regenerate summary:', err);
        } finally {
            setRegeneratingSummaryId(null);
        }
    };

    const handleReindex = async () => {
        if (!activeConversationId || !character || isReindexing) return;
        setIsReindexing(true);
        setReindexProgress('Démarrage de la réindexation complète…');

        try {
            const msgs = getActiveBranchMessages(activeConversationId);
            if (msgs.length === 0) {
                setReindexProgress('Aucun message à indexer.');
                setIsReindexing(false);
                return;
            }

            // Get API key
            const { apiKeys } = useSettingsStore.getState();
            const orConfig = apiKeys.find((k) => k.provider === 'openrouter');
            let apiKey = '';
            if (orConfig) {
                apiKey = (await decryptApiKey(orConfig.encryptedKey)) || '';
            }
            if (!apiKey) {
                setReindexProgress('Erreur : aucune clé API trouvée.');
                setIsReindexing(false);
                return;
            }

            const {
                createSummary,
                shouldCreateL1Summary,
                getL0SummariesForL1,
                shouldCreateL2Summary,
                getL1SummariesForL2,
                buildL0Prompt,
                buildL1Prompt,
                buildL2Prompt,
                SUMMARIZATION_PROMPT_L0,
                SUMMARIZATION_PROMPT_L1,
                SUMMARIZATION_PROMPT_L2,
                parseSummarizationResponse,
                DEFAULT_CHUNK_SIZE,
            } = await import('@/lib/ai/hierarchical-summarizer');
            const { getAdaptiveChunkSize } = await import('@/lib/ai/message-quality');
            const { getSummariesByConversation: getSummaries, deleteSummariesByConversation } =
                await import('@/lib/db');
            const { backgroundAICall } = await import('@/lib/ai/background-ai');
            const { getActivePersona, backgroundModel } =
                await import('@/stores/settings-store').then((m) => {
                    const state = m.useSettingsStore.getState();
                    return {
                        getActivePersona: () =>
                            state.personas.find((p) => p.id === state.activePersonaId),
                        backgroundModel: state.backgroundModel,
                    };
                });

            const activePersona = getActivePersona();
            const userName = activePersona?.name || 'You';

            // Clear the whole Chronicle for a clean rebuild
            setReindexProgress('Suppression de l’ancienne chronique…');
            await deleteSummariesByConversation(activeConversationId);

            // Same adaptive sizing as the live pipeline — a fixed 10 here produced a Chronicle
            // that did not line up with the one the background pipeline would have written.
            const chunkSize = getAdaptiveChunkSize(
                msgs.slice(-15).map((m) => ({ role: m.role, content: m.content })),
                DEFAULT_CHUNK_SIZE
            );
            const totalToProcess = Math.floor(msgs.length / chunkSize);

            if (totalToProcess <= 0) {
                setReindexProgress(
                    'Pas assez de messages pour un fragment de résumé (au moins 10 requis).'
                );
                await loadRagData();
                setIsReindexing(false);
                return;
            }

            setReindexProgress(`Traitement de ${totalToProcess} fragments de 10 messages…`);

            for (let i = 0; i < totalToProcess; i++) {
                const startIdx = i * chunkSize;
                const chunk = msgs.slice(startIdx, startIdx + chunkSize);
                if (chunk.length < chunkSize) break;

                setReindexProgress(`Résumé du fragment ${i + 1}/${totalToProcess}…`);

                // Create L0 summary via backgroundAICall (handles 429 retries + model fallback)
                const prompt = buildL0Prompt(chunk, character.name, userName);
                const result = await backgroundAICall({
                    systemPrompt: SUMMARIZATION_PROMPT_L0,
                    userPrompt: prompt,
                    apiKey,
                    temperature: 0.3,
                    backgroundModel,
                });

                if (result) {
                    const parsed = parseSummarizationResponse(result.content);
                    if (parsed) {
                        await createSummary(
                            activeConversationId,
                            0,
                            parsed.summary,
                            parsed.keyFacts,
                            [startIdx, startIdx + chunk.length],
                            [],
                            msgs.map((m) => m.id)
                        );
                    } else {
                        console.warn(`[Reindex] Chunk ${i + 1}: failed to parse summary response`);
                    }
                } else {
                    console.warn(`[Reindex] Chunk ${i + 1}: all models failed`);
                }
            }

            // Create L1 summaries (loop to handle multiple batches)
            setReindexProgress('Création des résumés de niveau supérieur…');
            let currentSummaries = await getSummaries(activeConversationId);

            while (shouldCreateL1Summary(currentSummaries)) {
                const l0s = getL0SummariesForL1(currentSummaries);
                if (!l0s) break;
                const l1Prompt = buildL1Prompt(l0s);
                const l1Result = await backgroundAICall({
                    systemPrompt: SUMMARIZATION_PROMPT_L1,
                    userPrompt: l1Prompt,
                    apiKey,
                    temperature: 0.3,
                    backgroundModel,
                });
                if (l1Result) {
                    const parsed = parseSummarizationResponse(l1Result.content);
                    if (parsed) {
                        const range: [number, number] = [
                            Math.min(...l0s.map((s) => s.messageRange[0])),
                            Math.max(...l0s.map((s) => s.messageRange[1])),
                        ];
                        await createSummary(
                            activeConversationId,
                            1,
                            parsed.summary,
                            parsed.keyFacts,
                            range,
                            l0s.map((s) => s.id),
                            msgs.map((m) => m.id)
                        );
                    }
                } else {
                    break;
                }
                currentSummaries = await getSummaries(activeConversationId);
            }

            // Create L2 summaries (loop to handle multiple batches)
            currentSummaries = await getSummaries(activeConversationId);
            while (shouldCreateL2Summary(currentSummaries)) {
                const l1s = getL1SummariesForL2(currentSummaries);
                if (!l1s) break;
                const l2Prompt = buildL2Prompt(l1s);
                const l2Result = await backgroundAICall({
                    systemPrompt: SUMMARIZATION_PROMPT_L2,
                    userPrompt: l2Prompt,
                    apiKey,
                    temperature: 0.3,
                    backgroundModel,
                });
                if (l2Result) {
                    const parsed = parseSummarizationResponse(l2Result.content);
                    if (parsed) {
                        const range: [number, number] = [
                            Math.min(...l1s.map((s) => s.messageRange[0])),
                            Math.max(...l1s.map((s) => s.messageRange[1])),
                        ];
                        await createSummary(
                            activeConversationId,
                            2,
                            parsed.summary,
                            parsed.keyFacts,
                            range,
                            l1s.map((s) => s.id),
                            msgs.map((m) => m.id)
                        );
                    }
                } else {
                    break;
                }
                currentSummaries = await getSummaries(activeConversationId);
            }

            setReindexProgress('Réindexation terminée !');
            await loadRagData();
        } catch (err) {
            console.error('[MemoryPanel] Reindex failed:', err);
            setReindexProgress(
                `Erreur : ${err instanceof Error ? err.message : 'Échec de la réindexation'}`
            );
        } finally {
            setTimeout(() => {
                setIsReindexing(false);
                setReindexProgress('');
            }, 3000);
        }
    };

    if (!isOpen) return null;

    const getLevelLabel = (level: number) => {
        const labels = ['Fragment (L0)', 'Section (L1)', 'Arc (L2)'];
        return labels[level] || `Niveau ${level}`;
    };

    const getLevelColor = (level: number) => {
        const colors = [
            'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
            'text-blue-400 bg-blue-500/10 border-blue-500/20',
            'text-purple-400 bg-purple-500/10 border-purple-500/20',
        ];
        return colors[level] || 'text-muted-foreground bg-muted/20 border-border/20';
    };

    const manuallyEditedCount = summaries.filter((s) => s.isManuallyEdited).length;

    const tabs: { key: TabType; label: string; icon: typeof Brain; count?: number }[] = [
        { key: 'notes', label: 'Notes', icon: Brain, count: memories.length },
        { key: 'guidance', label: 'Guidage', icon: Sparkles },
        { key: 'scratchpad', label: 'Scratchpad', icon: BrainCircuit },
        { key: 'style', label: 'Style', icon: Feather, count: activeBanList.length },
        { key: 'summaries', label: 'Résumés', icon: Layers, count: summaries.length },
    ];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-lg mx-4 bg-background border border-border/50 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] max-sm:mx-0 max-sm:h-dvh max-sm:max-h-none max-sm:rounded-none max-sm:border-0">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b bg-muted/30 shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                            <Brain className="w-5 h-5 text-primary" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="font-bold text-sm truncate">Mémoire & Connaissances</h2>
                            <p className="text-xs text-muted-foreground truncate">
                                {conversation?.title || character.name} — mémoire de la conversation
                            </p>
                        </div>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onClose}
                        className="h-8 w-8 shrink-0"
                    >
                        <X className="w-4 h-4" />
                    </Button>
                </div>

                {/* Tabs — 6 entries can't fit 375px as flex-1 (min-content ≈ 500px): on
                    mobile the bar scrolls horizontally instead of clipping tabs. */}
                <div className="flex border-b bg-muted/10 shrink-0 overflow-x-auto no-scrollbar">
                    {tabs.map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => setActiveTab(tab.key)}
                            className={cn(
                                'sm:flex-1 max-sm:shrink-0 max-sm:px-3 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors relative whitespace-nowrap',
                                activeTab === tab.key
                                    ? 'text-foreground'
                                    : 'text-muted-foreground hover:text-foreground/70'
                            )}
                        >
                            <tab.icon className="w-3.5 h-3.5 shrink-0" />
                            <span>{tab.label}</span>
                            {tab.count !== undefined && tab.count > 0 && (
                                <span
                                    className={cn(
                                        'text-[9px] px-1.5 py-0.5 rounded-full font-bold',
                                        activeTab === tab.key
                                            ? 'bg-primary/15 text-primary'
                                            : 'bg-muted text-muted-foreground'
                                    )}
                                >
                                    {tab.count}
                                </span>
                            )}
                            {activeTab === tab.key && (
                                <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary rounded-full" />
                            )}
                        </button>
                    ))}
                </div>

                {/* Tab Content */}
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    {/* === NOTES TAB === */}
                    {activeTab === 'notes' && (
                        <div className="flex flex-col flex-1 min-h-0">
                            <div className="flex-1 overflow-y-auto">
                                <div className="p-4 space-y-2">
                                    {memories.length === 0 ? (
                                        <div className="text-center py-8">
                                            <Brain className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                                            <p className="text-sm text-muted-foreground">
                                                Aucun souvenir pour l&apos;instant
                                            </p>
                                            <p className="text-xs text-muted-foreground/70 mt-1">
                                                Ajoutez des notes ou générez des résumés IA
                                            </p>
                                        </div>
                                    ) : (
                                        memories.map((memory, index) => (
                                            <div
                                                key={index}
                                                className="p-3 rounded-lg bg-muted/30 border border-border/30 group transition-all"
                                            >
                                                {editingIndex === index ? (
                                                    <div className="space-y-2">
                                                        <Textarea
                                                            value={editValue}
                                                            onChange={(e) =>
                                                                setEditValue(e.target.value)
                                                            }
                                                            className="text-xs min-h-[80px]"
                                                            autoFocus
                                                        />
                                                        <div className="flex justify-end gap-2">
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                onClick={() =>
                                                                    setEditingIndex(null)
                                                                }
                                                                className="h-7 text-[10px]"
                                                            >
                                                                Annuler
                                                            </Button>
                                                            <Button
                                                                size="sm"
                                                                onClick={() =>
                                                                    handleUpdateMemory(index)
                                                                }
                                                                className="h-7 text-[10px]"
                                                            >
                                                                Enregistrer
                                                            </Button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div
                                                        className="flex items-start justify-between cursor-pointer"
                                                        onClick={() =>
                                                            setExpandedIndex(
                                                                expandedIndex === index
                                                                    ? null
                                                                    : index
                                                            )
                                                        }
                                                    >
                                                        <p
                                                            className={cn(
                                                                'text-xs flex-1 pr-2 leading-relaxed',
                                                                expandedIndex !== index &&
                                                                    'line-clamp-2'
                                                            )}
                                                        >
                                                            {memory}
                                                        </p>
                                                        <div className="flex items-center gap-1 shrink-0">
                                                            {/* pointer-coarse: no hover on touch — the buttons must stay visible (and big enough) */}
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-6 w-6 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-60 pointer-coarse:h-9 pointer-coarse:w-9 transition-opacity"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setEditValue(memory);
                                                                    setEditingIndex(index);
                                                                }}
                                                            >
                                                                <Edit2 className="w-3 h-3 text-muted-foreground" />
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-6 w-6 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-60 pointer-coarse:h-9 pointer-coarse:w-9 transition-opacity hover:bg-destructive/10"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setConfirmDeleteIndex(index);
                                                                }}
                                                            >
                                                                <Trash2 className="w-3 h-3 text-destructive" />
                                                            </Button>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>

                            {/* Add Memory */}
                            <div className="p-4 border-t bg-muted/10 space-y-3 shrink-0">
                                <Textarea
                                    placeholder="Ajouter une note de mémoire…"
                                    value={newMemory}
                                    onChange={(e) => setNewMemory(e.target.value)}
                                    className="min-h-[60px] resize-none text-sm"
                                />
                                {/* The old "AI Summary" button (legacy memory-summarizer) is
                                    gone: it burned the PAID foreground model to restate what
                                    the hierarchical summaries already inject for free. */}
                                <Button
                                    onClick={handleAddMemory}
                                    disabled={!newMemory.trim()}
                                    size="sm"
                                    className="w-full gap-2"
                                >
                                    <Plus className="w-3.5 h-3.5" />
                                    Ajouter une note
                                </Button>
                            </div>
                        </div>
                    )}

                    {/* === GUIDANCE TAB === */}
                    {activeTab === 'guidance' && (
                        <div className="flex flex-col flex-1 min-h-0 p-4 space-y-4">
                            <div className="flex items-center gap-2 text-sm font-medium text-primary">
                                <Sparkles className="w-4 h-4" />
                                Guidage narratif (Note d&apos;auteur)
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                Rédigez un mémo pour orienter la direction narrative de l&apos;IA.
                                Il sera injecté directement dans le prompt système pour infléchir
                                subtilement (ou ouvertement) l&apos;histoire, le comportement des
                                personnages ou les événements à venir.
                            </p>
                            <Textarea
                                placeholder="ex. : « Pousse subtilement le joueur vers la vieille taverne », « Montre-toi plus méfiant envers les motivations du joueur », « Le temps tourne lentement à l'orage… »"
                                value={conversation?.storyGuidance || ''}
                                onChange={(e) => {
                                    if (activeConversationId) {
                                        useChatStore
                                            .getState()
                                            .updateStoryGuidance(
                                                activeConversationId,
                                                e.target.value
                                            );
                                    }
                                }}
                                className="flex-1 resize-none text-sm p-3 bg-muted/30 border-border/50 focus-visible:ring-primary/20"
                            />
                        </div>
                    )}

                    {/* === SCRATCHPAD TAB === */}
                    {activeTab === 'scratchpad' && (
                        <div className="flex flex-col flex-1 min-h-0 p-4 space-y-4">
                            <div className="flex items-center gap-2 text-sm font-medium text-primary">
                                <BrainCircuit className="w-4 h-4" />
                                Scratchpad IA (mémoire de travail)
                            </div>
                            {/* Editing while the feature is OFF silently did nothing — the
                                scratchpad is neither injected nor re-emitted. Make it read-only
                                and say so instead of accepting edits into the void. */}
                            {!scratchpadEnabled && (
                                <p className="text-xs text-amber-500/90 leading-relaxed">
                                    Le Scratchpad est désactivé (Réglages → Fonctions IA) : ce
                                    contenu n&apos;est ni injecté ni mis à jour tant qu&apos;il est
                                    éteint.
                                </p>
                            )}
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                C&apos;est la mémoire de travail interne de l&apos;IA issue du tour
                                précédent. Elle s&apos;en sert pour planifier ses prochaines
                                actions, suivre l&apos;état de la scène et maintenir la continuité.
                                Vous pouvez la modifier pour corriger ses suppositions.
                            </p>
                            <Textarea
                                placeholder="Le scratchpad de l'IA est actuellement vide."
                                value={conversation?.scratchpad || ''}
                                readOnly={!scratchpadEnabled}
                                onChange={(e) => {
                                    if (activeConversationId && scratchpadEnabled) {
                                        useChatStore
                                            .getState()
                                            .updateScratchpad(activeConversationId, e.target.value);
                                    }
                                }}
                                className={`flex-1 resize-none text-sm p-3 bg-muted/30 border-border/50 focus-visible:ring-primary/20 font-mono ${
                                    scratchpadEnabled ? '' : 'opacity-60'
                                }`}
                            />
                        </div>
                    )}

                    {/* === STYLE TAB === */}
                    {activeTab === 'style' && (
                        <div className="flex flex-col flex-1 min-h-0 p-4 space-y-4 overflow-y-auto">
                            <div className="flex items-center gap-2 text-sm font-medium text-primary">
                                <Feather className="w-4 h-4" />
                                Garde-style (anti-cliché)
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                Analysez vos dernières réponses IA pour repérer les habitudes
                                répétitives ou clichées. Gardez les suggestions qui vous conviennent
                                — elles sont injectées dans le prompt comme motifs à éviter, pour
                                cette conversation uniquement.
                            </p>
                            <Button
                                onClick={handleAnalyzeStyle}
                                disabled={isAnalyzingStyle}
                                size="sm"
                                className="gap-2 self-start"
                            >
                                {isAnalyzingStyle ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <Sparkles className="w-3.5 h-3.5" />
                                )}
                                Analyser mon style
                            </Button>

                            {styleSuggestions.length > 0 && (
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs font-medium text-muted-foreground">
                                            Suggestions — modifiez avant d&apos;ajouter
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 text-xs"
                                            onClick={addAllBanRules}
                                        >
                                            Tout ajouter
                                        </Button>
                                    </div>
                                    {styleSuggestions.map((rule, i) => (
                                        <div
                                            key={i}
                                            className="flex items-center gap-2 p-2 rounded-md bg-muted/30 border border-border/40"
                                        >
                                            <Input
                                                value={rule}
                                                onChange={(e) => editSuggestion(i, e.target.value)}
                                                className="flex-1 h-8 text-xs"
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') acceptSuggestion(i);
                                                }}
                                            />
                                            <button
                                                onClick={() => acceptSuggestion(i)}
                                                className="text-primary hover:text-primary/70 shrink-0 pointer-coarse:p-2"
                                                title="Ajouter à la liste d'interdits"
                                            >
                                                <Plus className="w-3.5 h-3.5" />
                                            </button>
                                            <button
                                                onClick={() => dismissSuggestion(i)}
                                                className="text-muted-foreground hover:text-foreground shrink-0 pointer-coarse:p-2"
                                                title="Ignorer"
                                            >
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="space-y-2">
                                <span className="text-xs font-medium text-muted-foreground">
                                    Liste d&apos;interdits active ({activeBanList.length})
                                </span>
                                {activeBanList.length === 0 ? (
                                    <p className="text-xs text-muted-foreground/70 italic">
                                        Aucune règle pour l&apos;instant — analysez votre style ou
                                        ajoutez-en une ci-dessous.
                                    </p>
                                ) : (
                                    activeBanList.map((rule, i) => (
                                        <div
                                            key={i}
                                            className="flex items-start gap-2 p-2 rounded-md bg-background/40 border border-border/40"
                                        >
                                            <span className="flex-1 text-xs leading-relaxed">
                                                {rule}
                                            </span>
                                            <button
                                                onClick={() => removeBanRule(rule)}
                                                className="text-muted-foreground hover:text-destructive shrink-0 pointer-coarse:p-2"
                                                title="Retirer"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    ))
                                )}
                                <div className="flex gap-2 pt-1">
                                    <Input
                                        value={newBanRule}
                                        onChange={(e) => setNewBanRule(e.target.value)}
                                        placeholder="Ajouter une règle manuellement…"
                                        className="h-8 text-xs"
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                addBanRule(newBanRule);
                                                setNewBanRule('');
                                            }
                                        }}
                                    />
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        className="h-8"
                                        onClick={() => {
                                            addBanRule(newBanRule);
                                            setNewBanRule('');
                                        }}
                                    >
                                        Ajouter
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* === SUMMARIES TAB === */}
                    {activeTab === 'summaries' && (
                        <div className="flex flex-col flex-1 min-h-0">
                            {/* Search bar */}
                            <div className="px-4 pt-3 pb-1 shrink-0">
                                <div className="relative">
                                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                                    <Input
                                        placeholder="Rechercher des résumés…"
                                        value={summarySearchTerm}
                                        onChange={(e) => setSummarySearchTerm(e.target.value)}
                                        className="pl-8 h-8 text-xs bg-background/40 border-border/40"
                                    />
                                    {summarySearchTerm && (
                                        <button
                                            onClick={() => setSummarySearchTerm('')}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto">
                                <div className="p-4 space-y-2">
                                    {isLoadingRag ? (
                                        <div className="flex items-center justify-center py-12">
                                            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                        </div>
                                    ) : summaries.length === 0 ? (
                                        <div className="text-center py-8">
                                            <Layers className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                                            <p className="text-sm text-muted-foreground">
                                                Aucun résumé pour l&apos;instant
                                            </p>
                                            <p className="text-xs text-muted-foreground/70 mt-1">
                                                La chronique se construit toute seule : un Fragment
                                                tous les ~10 messages, une Section tous les 5
                                                Fragments, un Arc toutes les 3 Sections.
                                            </p>
                                        </div>
                                    ) : (
                                        summaries
                                            .filter((summary) => {
                                                if (!summarySearchTerm.trim()) return true;
                                                const term = summarySearchTerm.toLowerCase();
                                                return (
                                                    summary.content.toLowerCase().includes(term) ||
                                                    summary.keyFacts.some((kf) =>
                                                        kf.toLowerCase().includes(term)
                                                    )
                                                );
                                            })
                                            .sort(
                                                (a, b) =>
                                                    b.level - a.level || b.createdAt - a.createdAt
                                            )
                                            .map((summary) => (
                                                <div
                                                    key={summary.id}
                                                    className="p-3 rounded-lg bg-muted/30 border border-border/30 group transition-all space-y-1.5"
                                                >
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span
                                                            className={cn(
                                                                'text-[9px] font-bold px-1.5 py-0.5 rounded border',
                                                                getLevelColor(summary.level)
                                                            )}
                                                        >
                                                            {getLevelLabel(summary.level)}
                                                        </span>
                                                        {/* Ranges are stored 0-based with an
                                                            exclusive end; showing them raw read
                                                            as "msgs 0–10" for the first ten. */}
                                                        <span className="text-[9px] text-muted-foreground">
                                                            messages {summary.messageRange[0] + 1} à{' '}
                                                            {summary.messageRange[1]}
                                                        </span>
                                                        {summary.isManuallyEdited && (
                                                            <span className="text-[9px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400">
                                                                modifié à la main
                                                            </span>
                                                        )}
                                                    </div>

                                                    {editingSummaryId === summary.id ? (
                                                        <div className="space-y-2">
                                                            <Textarea
                                                                value={summaryEditValue}
                                                                onChange={(e) =>
                                                                    setSummaryEditValue(
                                                                        e.target.value
                                                                    )
                                                                }
                                                                className="text-xs min-h-[140px]"
                                                                autoFocus
                                                            />
                                                            <div className="flex gap-2">
                                                                <Button
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    className="flex-1 h-7 text-xs"
                                                                    onClick={() => {
                                                                        setEditingSummaryId(null);
                                                                        setSummaryEditValue('');
                                                                    }}
                                                                >
                                                                    Annuler
                                                                </Button>
                                                                <Button
                                                                    size="sm"
                                                                    className="flex-1 h-7 text-xs"
                                                                    onClick={() =>
                                                                        handleSaveSummaryEdit(
                                                                            summary.id
                                                                        )
                                                                    }
                                                                >
                                                                    Enregistrer
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <p className="text-xs leading-relaxed whitespace-pre-wrap">
                                                                {summary.content}
                                                            </p>

                                                            {summary.keyFacts.length > 0 && (
                                                                <button
                                                                    onClick={() =>
                                                                        setExpandedSummaryIds(
                                                                            (prev) => {
                                                                                const next =
                                                                                    new Set(prev);
                                                                                if (
                                                                                    next.has(
                                                                                        summary.id
                                                                                    )
                                                                                )
                                                                                    next.delete(
                                                                                        summary.id
                                                                                    );
                                                                                else
                                                                                    next.add(
                                                                                        summary.id
                                                                                    );
                                                                                return next;
                                                                            }
                                                                        )
                                                                    }
                                                                    className="text-[10px] text-muted-foreground hover:text-foreground"
                                                                >
                                                                    {expandedSummaryIds.has(
                                                                        summary.id
                                                                    )
                                                                        ? '▾ '
                                                                        : '▸ '}
                                                                    {summary.keyFacts.length} fait
                                                                    {summary.keyFacts.length > 1
                                                                        ? 's'
                                                                        : ''}{' '}
                                                                    clé
                                                                    {summary.keyFacts.length > 1
                                                                        ? 's'
                                                                        : ''}
                                                                </button>
                                                            )}
                                                            {expandedSummaryIds.has(summary.id) && (
                                                                <ul className="text-[10px] text-muted-foreground space-y-0.5 pl-3">
                                                                    {summary.keyFacts.map(
                                                                        (kf, i) => (
                                                                            <li key={i}>• {kf}</li>
                                                                        )
                                                                    )}
                                                                </ul>
                                                            )}

                                                            <div className="flex items-center gap-1 pt-0.5">
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-6 w-6 opacity-60 hover:opacity-100"
                                                                    title="Modifier ce résumé"
                                                                    onClick={() => {
                                                                        setEditingSummaryId(
                                                                            summary.id
                                                                        );
                                                                        setSummaryEditValue(
                                                                            summary.content
                                                                        );
                                                                    }}
                                                                >
                                                                    <Edit2 className="w-3 h-3" />
                                                                </Button>
                                                                {/* L0 fragments are built from
                                                                    raw messages, not from child
                                                                    summaries — nothing to
                                                                    regenerate them from here. */}
                                                                {summary.level > 0 && (
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        className="h-6 w-6 opacity-60 hover:opacity-100"
                                                                        title="Régénérer depuis les résumés enfants"
                                                                        disabled={
                                                                            regeneratingSummaryId !==
                                                                            null
                                                                        }
                                                                        onClick={() =>
                                                                            handleRegenerateSummary(
                                                                                summary
                                                                            )
                                                                        }
                                                                    >
                                                                        {regeneratingSummaryId ===
                                                                        summary.id ? (
                                                                            <Loader2 className="w-3 h-3 animate-spin" />
                                                                        ) : (
                                                                            <Sparkles className="w-3 h-3" />
                                                                        )}
                                                                    </Button>
                                                                )}
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-6 w-6 ml-auto opacity-60 hover:opacity-100 hover:bg-destructive/10"
                                                                    title="Supprimer"
                                                                    onClick={() =>
                                                                        handleDeleteSummary(
                                                                            summary.id
                                                                        )
                                                                    }
                                                                >
                                                                    <Trash2 className="w-3 h-3 text-destructive" />
                                                                </Button>
                                                            </div>
                                                        </>
                                                    )}
                                                </div>
                                            ))
                                    )}
                                </div>
                            </div>

                            {/* Reindex button */}
                            <div className="p-3 border-t bg-muted/10 shrink-0 space-y-2">
                                {reindexProgress && (
                                    <p className="text-xs text-muted-foreground text-center">
                                        {reindexProgress}
                                    </p>
                                )}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="w-full gap-2 text-xs"
                                    onClick={() => setConfirmReindex(true)}
                                    disabled={isReindexing}
                                >
                                    {isReindexing ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                        <RefreshCw className="w-3.5 h-3.5" />
                                    )}
                                    {isReindexing ? 'Réindexation…' : 'Réindexer la conversation'}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Delete Confirmation Dialog (Notes) */}
                <Dialog
                    open={confirmDeleteIndex !== null}
                    onOpenChange={() => setConfirmDeleteIndex(null)}
                >
                    <DialogContent className="sm:max-w-[350px]">
                        <DialogHeader>
                            <DialogTitle>Supprimer le souvenir ?</DialogTitle>
                            <DialogDescription>Cette action est irréversible.</DialogDescription>
                        </DialogHeader>
                        <DialogFooter className="flex-row gap-2">
                            <Button
                                variant="ghost"
                                className="flex-1"
                                onClick={() => setConfirmDeleteIndex(null)}
                            >
                                Annuler
                            </Button>
                            <Button
                                variant="destructive"
                                className="flex-1"
                                onClick={() =>
                                    confirmDeleteIndex !== null &&
                                    handleDeleteMemory(confirmDeleteIndex)
                                }
                            >
                                Supprimer
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                {/* Reindex confirmation — a full rebuild destroys hand-written summaries, so
                    it must say how many before doing it. */}
                <Dialog open={confirmReindex} onOpenChange={setConfirmReindex}>
                    <DialogContent className="sm:max-w-[380px]">
                        <DialogHeader>
                            <DialogTitle>Reconstruire toute la chronique ?</DialogTitle>
                            <DialogDescription>
                                Les {summaries.length} résumés actuels seront supprimés puis
                                régénérés depuis les messages.
                                {manuallyEditedCount > 0 && (
                                    <span className="block mt-2 text-amber-400">
                                        ⚠️ {manuallyEditedCount} résumé
                                        {manuallyEditedCount > 1
                                            ? 's que vous avez modifiés'
                                            : ' que vous avez modifié'}{' '}
                                        à la main{' '}
                                        {manuallyEditedCount > 1 ? 'seront perdus' : 'sera perdu'}.
                                    </span>
                                )}
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter className="flex-row gap-2">
                            <Button
                                variant="ghost"
                                className="flex-1"
                                onClick={() => setConfirmReindex(false)}
                            >
                                Annuler
                            </Button>
                            <Button
                                variant="destructive"
                                className="flex-1"
                                onClick={() => {
                                    setConfirmReindex(false);
                                    handleReindex();
                                }}
                            >
                                Reconstruire
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </div>
    );
}
