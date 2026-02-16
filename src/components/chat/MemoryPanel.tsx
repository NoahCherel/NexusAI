'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
    Brain,
    Plus,
    Trash2,
    Sparkles,
    Loader2,
    X,
    Edit2,
    Database,
    Layers,
    RefreshCw,
} from 'lucide-react';
import { useCharacterStore } from '@/stores/character-store';
import { useChatStore } from '@/stores/chat-store';
import { generateMemorySummary, formatMemoryEntry } from '@/lib/memory-summarizer';
import { cn } from '@/lib/utils';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { getFactsByConversation, getSummariesByConversation, deleteFactsByConversation, saveFactsBatch } from '@/lib/db';
import type { WorldFact, MemorySummary } from '@/types/rag';
import { useSettingsStore } from '@/stores/settings-store';
import { decryptApiKey } from '@/lib/crypto';

interface MemoryPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

type TabType = 'notes' | 'facts' | 'summaries';

export function MemoryPanel({ isOpen, onClose }: MemoryPanelProps) {
    const { getActiveCharacter, updateLongTermMemory } = useCharacterStore();
    const { getActiveBranchMessages, conversations, activeConversationId, updateConversationNotes } = useChatStore();

    const character = getActiveCharacter();
    const [activeTab, setActiveTab] = useState<TabType>('notes');
    const [newMemory, setNewMemory] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [editValue, setEditValue] = useState('');
    const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);

    // RAG data state
    const [facts, setFacts] = useState<WorldFact[]>([]);
    const [summaries, setSummaries] = useState<MemorySummary[]>([]);
    const [isLoadingRag, setIsLoadingRag] = useState(false);
    const [confirmClearFacts, setConfirmClearFacts] = useState(false);
    const [deletingFactIds, setDeletingFactIds] = useState<Set<string>>(new Set());
    const [isReindexing, setIsReindexing] = useState(false);
    const [reindexProgress, setReindexProgress] = useState('');
    const [isMergingFacts, setIsMergingFacts] = useState(false);
    const [mergeResult, setMergeResult] = useState('');

    // Load RAG data when tab changes
    const loadRagData = useCallback(async () => {
        if (!activeConversationId) return;
        setIsLoadingRag(true);
        try {
            const [loadedFacts, loadedSummaries] = await Promise.all([
                getFactsByConversation(activeConversationId),
                getSummariesByConversation(activeConversationId),
            ]);
            setFacts(loadedFacts);
            setSummaries(loadedSummaries);
        } catch (err) {
            console.error('[MemoryPanel] Failed to load RAG data:', err);
        } finally {
            setIsLoadingRag(false);
        }
    }, [activeConversationId]);

    useEffect(() => {
        if (isOpen && (activeTab === 'facts' || activeTab === 'summaries')) {
            loadRagData();
        }
    }, [isOpen, activeTab, loadRagData]);

    if (!character) return null;

    // Use conversation-scoped notes (with fallback to character-level for backward compat)
    const conversation = conversations.find((c) => c.id === activeConversationId);
    const memories = conversation?.notes || [];

    const handleAddMemory = async () => {
        if (!newMemory.trim() || !activeConversationId) return;
        const formattedEntry = formatMemoryEntry(newMemory.trim());
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

    const handleGenerateSummary = async () => {
        if (!conversation || !activeConversationId) return;
        setIsGenerating(true);
        try {
            const msgs = getActiveBranchMessages(activeConversationId);
            const formattedMessages = msgs.map((m) => ({
                role: m.role,
                content: m.content,
            }));
            const summary = await generateMemorySummary(
                formattedMessages,
                conversation.worldState,
                character.name
            );
            const formattedEntry = formatMemoryEntry(summary);
            const updated = [...memories, formattedEntry];
            updateConversationNotes(activeConversationId, updated);
        } catch (error) {
            console.error('Failed to generate summary:', error);
        } finally {
            setIsGenerating(false);
        }
    };

    const handleDeleteFact = async (factId: string) => {
        setDeletingFactIds(prev => new Set(prev).add(factId));
        try {
            const { initDB } = await import('@/lib/db');
            const db = await initDB();
            await db.delete('facts', factId);
            setFacts(prev => prev.filter(f => f.id !== factId));
        } catch (err) {
            console.error('[MemoryPanel] Failed to delete fact:', err);
        } finally {
            setDeletingFactIds(prev => {
                const next = new Set(prev);
                next.delete(factId);
                return next;
            });
        }
    };

    const handleClearAllFacts = async () => {
        if (!activeConversationId) return;
        try {
            await deleteFactsByConversation(activeConversationId);
            setFacts([]);
            setConfirmClearFacts(false);
        } catch (err) {
            console.error('[MemoryPanel] Failed to clear facts:', err);
        }
    };

    const handleMergeFacts = async () => {
        if (facts.length < 2 || isMergingFacts) return;
        setIsMergingFacts(true);
        setMergeResult('');
        try {
            const { mergeRelatedFacts } = await import('@/lib/ai/fact-extractor');
            const { embedText } = await import('@/lib/ai/embedding-service');
            const { initDB } = await import('@/lib/db');

            const { mergedFacts, deletedIds, clusterCount } = mergeRelatedFacts(facts, 0.7);

            if (clusterCount === 0) {
                setMergeResult('No similar facts found to merge.');
                return;
            }

            const db = await initDB();

            // Delete old facts
            const tx = db.transaction('facts', 'readwrite');
            for (const id of deletedIds) {
                await tx.store.delete(id);
            }
            await tx.done;

            // Create new merged facts with embeddings
            const newFacts: WorldFact[] = await Promise.all(
                mergedFacts.map(async (f) => ({
                    ...f,
                    id: crypto.randomUUID(),
                    embedding: await embedText(f.fact),
                }))
            );

            await saveFactsBatch(newFacts);

            setMergeResult(`Merged ${deletedIds.length} facts into ${newFacts.length} (${clusterCount} clusters)`);
            await loadRagData();
        } catch (err) {
            console.error('[MemoryPanel] Merge failed:', err);
            setMergeResult('Merge failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
        } finally {
            setIsMergingFacts(false);
            setTimeout(() => setMergeResult(''), 4000);
        }
    };

    const handleDeleteSummary = async (summaryId: string) => {
        try {
            const { initDB } = await import('@/lib/db');
            const db = await initDB();
            await db.delete('summaries', summaryId);
            setSummaries(prev => prev.filter(s => s.id !== summaryId));
        } catch (err) {
            console.error('[MemoryPanel] Failed to delete summary:', err);
        }
    };

    const handleReindex = async () => {
        if (!activeConversationId || !character || isReindexing) return;
        setIsReindexing(true);
        setReindexProgress('Starting full reindex...');

        try {
            const msgs = getActiveBranchMessages(activeConversationId);
            if (msgs.length === 0) {
                setReindexProgress('No messages to index.');
                setIsReindexing(false);
                return;
            }

            // Get API key
            const { apiKeys } = useSettingsStore.getState();
            const orConfig = apiKeys.find(k => k.provider === 'openrouter');
            let apiKey = '';
            if (orConfig) {
                apiKey = await decryptApiKey(orConfig.encryptedKey) || '';
            }
            if (!apiKey) {
                setReindexProgress('Error: No API key found.');
                setIsReindexing(false);
                return;
            }

            const { embedText } = await import('@/lib/ai/embedding-service');
            const { indexMessageChunk } = await import('@/lib/ai/rag-service');
            const { createSummary, shouldCreateL1Summary, getL0SummariesForL1, shouldCreateL2Summary, getL1SummariesForL2 } = await import('@/lib/ai/hierarchical-summarizer');
            const { buildL0Prompt, buildL1Prompt, buildL2Prompt, SUMMARIZATION_PROMPT_L0, SUMMARIZATION_PROMPT_L1, SUMMARIZATION_PROMPT_L2, parseSummarizationResponse } = await import('@/lib/ai/hierarchical-summarizer');
            const { deduplicateFacts } = await import('@/lib/ai/fact-extractor');
            const { saveFactsBatch, getSummariesByConversation: getSummaries, getFactsByConversation: getFacts, deleteSummariesByConversation, deleteVectorsByConversation } = await import('@/lib/db');
            const { getActivePersona } = await import('@/stores/settings-store').then(m => {
                const state = m.useSettingsStore.getState();
                return { getActivePersona: () => state.personas.find(p => p.id === state.activePersonaId) };
            });

            const activePersona = getActivePersona();
            const userName = activePersona?.name || 'You';

            // Clear all existing summaries and vectors for a clean rebuild
            setReindexProgress('Clearing old summaries and vectors...');
            await deleteSummariesByConversation(activeConversationId);
            await deleteVectorsByConversation(activeConversationId);

            // Process all messages in chunks of 10
            const chunkSize = 10;
            const totalToProcess = Math.floor(msgs.length / chunkSize);

            if (totalToProcess <= 0) {
                setReindexProgress('Not enough messages for a summary chunk (need at least 10).');
                await loadRagData();
                setIsReindexing(false);
                return;
            }

            setReindexProgress(`Processing ${totalToProcess} chunks of 10 messages...`);

            for (let i = 0; i < totalToProcess; i++) {
                const startIdx = i * chunkSize;
                const chunk = msgs.slice(startIdx, startIdx + chunkSize);
                if (chunk.length < chunkSize) break;

                setReindexProgress(`Summarizing chunk ${i + 1}/${totalToProcess}...`);

                // Create L0 summary
                const prompt = buildL0Prompt(chunk, character.name, userName);
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: prompt }],
                        provider: 'openrouter',
                        model: 'meta-llama/llama-3.3-70b-instruct:free',
                        apiKey,
                        systemPrompt: SUMMARIZATION_PROMPT_L0,
                        temperature: 0.3,
                        maxTokens: 2000,
                    }),
                });

                if (response.ok) {
                    const reader = response.body?.getReader();
                    const decoder = new TextDecoder();
                    let text = '';
                    if (reader) {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            text += decoder.decode(value, { stream: true });
                        }
                        text += decoder.decode(); // Flush remaining bytes
                    }
                    const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                    const parsed = parseSummarizationResponse(cleanText);
                    if (parsed) {
                        const embedding = await embedText(parsed.summary);
                        await createSummary(activeConversationId, 0, parsed.summary, parsed.keyFacts, [startIdx, startIdx + chunk.length], [], embedding);
                        await indexMessageChunk(chunk, activeConversationId, parsed.summary, {
                            characters: [character.name],
                            importance: 5,
                        });

                        // Extract facts from key facts
                        if (parsed.keyFacts.length > 0) {
                            const existingFacts = await getFacts(activeConversationId);
                            const newFacts = parsed.keyFacts.map(kf => ({
                                conversationId: activeConversationId,
                                messageId: chunk[chunk.length - 1].id,
                                fact: kf,
                                category: 'event' as const,
                                importance: 5,
                                active: true,
                                timestamp: Date.now(),
                                relatedEntities: [] as string[],
                                lastAccessedAt: Date.now(),
                                accessCount: 0,
                            }));
                            const deduped = deduplicateFacts(newFacts, existingFacts);
                            if (deduped.length > 0) {
                                const factsWithIds = await Promise.all(deduped.map(async f => ({
                                    ...f,
                                    id: crypto.randomUUID(),
                                    embedding: await embedText(f.fact),
                                })));
                                await saveFactsBatch(factsWithIds);
                            }
                        }
                    } else {
                        console.warn(`[Reindex] Chunk ${i + 1}: failed to parse summary response`);
                    }
                } else {
                    console.warn(`[Reindex] Chunk ${i + 1} failed with status ${response.status}`);
                }

                // Small delay between chunks to avoid rate limiting
                await new Promise(r => setTimeout(r, 1000));
            }

            // Create L1 summaries (loop to handle multiple batches)
            setReindexProgress('Creating higher-level summaries...');
            let currentSummaries = await getSummaries(activeConversationId);

            while (shouldCreateL1Summary(currentSummaries)) {
                const l0s = getL0SummariesForL1(currentSummaries);
                if (!l0s) break;
                const l1Prompt = buildL1Prompt(l0s);
                const l1Response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: l1Prompt }],
                        provider: 'openrouter',
                        model: 'meta-llama/llama-3.3-70b-instruct:free',
                        apiKey,
                        systemPrompt: SUMMARIZATION_PROMPT_L1,
                        temperature: 0.3,
                        maxTokens: 2000,
                    }),
                });
                if (l1Response.ok) {
                    const reader = l1Response.body?.getReader();
                    const decoder = new TextDecoder();
                    let text = '';
                    if (reader) {
                        while (true) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
                        text += decoder.decode(); // Flush remaining bytes
                    }
                    const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                    const parsed = parseSummarizationResponse(cleanText);
                    if (parsed) {
                        const range: [number, number] = [Math.min(...l0s.map(s => s.messageRange[0])), Math.max(...l0s.map(s => s.messageRange[1]))];
                        const embedding = await embedText(parsed.summary);
                        await createSummary(activeConversationId, 1, parsed.summary, parsed.keyFacts, range, l0s.map(s => s.id), embedding);
                    } else {
                        console.warn('[Reindex] L1 summary: failed to parse response');
                    }
                } else {
                    console.warn(`[Reindex] L1 summary failed with status ${l1Response.status}`);
                    break;
                }
                currentSummaries = await getSummaries(activeConversationId);
                await new Promise(r => setTimeout(r, 1000));
            }

            // Create L2 summaries (loop to handle multiple batches)
            currentSummaries = await getSummaries(activeConversationId);
            while (shouldCreateL2Summary(currentSummaries)) {
                const l1s = getL1SummariesForL2(currentSummaries);
                if (!l1s) break;
                const l2Prompt = buildL2Prompt(l1s);
                const l2Response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: l2Prompt }],
                        provider: 'openrouter',
                        model: 'meta-llama/llama-3.3-70b-instruct:free',
                        apiKey,
                        systemPrompt: SUMMARIZATION_PROMPT_L2,
                        temperature: 0.3,
                        maxTokens: 2000,
                    }),
                });
                if (l2Response.ok) {
                    const reader = l2Response.body?.getReader();
                    const decoder = new TextDecoder();
                    let text = '';
                    if (reader) {
                        while (true) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
                        text += decoder.decode(); // Flush remaining bytes
                    }
                    const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                    const parsed = parseSummarizationResponse(cleanText);
                    if (parsed) {
                        const range: [number, number] = [Math.min(...l1s.map(s => s.messageRange[0])), Math.max(...l1s.map(s => s.messageRange[1]))];
                        const embedding = await embedText(parsed.summary);
                        await createSummary(activeConversationId, 2, parsed.summary, parsed.keyFacts, range, l1s.map(s => s.id), embedding);
                    } else {
                        console.warn('[Reindex] L2 summary: failed to parse response');
                    }
                } else {
                    console.warn(`[Reindex] L2 summary failed with status ${l2Response.status}`);
                    break;
                }
                currentSummaries = await getSummaries(activeConversationId);
                await new Promise(r => setTimeout(r, 1000));
            }

            setReindexProgress('Reindexing complete!');
            await loadRagData();
        } catch (err) {
            console.error('[MemoryPanel] Reindex failed:', err);
            setReindexProgress(`Error: ${err instanceof Error ? err.message : 'Reindex failed'}`);
        } finally {
            setTimeout(() => {
                setIsReindexing(false);
                setReindexProgress('');
            }, 3000);
        }
    };

    if (!isOpen) return null;

    const getCategoryColor = (cat: string) => {
        const colors: Record<string, string> = {
            event: 'text-blue-400 bg-blue-500/10',
            relationship: 'text-pink-400 bg-pink-500/10',
            item: 'text-amber-400 bg-amber-500/10',
            location: 'text-green-400 bg-green-500/10',
            lore: 'text-purple-400 bg-purple-500/10',
            consequence: 'text-red-400 bg-red-500/10',
            dialogue: 'text-cyan-400 bg-cyan-500/10',
        };
        return colors[cat] || 'text-indigo-400 bg-indigo-500/10'; // Custom categories get indigo
    };

    const getLevelLabel = (level: number) => {
        const labels = ['Chunk (L0)', 'Section (L1)', 'Arc (L2)'];
        return labels[level] || `Level ${level}`;
    };

    const getLevelColor = (level: number) => {
        const colors = [
            'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
            'text-blue-400 bg-blue-500/10 border-blue-500/20',
            'text-purple-400 bg-purple-500/10 border-purple-500/20',
        ];
        return colors[level] || 'text-muted-foreground bg-muted/20 border-border/20';
    };

    const tabs: { key: TabType; label: string; icon: typeof Brain; count?: number }[] = [
        { key: 'notes', label: 'Notes', icon: Brain, count: memories.length },
        { key: 'facts', label: 'Facts', icon: Database, count: facts.length },
        { key: 'summaries', label: 'Summaries', icon: Layers, count: summaries.length },
    ];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-lg mx-4 bg-background border border-border/50 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b bg-muted/30 shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                            <Brain className="w-5 h-5 text-primary" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="font-bold text-sm truncate">Memory & Knowledge</h2>
                            <p className="text-xs text-muted-foreground truncate">
                                {conversation?.title || character.name} — conversation memory
                            </p>
                        </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 shrink-0">
                        <X className="w-4 h-4" />
                    </Button>
                </div>

                {/* Tabs */}
                <div className="flex border-b bg-muted/10 shrink-0">
                    {tabs.map(tab => (
                        <button
                            key={tab.key}
                            onClick={() => setActiveTab(tab.key)}
                            className={cn(
                                'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors relative',
                                activeTab === tab.key
                                    ? 'text-foreground'
                                    : 'text-muted-foreground hover:text-foreground/70'
                            )}
                        >
                            <tab.icon className="w-3.5 h-3.5" />
                            <span>{tab.label}</span>
                            {tab.count !== undefined && tab.count > 0 && (
                                <span className={cn(
                                    'text-[9px] px-1.5 py-0.5 rounded-full font-bold',
                                    activeTab === tab.key
                                        ? 'bg-primary/15 text-primary'
                                        : 'bg-muted text-muted-foreground'
                                )}>
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
                                            <p className="text-sm text-muted-foreground">No memories yet</p>
                                            <p className="text-xs text-muted-foreground/70 mt-1">
                                                Add notes or generate AI summaries
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
                                                            onChange={(e) => setEditValue(e.target.value)}
                                                            className="text-xs min-h-[80px]"
                                                            autoFocus
                                                        />
                                                        <div className="flex justify-end gap-2">
                                                            <Button variant="ghost" size="sm" onClick={() => setEditingIndex(null)} className="h-7 text-[10px]">Cancel</Button>
                                                            <Button size="sm" onClick={() => handleUpdateMemory(index)} className="h-7 text-[10px]">Save</Button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div
                                                        className="flex items-start justify-between cursor-pointer"
                                                        onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
                                                    >
                                                        <p className={cn('text-xs flex-1 pr-2 leading-relaxed', expandedIndex !== index && 'line-clamp-2')}>
                                                            {memory}
                                                        </p>
                                                        <div className="flex items-center gap-1 shrink-0">
                                                            <Button
                                                                variant="ghost" size="icon"
                                                                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                                                onClick={(e) => { e.stopPropagation(); setEditValue(memory); setEditingIndex(index); }}
                                                            >
                                                                <Edit2 className="w-3 h-3 text-muted-foreground" />
                                                            </Button>
                                                            <Button
                                                                variant="ghost" size="icon"
                                                                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10"
                                                                onClick={(e) => { e.stopPropagation(); setConfirmDeleteIndex(index); }}
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
                                    placeholder="Add a memory note..."
                                    value={newMemory}
                                    onChange={(e) => setNewMemory(e.target.value)}
                                    className="min-h-[60px] resize-none text-sm"
                                />
                                <div className="flex gap-2">
                                    <Button onClick={handleAddMemory} disabled={!newMemory.trim()} size="sm" className="flex-1 gap-2">
                                        <Plus className="w-3.5 h-3.5" />
                                        Add Note
                                    </Button>
                                    <Button onClick={handleGenerateSummary} disabled={isGenerating || !conversation} variant="outline" size="sm" className="flex-1 gap-2">
                                        {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                        AI Summary
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* === FACTS TAB === */}
                    {activeTab === 'facts' && (
                        <div className="flex flex-col flex-1 min-h-0">
                            <div className="flex-1 overflow-y-auto">
                                <div className="p-4 space-y-2">
                                    {isLoadingRag ? (
                                        <div className="flex items-center justify-center py-12">
                                            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                        </div>
                                    ) : facts.length === 0 ? (
                                        <div className="text-center py-8">
                                            <Database className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                                            <p className="text-sm text-muted-foreground">No extracted facts</p>
                                            <p className="text-xs text-muted-foreground/70 mt-1">
                                                Facts are auto-extracted from conversations
                                            </p>
                                        </div>
                                    ) : (
                                        facts
                                            .sort((a, b) => b.importance - a.importance)
                                            .map((fact) => (
                                                <div key={fact.id} className="p-3 rounded-lg bg-muted/30 border border-border/30 group transition-all space-y-1.5">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <p className="text-xs flex-1 leading-relaxed">{fact.fact}</p>
                                                        <Button
                                                            variant="ghost" size="icon"
                                                            className="h-6 w-6 shrink-0 opacity-50 hover:opacity-100 transition-opacity hover:bg-destructive/10"
                                                            onClick={() => handleDeleteFact(fact.id)}
                                                            disabled={deletingFactIds.has(fact.id)}
                                                        >
                                                            {deletingFactIds.has(fact.id)
                                                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                                                : <Trash2 className="w-3 h-3 text-destructive" />
                                                            }
                                                        </Button>
                                                    </div>
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded', getCategoryColor(fact.category))}>
                                                            {fact.category}
                                                        </span>
                                                        <span className="text-[9px] text-muted-foreground">
                                                            imp: {fact.importance}/10
                                                        </span>
                                                        {fact.relatedEntities.slice(0, 3).map((entity, i) => (
                                                            <span key={i} className="text-[9px] text-muted-foreground/70 bg-muted/50 px-1 py-0.5 rounded">
                                                                {entity}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))
                                    )}
                                </div>
                            </div>

                            {/* Merge & Clear facts */}
                            {facts.length > 0 && (
                                <div className="p-3 border-t bg-muted/10 shrink-0 space-y-2">
                                    {mergeResult && (
                                        <p className="text-xs text-muted-foreground text-center">{mergeResult}</p>
                                    )}
                                    <div className="flex gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="flex-1 gap-2 text-xs"
                                            onClick={handleMergeFacts}
                                            disabled={isMergingFacts || facts.length < 2}
                                        >
                                            {isMergingFacts ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                            Merge Similar
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="flex-1 gap-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/20"
                                            onClick={() => setConfirmClearFacts(true)}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                            Clear All ({facts.length})
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* === SUMMARIES TAB === */}
                    {activeTab === 'summaries' && (
                        <div className="flex flex-col flex-1 min-h-0">
                            <div className="flex-1 overflow-y-auto">
                                <div className="p-4 space-y-2">
                                    {isLoadingRag ? (
                                        <div className="flex items-center justify-center py-12">
                                            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                        </div>
                                    ) : summaries.length === 0 ? (
                                        <div className="text-center py-8">
                                            <Layers className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
                                            <p className="text-sm text-muted-foreground">No summaries yet</p>
                                            <p className="text-xs text-muted-foreground/70 mt-1">
                                                Summaries are auto-created every 10 messages
                                            </p>
                                        </div>
                                    ) : (
                                        summaries
                                            .sort((a, b) => b.level - a.level || b.createdAt - a.createdAt)
                                            .map((summary) => (
                                                <div key={summary.id} className="p-3 rounded-lg bg-muted/30 border border-border/30 group transition-all space-y-1.5">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                                <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded border', getLevelColor(summary.level))}>
                                                                    {getLevelLabel(summary.level)}
                                                                </span>
                                                                <span className="text-[9px] text-muted-foreground">
                                                                    msgs {summary.messageRange[0]}–{summary.messageRange[1]}
                                                                </span>
                                                            </div>
                                                            <p className="text-xs leading-relaxed">{summary.content}</p>
                                                        </div>
                                                        <Button
                                                            variant="ghost" size="icon"
                                                            className="h-6 w-6 shrink-0 opacity-50 hover:opacity-100 transition-opacity hover:bg-destructive/10"
                                                            onClick={() => handleDeleteSummary(summary.id)}
                                                        >
                                                            <Trash2 className="w-3 h-3 text-destructive" />
                                                        </Button>
                                                    </div>
                                                </div>
                                            ))
                                    )}
                                </div>
                            </div>

                            {/* Reindex button */}
                            <div className="p-3 border-t bg-muted/10 shrink-0 space-y-2">
                                {reindexProgress && (
                                    <p className="text-xs text-muted-foreground text-center">{reindexProgress}</p>
                                )}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="w-full gap-2 text-xs"
                                    onClick={handleReindex}
                                    disabled={isReindexing}
                                >
                                    {isReindexing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                                    {isReindexing ? 'Reindexing...' : 'Reindex Conversation'}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Delete Confirmation Dialog (Notes) */}
                <Dialog open={confirmDeleteIndex !== null} onOpenChange={() => setConfirmDeleteIndex(null)}>
                    <DialogContent className="sm:max-w-[350px]">
                        <DialogHeader>
                            <DialogTitle>Delete Memory?</DialogTitle>
                            <DialogDescription>This action cannot be undone.</DialogDescription>
                        </DialogHeader>
                        <DialogFooter className="flex-row gap-2">
                            <Button variant="ghost" className="flex-1" onClick={() => setConfirmDeleteIndex(null)}>Cancel</Button>
                            <Button variant="destructive" className="flex-1" onClick={() => confirmDeleteIndex !== null && handleDeleteMemory(confirmDeleteIndex)}>Delete</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                {/* Clear All Facts Confirmation */}
                <Dialog open={confirmClearFacts} onOpenChange={setConfirmClearFacts}>
                    <DialogContent className="sm:max-w-[350px]">
                        <DialogHeader>
                            <DialogTitle>Clear All Facts?</DialogTitle>
                            <DialogDescription>
                                This will delete {facts.length} extracted facts. This cannot be undone.
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter className="flex-row gap-2">
                            <Button variant="ghost" className="flex-1" onClick={() => setConfirmClearFacts(false)}>Cancel</Button>
                            <Button variant="destructive" className="flex-1" onClick={handleClearAllFacts}>Clear All</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </div>
    );
}
