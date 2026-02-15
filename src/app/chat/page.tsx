'use client';

import { useRef, useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings2, Sparkles, GitBranch, Brain, MoreVertical, Edit, Trash2, Download, Upload, Users, Eye, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Message as CAMessage } from '@/types';
import {
    ChatBubble,
    ChatInput,
    WorldStatePanel,
    PersonaSelector,
    ModelSelector,
    ContextPreviewPanel,
} from '@/components/chat';
import { SettingsPanel, CharacterPanel } from '@/components/layout';
import { CharacterEditor } from '@/components/character';
import { useCharacterStore, useSettingsStore, useChatStore, useLorebookStore } from '@/stores';
import { useNotificationStore } from '@/components/ui/api-notification';
import { useWorldStateAnalyzer } from '@/hooks';
import { decryptApiKey } from '@/lib/crypto';
import { parseStreamingChunk, normalizeCoT } from '@/lib/ai/cot-middleware';
import { buildSystemPrompt, getActiveLorebookEntries, buildRAGEnhancedPayload } from '@/lib/ai/context-builder';
import { LorebookEditor } from '@/components/lorebook';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from '@/components/ui/sheet';
import { Book, Globe2Icon } from 'lucide-react';
import { TreeVisualization } from '@/components/chat/TreeVisualization';
import { MemoryPanel } from '@/components/chat/MemoryPanel';
import { LandingPage } from '@/components/chat/LandingPage';
import { useAppInitialization } from '@/hooks/useAppInitialization';
import { extractLorebookEntries } from '@/lib/lorebook-extractor';
import { APINotificationToast } from '@/components/ui/api-notification';
import { retrieveRelevantContext, hybridLorebookSearch, indexMessageChunk, buildContextPreview } from '@/lib/ai/rag-service';
import { embedText } from '@/lib/ai/embedding-service';
import { countTokens } from '@/lib/tokenizer';
import {
    shouldCreateL0Summary,
    shouldCreateL1Summary,
    shouldCreateL2Summary,
    getNextChunkToSummarize,
    getL0SummariesForL1,
    getL1SummariesForL2,
    parseSummarizationResponse,
    buildL0Prompt,
    buildL1Prompt,
    buildL2Prompt,
    createSummary,
    DEFAULT_CHUNK_SIZE,
    SUMMARIZATION_PROMPT_L0,
    SUMMARIZATION_PROMPT_L1,
    SUMMARIZATION_PROMPT_L2,
} from '@/lib/ai/hierarchical-summarizer';
import { FACT_EXTRACTION_PROMPT, parseFactExtractionResponse, buildFactExtractionPrompt, deduplicateFacts, buildFactExtractionSystemPrompt } from '@/lib/ai/fact-extractor';
import { getAdaptiveChunkSize } from '@/lib/ai/message-quality';
import { deriveWorldStateUpdates, applyWorldStateUpdate } from '@/lib/ai/world-state-updater';
import { saveFactsBatch, getFactsByConversation, getSummariesByConversation } from '@/lib/db';
import type { ContextSection, WorldFact } from '@/types/rag';
import type { Message } from '@/types';

export default function ChatPage() {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isWorldStateCollapsed, setIsWorldStateCollapsed] = useState(false);
    const [isLorebookOpen, setIsLorebookOpen] = useState(false);
    const [isTreeOpen, setIsTreeOpen] = useState(false);
    const [isMemoryOpen, setIsMemoryOpen] = useState(false);
    const [isWorldStateSheetOpen, setIsWorldStateSheetOpen] = useState(false);
    const [isWorldStateDialogOpen, setIsWorldStateDialogOpen] = useState(false);
    const [currentApiKey, setCurrentApiKey] = useState<string | null>(null);
    const [isCharacterEditorOpen, setIsCharacterEditorOpen] = useState(false);

    // Context preview state
    const [isContextPreviewOpen, setIsContextPreviewOpen] = useState(false);
    const [contextPreviewData, setContextPreviewData] = useState<{
        sections: ContextSection[];
        totalTokens: number;
        maxTokens: number;
        maxOutputTokens: number;
        warnings: string[];
        includedMessages: number;
        droppedMessages: number;
    } | null>(null);

    // Draft message from ChatInput (for context preview)
    const draftMessageRef = useRef('');

    // Initialize IndexedDB and load data
    useAppInitialization();

    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const lastSummarizedCount = useRef(0); // Track last summarized message count
    const { getActiveCharacter, removeCharacter, updateCharacter, addCharacter } = useCharacterStore();
    const {
        conversations,
        activeConversationId,
        createConversation,
        // updateWorldState,
        addMessage,
        updateMessage,
        getActiveBranchMessages,
        getMessageSiblingsInfo,
        navigateToSibling,
        setActiveConversation,
        deleteMessage,
        isLoading: isLoadingConversations,
        loadedCharacterId,
        messages: storeMessages, // Get raw messages for reactivity
    } = useChatStore();
    const { activeLorebook, setActiveLorebook } = useLorebookStore();

    // Get active messages from store - depends on raw messages for reactivity
    const messages = useMemo(
        () => (activeConversationId ? getActiveBranchMessages(activeConversationId) : []),
        [activeConversationId, getActiveBranchMessages, storeMessages] // storeMessages triggers re-render
    );

    // Message pagination: only display last N messages, with "Load More" button
    const MESSAGE_PAGE_SIZE = 200;
    const [displayLimit, setDisplayLimit] = useState(MESSAGE_PAGE_SIZE);
    const displayedMessages = useMemo(() => {
        if (messages.length <= displayLimit) return messages;
        return messages.slice(messages.length - displayLimit);
    }, [messages, displayLimit]);
    const hasMoreMessages = messages.length > displayLimit;
    const hiddenMessageCount = Math.max(0, messages.length - displayLimit);

    // Reset display limit when switching conversations
    useEffect(() => {
        setDisplayLimit(MESSAGE_PAGE_SIZE);
    }, [activeConversationId]);

    const { analyzeMessage, isAnalyzing } = useWorldStateAnalyzer();
    const {
        apiKeys,
        activeProvider,
        activeModel,
        temperature,
        showThoughts,
        showWorldState,
        activePersonaId,
        personas,
        enableReasoning,
        immersiveMode,
        getActivePreset,
    } = useSettingsStore();
    const character = getActiveCharacter();

    // Get current world state from active conversation
    const currentConversation = conversations.find((c) => c.id === activeConversationId);
    const worldState = currentConversation?.worldState || {
        inventory: [],
        location: '',
        relationships: {},
    };

    // Get decrypted API key on mount/change
    useEffect(() => {
        const loadApiKey = async () => {
            const keyConfig = apiKeys.find((k) => k.provider === activeProvider);
            if (keyConfig) {
                try {
                    const decrypted = await decryptApiKey(keyConfig.encryptedKey);
                    setCurrentApiKey(decrypted);
                } catch {
                    setCurrentApiKey(null);
                }
            } else {
                setCurrentApiKey(null);
            }
        };
        loadApiKey();
    }, [apiKeys, activeProvider]);

    // Auto-scroll to bottom when switching conversations or loading
    useEffect(() => {
        if (activeConversationId) {
            // Small delay to ensure content is rendered
            setTimeout(() => {
                scrollRef.current?.scrollIntoView({ behavior: 'instant' });
            }, 100);
        }
    }, [activeConversationId]);

    // Sync lorebook when character changes
    useEffect(() => {
        if (character) {
            if (character.character_book) {
                setActiveLorebook(character.character_book, character.id);
            } else {
                setActiveLorebook({ entries: [] }, character.id);
            }
        }
    }, [character, setActiveLorebook]);

    // Initialize conversation when character changes
    useEffect(() => {
        const initConversation = async () => {
            // Wait for store to be synced with current character
            if (!character || isLoadingConversations || loadedCharacterId !== character.id) {
                return;
            }

            // Check if we already have a valid active conversation for this character
            const currentConv = conversations.find((c) => c.id === activeConversationId);
            if (currentConv && currentConv.characterId === character.id) {
                return;
            }

            // Try to find an existing conversation for this character
            // The store's loadConversations should have already tried to set activeConversationId from localStorage
            // But if it failed or wasn't set, we pick the most recent one
            const characterConvs = conversations
                .filter((c) => c.characterId === character.id)
                .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

            if (characterConvs.length > 0) {
                setActiveConversation(characterConvs[0].id);
            } else {
                const newId = await createConversation(character.id, `Chat with ${character.name}`);

                if (character.first_mes) {
                    addMessage({
                        id: crypto.randomUUID(),
                        conversationId: newId,
                        parentId: null,
                        role: 'assistant',
                        content: character.first_mes,
                        isActiveBranch: true,
                        createdAt: new Date(),
                        messageOrder: 1,
                        regenerationIndex: 0,
                    });
                    // Analyze first message for initial world state (delay to allow store to update)
                    const firstMes = character.first_mes;
                    const charName = character.name;
                    // Capture newId for the closure
                    const targetConversationId = newId;

                    setTimeout(() => {
                        if (firstMes) {
                            analyzeMessage(firstMes, charName, targetConversationId);
                        }
                    }, 500);
                }
            }
        };
        initConversation();
    }, [
        character, // Added dependency
        activeConversationId,
        createConversation,
        addMessage,
        conversations,
        analyzeMessage,
        loadedCharacterId,
        isLoadingConversations,
        setActiveConversation,
    ]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    // Hierarchical Auto-Summary & Fact Extraction Logic
    useEffect(() => {
        const { enableHierarchicalSummaries } = useSettingsStore.getState();
        const runHierarchicalSummary = async () => {
            if (!enableHierarchicalSummaries) return;
            if (!character || !activeConversationId || messages.length === 0 || !currentApiKey) return;

            try {
                const existingSummaries = await getSummariesByConversation(activeConversationId);
                const activePersona = personas.find((p) => p.id === activePersonaId);
                const userName = activePersona?.name || 'You';

                // Adaptive chunk size based on message quality/density
                const recentMsgs = messages.slice(-15);
                const adaptiveChunkSize = getAdaptiveChunkSize(
                    recentMsgs.map(m => ({ role: m.role, content: m.content })),
                    DEFAULT_CHUNK_SIZE
                );

                // Check L0 (chunk summary with adaptive frequency)
                if (shouldCreateL0Summary(messages.length, existingSummaries, adaptiveChunkSize)) {
                    const chunk = getNextChunkToSummarize(messages, existingSummaries, adaptiveChunkSize);
                    if (chunk) {
                        const l0Index = existingSummaries.filter(s => s.level === 0).length;
                        const startIdx = l0Index * DEFAULT_CHUNK_SIZE;
                        const endIdx = startIdx + chunk.length;

                        console.log(`[RAG] Creating L0 summary for messages ${startIdx}-${endIdx} (adaptive chunk=${adaptiveChunkSize})`);
                        lastSummarizedCount.current = messages.length;

                        const prompt = buildL0Prompt(chunk, character.name, userName);

                        const response = await fetch('/api/chat', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                messages: [{ role: 'user', content: prompt }],
                                provider: 'openrouter',
                                model: 'deepseek/deepseek-r1-0528:free',
                                apiKey: currentApiKey,
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
                            }

                            const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                            const parsed = parseSummarizationResponse(cleanText);

                            if (parsed) {
                                const embedding = await embedText(parsed.summary);
                                const summary = await createSummary(
                                    activeConversationId,
                                    0,
                                    parsed.summary,
                                    parsed.keyFacts,
                                    [startIdx, endIdx],
                                    [],
                                    embedding
                                );

                                // Also index as a vector chunk for retrieval (with branch path)
                                const branchPath = messages.map(m => m.id);
                                await indexMessageChunk(chunk, activeConversationId, parsed.summary, {
                                    characters: [character.name],
                                    location: worldState.location,
                                    importance: 5,
                                }, branchPath);

                                // Extract facts from key facts
                                if (parsed.keyFacts.length > 0) {
                                    const existingFacts = await getFactsByConversation(activeConversationId);
                                    const newFacts: Omit<WorldFact, 'id' | 'embedding'>[] = parsed.keyFacts.map(kf => ({
                                        conversationId: activeConversationId,
                                        messageId: chunk[chunk.length - 1].id,
                                        fact: kf,
                                        category: 'event' as const,
                                        importance: 5,
                                        active: true,
                                        timestamp: Date.now(),
                                        relatedEntities: [],
                                        lastAccessedAt: Date.now(),
                                        accessCount: 0,
                                    }));

                                    const deduped = deduplicateFacts(newFacts, existingFacts);
                                    if (deduped.length > 0) {
                                        const factsWithIds: WorldFact[] = deduped.map(f => ({
                                            ...f,
                                            id: crypto.randomUUID(),
                                            embedding: [],
                                            branchPath,
                                        }));

                                        // Embed facts in background
                                        for (const fact of factsWithIds) {
                                            fact.embedding = await embedText(fact.fact);
                                        }

                                        await saveFactsBatch(factsWithIds);
                                    }
                                }

                                console.log('[RAG] L0 summary created:', summary.id);
                            }
                        }

                    }
                }

                // Check L1 (section summary from L0s)
                const updatedSummaries = await getSummariesByConversation(activeConversationId);
                if (shouldCreateL1Summary(updatedSummaries)) {
                    const l0s = getL0SummariesForL1(updatedSummaries);
                    if (l0s) {
                        console.log('[RAG] Creating L1 summary from', l0s.length, 'L0 summaries');
                        const prompt = buildL1Prompt(l0s);

                        const response = await fetch('/api/chat', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                messages: [{ role: 'user', content: prompt }],
                                provider: 'openrouter',
                                model: 'deepseek/deepseek-r1-0528:free',
                                apiKey: currentApiKey,
                                systemPrompt: SUMMARIZATION_PROMPT_L1,
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
                            }

                            const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                            const parsed = parseSummarizationResponse(cleanText);
                            if (parsed) {
                                const range: [number, number] = [
                                    Math.min(...l0s.map(s => s.messageRange[0])),
                                    Math.max(...l0s.map(s => s.messageRange[1])),
                                ];
                                const embedding = await embedText(parsed.summary);
                                await createSummary(activeConversationId, 1, parsed.summary, parsed.keyFacts, range, l0s.map(s => s.id), embedding);
                                console.log('[RAG] L1 summary created');
                            }
                        }
                    }
                }

                // Check L2 (arc summary from L1s)
                const finalSummaries = await getSummariesByConversation(activeConversationId);
                if (shouldCreateL2Summary(finalSummaries)) {
                    const l1s = getL1SummariesForL2(finalSummaries);
                    if (l1s) {
                        console.log('[RAG] Creating L2 arc summary from', l1s.length, 'L1 summaries');
                        const prompt = buildL2Prompt(l1s);

                        const response = await fetch('/api/chat', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                messages: [{ role: 'user', content: prompt }],
                                provider: 'openrouter',
                                model: 'deepseek/deepseek-r1-0528:free',
                                apiKey: currentApiKey,
                                systemPrompt: SUMMARIZATION_PROMPT_L2,
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
                            }

                            const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                            const parsed = parseSummarizationResponse(cleanText);
                            if (parsed) {
                                const range: [number, number] = [
                                    Math.min(...l1s.map(s => s.messageRange[0])),
                                    Math.max(...l1s.map(s => s.messageRange[1])),
                                ];
                                const embedding = await embedText(parsed.summary);
                                await createSummary(activeConversationId, 2, parsed.summary, parsed.keyFacts, range, l1s.map(s => s.id), embedding);
                                console.log('[RAG] L2 arc summary created');
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('[RAG] Hierarchical summary error:', error);
            }
        };

        runHierarchicalSummary();
    }, [messages, character, activeConversationId, currentApiKey, updateCharacter, personas, activePersonaId, worldState.location]);

    const triggerAiReponse = async (
        history: CAMessage[],
        options: {
            isImpersonation?: boolean;
            prefill?: string;
            skipFactExtraction?: boolean;
        } = {}
    ) => {
        if (!currentApiKey || !character) return;
        setIsLoading(true);

        // Stop any previous request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        abortControllerRef.current = new AbortController();

        const activePreset = getActivePreset();
        const activePersona = personas.find((p) => p.id === activePersonaId);

        // 1. Calculate Active Lorebook Entries (hybrid: keyword + semantic)
        const useLorebooks = activePreset?.useLorebooks ?? true;
        const lorebookTokenBudget = activePreset?.lorebookTokenBudget ?? 2000;
        
        let activeEntries;
        const lastUserMsg = history[history.length - 1]?.content || '';
        
        if (useLorebooks && activeLorebook?.entries && activeLorebook.entries.length > 0) {
            try {
                const queryEmbedding = await embedText(lastUserMsg);
                activeEntries = await hybridLorebookSearch(
                    lastUserMsg,
                    queryEmbedding,
                    activeLorebook.entries,
                    history.map((m) => ({
                        ...m,
                        conversationId: '',
                        parentId: null,
                        isActiveBranch: true,
                        createdAt: new Date(),
                    })) as unknown as CAMessage[],
                    {
                        scanDepth: activePreset?.lorebookScanDepth,
                        tokenBudget: lorebookTokenBudget,
                        matchWholeWords: activePreset?.matchWholeWords,
                    }
                );
            } catch (err) {
                console.warn('[RAG] Hybrid lorebook search failed, falling back:', err);
                activeEntries = getActiveLorebookEntries(
                    history.map((m) => ({
                        ...m,
                        conversationId: '',
                        parentId: null,
                        isActiveBranch: true,
                        createdAt: new Date(),
                    })) as unknown as CAMessage[],
                    activeLorebook || undefined,
                    {
                        scanDepth: activePreset?.lorebookScanDepth,
                        tokenBudget: lorebookTokenBudget,
                        recursive: activePreset?.lorebookRecursiveScanning,
                        matchWholeWords: activePreset?.matchWholeWords,
                    }
                );
            }
        } else {
            activeEntries = useLorebooks
                ? getActiveLorebookEntries(
                    history.map((m) => ({
                        ...m,
                        conversationId: '',
                        parentId: null,
                        isActiveBranch: true,
                        createdAt: new Date(),
                    })) as unknown as CAMessage[],
                    activeLorebook || undefined,
                    {
                        scanDepth: activePreset?.lorebookScanDepth,
                        tokenBudget: lorebookTokenBudget,
                        recursive: activePreset?.lorebookRecursiveScanning,
                        matchWholeWords: activePreset?.matchWholeWords,
                    }
                )
                : [];
        }

        // 2. Build Enhanced System Prompt
        // Combine conversation-scoped notes with character-level memory
        const currentConv = conversations.find(c => c.id === activeConversationId);
        const combinedMemory = [...(currentConv?.notes || []), ...(character.longTermMemory || [])];
        let systemPrompt = buildSystemPrompt(character, worldState, activeEntries, {
            template: activePreset?.systemPromptTemplate,
            preHistory: activePreset?.preHistoryInstructions,
            postHistory: activePreset?.postHistoryInstructions,
            userPersona: activePersona,
            longTermMemory: combinedMemory,
            recentMessages: history,
            excludePostHistory: true,
        });

        // Handle Impersonation System Prompt Override
        if (options.isImpersonation) {
            const impersonationInstruction =
                activePreset?.impersonationPrompt ||
                'Write the next message for {{user}}. Stay in character as {{user}}. Do not respond as the AI/Assistant.';

            const resolvedImpersonation = impersonationInstruction.replace(
                /{{user}}/gi,
                activePersona?.name || 'User'
            );

            systemPrompt += `\n\n[SYSTEM: ${resolvedImpersonation}]`;
        }

        // 3. RAG: Retrieve relevant context
        const { enableRAGRetrieval, enableFactExtraction, minRAGConfidence } = useSettingsStore.getState();
        const maxContextTokens = activePreset?.maxContextTokens ?? 16384;
        const maxOutputTokens = activePreset?.maxOutputTokens ?? 2048;
        const systemTokens = countTokens(systemPrompt);
        const proportionalBudget = Math.floor((maxContextTokens - systemTokens - maxOutputTokens) * 0.25);
        const minimumBudget = Math.floor(maxContextTokens * 0.15);
        const ragBudget = Math.max(proportionalBudget, minimumBudget);

        let ragSections: ContextSection[] = [];
        if (enableRAGRetrieval && activeConversationId && ragBudget > 50) {
            try {
                // Pass active branch message IDs for branch-aware filtering
                const activeBranchIds = messages.map(m => m.id);
                ragSections = await retrieveRelevantContext(
                    lastUserMsg,
                    activeConversationId,
                    ragBudget,
                    { worldState, activeBranchMessageIds: activeBranchIds, minConfidence: minRAGConfidence }
                );
            } catch (err) {
                console.warn('[RAG] Context retrieval failed:', err);
            }
        }

        // 4. Build RAG-enhanced payload with proper token budgeting
        const {
            messagesPayload,
            includedMessageCount,
            droppedMessageCount,
            tokenBreakdown,
        } = buildRAGEnhancedPayload(systemPrompt, ragSections, history as CAMessage[], {
            maxContextTokens,
            maxOutputTokens,
            postHistoryInstructions: activePreset?.postHistoryInstructions,
            assistantPrefill: options.prefill,
            activeProvider,
        });

        if (droppedMessageCount > 0) {
            console.log(`[RAG] Context: ${includedMessageCount} msgs included, ${droppedMessageCount} truncated. Tokens: sys=${tokenBreakdown.system} rag=${tokenBreakdown.rag} hist=${tokenBreakdown.history} total=${tokenBreakdown.total}`);
        }

        // 5. Prepare Target Message (Assistant or User)
        const targetRole = options.isImpersonation ? 'user' : 'assistant';
        const targetId = crypto.randomUUID();

        // Initialize content state
        const initialContent = options.prefill || '';
        let fullContent = initialContent;

        if (activeConversationId) {
            addMessage({
                id: targetId,
                conversationId: activeConversationId,
                parentId: history[history.length - 1]?.id || null,
                role: targetRole,
                content: initialContent,
                isActiveBranch: true,
                createdAt: new Date(),
                messageOrder: history.length + 1,
                regenerationIndex: 0,
            });
        }

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: messagesPayload,
                    provider: activeProvider,
                    model: activeModel,
                    apiKey: currentApiKey,
                    // Extended Parameters
                    temperature: activePreset?.temperature ?? temperature,
                    maxTokens: activePreset?.maxOutputTokens ?? 2048,
                    topP: activePreset?.topP,
                    topK: activePreset?.topK,
                    frequencyPenalty: activePreset?.frequencyPenalty,
                    presencePenalty: activePreset?.presencePenalty,
                    repetitionPenalty: activePreset?.repetitionPenalty,
                    minP: activePreset?.minP,
                    stoppingStrings: activePreset?.stoppingStrings,
                    // Context
                    // System prompt is now in messages[0]
                    systemInstruction: undefined, // Gemini fallback? No, we use messages.
                    enableReasoning: activePreset?.enableReasoning ?? enableReasoning,
                }),
                signal: abortControllerRef.current.signal,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `API Error: ${response.status} ${response.statusText}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader');

            const decoder = new TextDecoder();

            // If we have a prefill that WASN'T sent to API, we start with it.
            // If it WAS sent (Anthropic), the stream typically continues AFTER it.
            // If it WAS sent, we don't want to duplicate it.
            // Safest: Always maintain `fullContent` state.
            let fullContent = initialContent;
            let assistantThought = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });

                // For providers where we DID sends prefill, the chunk acts as continuation.
                // For providers where we DID NOT, the chunk is the whole start.
                // We just append chunk to what we have?
                // Yes, unless OpenAI hallucinates the prefill at start.

                // Special handling for thoughts:
                const parsed = parseStreamingChunk(chunk, activeProvider);
                if (parsed.thoughtContent) assistantThought += parsed.thoughtContent;
                if (parsed.visibleContent) fullContent += parsed.visibleContent;

                // Update the message in store
                updateMessage(targetId, {
                    content: fullContent,
                    thought: assistantThought || undefined,
                });
            }

            // Final parse
            const finalResult = normalizeCoT(fullContent, activeProvider);
            // Check if we need to preserve thought accumulated vs returned?
            // normalizeCoT re-parses whole string.
            // If we used prefill, fullContent has prefill.

            updateMessage(targetId, {
                content: finalResult.content,
                thought: finalResult.thought || assistantThought || undefined,
            });

            // Analyze state logic (Background)
            if (character) {
                // If impersonating, analyze the NEW User message
                if (options.isImpersonation) {
                    analyzeMessage(fullContent, activePersona?.name || 'User');
                } else {
                    // Normal flow
                    const lastUserMsg = history[history.length - 1];
                    if (lastUserMsg && lastUserMsg.role === 'user') {
                        analyzeMessage(lastUserMsg.content, character.name);
                    }
                    if (fullContent) {
                        analyzeMessage(fullContent, character.name);
                    }
                }

                // Lorebook extraction is now handled in handleSend on the previous message

                // RAG: Background fact extraction from the AI response (skip on regeneration)
                if (enableFactExtraction && activeConversationId && fullContent && !options.skipFactExtraction) {
                    (async () => {
                        try {
                            const factPrompt = buildFactExtractionPrompt(
                                fullContent,
                                worldState,
                                character.name,
                                activePersona?.name || 'User'
                            );

                            const openRouterKey = await (async () => {
                                const orConfig = apiKeys.find(k => k.provider === 'openrouter');
                                if (!orConfig) return currentApiKey;
                                return await decryptApiKey(orConfig.encryptedKey) || currentApiKey;
                            })();

                            const { customFactCategories } = useSettingsStore.getState();
                            const factSystemPrompt = customFactCategories.length > 0
                                ? buildFactExtractionSystemPrompt(customFactCategories)
                                : FACT_EXTRACTION_PROMPT;

                            const factResponse = await fetch('/api/chat', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    messages: [{ role: 'user', content: factPrompt }],
                                    provider: 'openrouter',
                                    model: 'meta-llama/llama-3.3-70b-instruct:free',
                                    apiKey: openRouterKey,
                                    systemPrompt: factSystemPrompt,
                                    temperature: 0.2,
                                    maxTokens: 2000,
                                }),
                            });

                            if (factResponse.ok) {
                                const reader = factResponse.body?.getReader();
                                const decoder = new TextDecoder();
                                let factText = '';
                                if (reader) {
                                    while (true) {
                                        const { done, value } = await reader.read();
                                        if (done) break;
                                        factText += decoder.decode(value, { stream: true });
                                    }
                                }

                                const cleanFactText = factText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                                const extractedFacts = parseFactExtractionResponse(
                                    cleanFactText,
                                    activeConversationId,
                                    targetId
                                );

                                if (extractedFacts.length > 0) {
                                    const existingFacts = await getFactsByConversation(activeConversationId);
                                    const deduped = deduplicateFacts(extractedFacts, existingFacts);

                                    if (deduped.length > 0) {
                                        // Tag facts with active branch path for branch-aware retrieval
                                        const branchPath = messages.map(m => m.id);
                                        const factsWithIds: WorldFact[] = [];
                                        for (const f of deduped) {
                                            const emb = await embedText(f.fact);
                                            factsWithIds.push({
                                                ...f,
                                                id: crypto.randomUUID(),
                                                embedding: emb,
                                                branchPath,
                                            });
                                        }
                                        await saveFactsBatch(factsWithIds);
                                        console.log(`[RAG] Extracted ${factsWithIds.length} facts from response`);

                                        // Auto-update world state from extracted facts
                                        try {
                                            const activePersona = personas.find(p => p.id === activePersonaId);
                                            const wsUpdates = deriveWorldStateUpdates(
                                                factsWithIds,
                                                worldState,
                                                character.name,
                                                activePersona?.name || 'You'
                                            );
                                            const wsChanges = applyWorldStateUpdate(worldState, wsUpdates);
                                            if (wsChanges && activeConversationId) {
                                                useChatStore.getState().updateWorldState(activeConversationId, wsChanges);
                                                console.log('[RAG] Auto world state update:', wsChanges);
                                            }
                                        } catch (wsErr) {
                                            console.warn('[RAG] Auto world state update failed:', wsErr);
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            console.error('[RAG] Fact extraction failed:', err);
                        }
                    })();
                }
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return;
            }

            const { addNotification, updateNotification } = useNotificationStore.getState();
            const notifId = addNotification('Failed to generate response', 'world');
            updateNotification(
                notifId,
                'error',
                error instanceof Error ? error.message : 'Unknown error'
            );

            if (activeConversationId) {
                updateMessage(targetId, {
                    content:
                        fullContent +
                        `\n[Error: ${error instanceof Error ? error.message : 'Failed to get response. Check API Key or Network.'}]`,
                });
            }
        } finally {
            setIsLoading(false);
            abortControllerRef.current = null;
        }
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            setIsLoading(false);
        }
    };

    const handleShowSettings = () => {
        setIsSettingsOpen(true);
    };

    const handleForceAnalysis = async () => {
        if (!character || messages.length === 0 || !activeConversationId) return;

        // Get the last message to analyze
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage) return;

        await analyzeMessage(lastMessage.content, character.name, activeConversationId, true);
    };

    const handleSend = async (userMessage: string) => {
        if (!activeConversationId || !character) return;

        // Lorebook extraction on the PREVIOUS assistant message (the one the user is confirming by replying)
        // This ensures only the active regeneration branch gets extracted
        const { lorebookAutoExtract } = useSettingsStore.getState();
        if (lorebookAutoExtract && activeLorebook && messages.length > 0) {
            const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
            if (lastAssistantMsg?.content) {
                const existingKeys = activeLorebook.entries.flatMap((e) => e.keys);
                extractLorebookEntries(lastAssistantMsg.content, existingKeys)
                    .then((newEntries) => {
                        if (newEntries.length > 0) {
                            const { addSuggestions } = useLorebookStore.getState();
                            addSuggestions(
                                newEntries.map((e) => ({
                                    keys: e.keys,
                                    content: e.content,
                                    category: e.category,
                                }))
                            );
                        }
                    })
                    .catch((err) => console.error('Lorebook extraction failed:', err));
            }
        }

        const lastParams = messages.length > 0 ? messages[messages.length - 1] : null;

        const newUserMessage: Message = {
            id: crypto.randomUUID(),
            conversationId: activeConversationId,
            parentId: lastParams?.id || null,
            role: 'user',
            content: userMessage,
            isActiveBranch: true,
            createdAt: new Date(),
            messageOrder: messages.length + 1,
            regenerationIndex: 0,
        };

        addMessage(newUserMessage);

        const activePreset = getActivePreset();
        const prefill = activePreset?.assistantPrefill || undefined;

        // Construct history for API (include the new message)
        const history = [...messages, newUserMessage];
        await triggerAiReponse(history, { prefill });
    };

    // Context Preview handler - builds a preview of what would be sent
    const handleContextPreview = async () => {
        if (!character || !activeConversationId || !currentApiKey) return;

        const activePreset = getActivePreset();
        const activePersona = personas.find((p) => p.id === activePersonaId);

        // Simulate what would be sent, including any draft message in the input
        const draftText = draftMessageRef.current?.trim() || '';
        const simulatedMessages = draftText
            ? [
                ...messages,
                {
                    id: 'draft-preview',
                    conversationId: activeConversationId,
                    parentId: messages[messages.length - 1]?.id || null,
                    role: 'user' as const,
                    content: draftText,
                    isActiveBranch: true,
                    createdAt: new Date(),
                    messageOrder: messages.length + 1,
                    regenerationIndex: 0,
                },
            ]
            : messages;

        // Build system prompt
        const useLorebooks = activePreset?.useLorebooks ?? true;
        const lorebookTokenBudget = activePreset?.lorebookTokenBudget ?? 2000;
        const activeEntries = useLorebooks
            ? getActiveLorebookEntries(
                simulatedMessages.map((m) => ({
                    ...m,
                    conversationId: '',
                    parentId: null,
                    isActiveBranch: true,
                    createdAt: new Date(),
                })) as unknown as CAMessage[],
                activeLorebook || undefined,
                {
                    scanDepth: activePreset?.lorebookScanDepth,
                    tokenBudget: lorebookTokenBudget,
                    recursive: activePreset?.lorebookRecursiveScanning,
                    matchWholeWords: activePreset?.matchWholeWords,
                }
            )
            : [];

        const conv = conversations.find(c => c.id === activeConversationId);
        const combinedMem = [...(conv?.notes || []), ...(character.longTermMemory || [])];
        const systemPrompt = buildSystemPrompt(character, worldState, activeEntries, {
            template: activePreset?.systemPromptTemplate,
            preHistory: activePreset?.preHistoryInstructions,
            postHistory: activePreset?.postHistoryInstructions,
            userPersona: activePersona,
            longTermMemory: combinedMem,
            recentMessages: simulatedMessages,
            excludePostHistory: true,
        });

        const maxContextTokens = activePreset?.maxContextTokens ?? 16384;
        const maxOutputTokens = activePreset?.maxOutputTokens ?? 2048;

        // Get RAG sections
        const systemTokens = countTokens(systemPrompt);
        const proportionalBudget = Math.floor((maxContextTokens - systemTokens - maxOutputTokens) * 0.25);
        const minimumBudget = Math.floor(maxContextTokens * 0.15);
        const ragBudget = Math.max(proportionalBudget, minimumBudget);
        const lastMsg = simulatedMessages[simulatedMessages.length - 1]?.content || '';

        let ragSections: ContextSection[] = [];
        try {
            const { minRAGConfidence: previewMinConf } = useSettingsStore.getState();
            ragSections = await retrieveRelevantContext(lastMsg, activeConversationId, ragBudget, {
                worldState,
                activeBranchMessageIds: simulatedMessages.map(m => m.id),
                minConfidence: previewMinConf,
            });
        } catch (err) {
            console.warn('[Preview] RAG retrieval failed:', err);
        }

        // Build payload
        const {
            messagesPayload,
            includedMessageCount,
            droppedMessageCount,
            tokenBreakdown,
        } = buildRAGEnhancedPayload(systemPrompt, ragSections, simulatedMessages as CAMessage[], {
            maxContextTokens,
            maxOutputTokens,
            postHistoryInstructions: activePreset?.postHistoryInstructions,
            activeProvider,
        });

        // Build preview sections
        const previewData = await buildContextPreview(
            systemPrompt + (ragSections.length > 0 ? '\n\n' + ragSections.map(s => s.content).join('\n\n') : ''),
            ragSections,
            messagesPayload.filter(m => m.role !== 'system'),
            activePreset?.postHistoryInstructions,
            maxContextTokens,
            maxOutputTokens,
            activeEntries
        );

        setContextPreviewData({
            ...previewData,
            maxOutputTokens,
            includedMessages: includedMessageCount,
            droppedMessages: droppedMessageCount,
            warnings: [
                ...previewData.warnings,
                ...(draftText ? [`Draft message included: "${draftText.slice(0, 80)}${draftText.length > 80 ? '...' : ''}"`] : []),
            ],
        });
        setIsContextPreviewOpen(true);
    };

    const handleImpersonate = async (): Promise<string | void> => {
        if (!activeConversationId || isLoading || !currentApiKey || !character) return;

        setIsLoading(true);

        let generatedText = '';

        try {
            const activePreset = getActivePreset();
            const activePersona = personas.find((p) => p.id === activePersonaId);

            // 1. Context
            const useLorebooks = activePreset?.useLorebooks ?? true;
            const activeEntries = useLorebooks
                ? getActiveLorebookEntries(
                    messages.map((m) => ({
                        ...m,
                        conversationId: '',
                        parentId: null,
                        isActiveBranch: true,
                        createdAt: new Date(),
                    })) as unknown as CAMessage[],
                    activeLorebook || undefined,
                    {
                        scanDepth: activePreset?.lorebookScanDepth,
                        tokenBudget: activePreset?.lorebookTokenBudget,
                        recursive: activePreset?.lorebookRecursiveScanning,
                        matchWholeWords: activePreset?.matchWholeWords,
                    }
                )
                : [];

            const impConv = conversations.find(c => c.id === activeConversationId);
            const impMem = [...(impConv?.notes || []), ...(character.longTermMemory || [])];
            let systemPrompt = buildSystemPrompt(character, worldState, activeEntries, {
                template: activePreset?.systemPromptTemplate,
                preHistory: activePreset?.preHistoryInstructions,
                postHistory: activePreset?.postHistoryInstructions,
                userPersona: activePersona,
                longTermMemory: impMem,
                recentMessages: messages, // Pass current messages for context
                excludePostHistory: true,
            });

            // Impersonation Override
            const impersonationInstruction =
                activePreset?.impersonationPrompt ||
                'Write the next message for {{user}}. Stay in character as {{user}}. Do not respond as the AI/Assistant.';
            const resolvedImpersonation = impersonationInstruction.replace(
                /{{user}}/gi,
                activePersona?.name || 'User'
            );
            systemPrompt += `\n\n[SYSTEM: ${resolvedImpersonation}]`;

            // Prepare messages
            const messagesPayload = messages.map(({ role, content }) => ({ role, content }));

            // Inject Post-History as a separate System Message
            if (activePreset?.postHistoryInstructions) {
                messagesPayload.push({ role: 'system', content: activePreset.postHistoryInstructions });
            }

            // Insert System Message at the beginning
            messagesPayload.unshift({ role: 'system', content: systemPrompt });

            // 2. API Call
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: messagesPayload,
                    provider: activeProvider,
                    model: activeModel,
                    apiKey: currentApiKey,
                    temperature: activePreset?.temperature ?? temperature,
                    maxTokens: activePreset?.maxOutputTokens ?? 2048,
                    topP: activePreset?.topP,
                    topK: activePreset?.topK,
                    frequencyPenalty: activePreset?.frequencyPenalty,
                    presencePenalty: activePreset?.presencePenalty,
                    repetitionPenalty: activePreset?.repetitionPenalty,
                    minP: activePreset?.minP,
                    stoppingStrings: activePreset?.stoppingStrings,
                    systemPrompt,
                    userPersona: activePersona,
                    enableReasoning: activePreset?.enableReasoning ?? enableReasoning,
                }),
            });

            if (!response.ok) throw new Error('Impersonation failed');

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader');
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                // We must accumulate the raw text first, because chunk-based parsing
                // of thoughts split across chunks is unreliable.
                generatedText += chunk;
            }

            const final = normalizeCoT(generatedText, activeProvider);
            return final.content;
        } catch (err) {
            console.error('Impersonation error:', err);
        } finally {
            setIsLoading(false);
        }
    };

    const handleRegenerate = async (id: string) => {
        if (!activeConversationId) return;

        // Find the message
        const msgIndex = messages.findIndex((m) => m.id === id);
        if (msgIndex === -1) return;

        const msgToRegen = messages[msgIndex];

        // If regening an assistant message, we use history UP TO that message (excluding it)
        // If regening a user message -> not typically supported unless we fork conversation there.
        // Let's support regening assistant response.

        if (msgToRegen.role === 'assistant') {
            // Create a sibling!
            // Just trigger AI with history up to parent
            const history = messages.slice(0, msgIndex);
            await triggerAiReponse(history, { skipFactExtraction: true });
        }
    };

    const handleContinue = async (id: string) => {
        if (!activeConversationId || !character) return;

        // Find the message
        const msgIndex = messages.findIndex((m) => m.id === id);
        if (msgIndex === -1) return;

        const msgToContinue = messages[msgIndex];

        // Only continue assistant messages
        if (msgToContinue.role !== 'assistant') return;

        // Use the current content as prefill - AI will continue from where it left off
        const prefill = msgToContinue.content + ' ';

        // Get history up to and including this message's parent (the user message before it)
        const history = messages.slice(0, msgIndex);

        // Delete the current message so it can be replaced with the continued version
        deleteMessage(id);

        // Trigger AI with prefill
        await triggerAiReponse(history, { prefill, skipFactExtraction: true });
    };

    const handleEditMessage = (id: string, newContent: string) => {
        updateMessage(id, { content: newContent });
    };

    const handleDeleteMessage = (id: string) => {
        deleteMessage(id);
    };

    const handleBranch = (id: string) => {
        // Logic for branching (for now, simply regenerate from this point)
        handleRegenerate(id);
    };

    // Character actions
    const handleEditCharacter = () => {
        setIsCharacterEditorOpen(true);
    };

    const handleDeleteCharacter = async () => {
        if (!character) return;

        // Count conversations for this character
        const charConvs = conversations.filter((c) => c.characterId === character.id);
        const convCount = charConvs.length;

        const message = convCount > 0
            ? `Are you sure you want to delete ${character.name}?\n\nThis will also delete ${convCount} conversation${convCount > 1 ? 's' : ''} associated with this character.`
            : `Are you sure you want to delete ${character.name}?`;

        if (confirm(message)) {
            // Delete all conversations for this character first
            for (const conv of charConvs) {
                try {
                    const { deleteConversation } = await import('@/lib/db');
                    await deleteConversation(conv.id);
                } catch (err) {
                    console.error('Failed to delete conversation:', err);
                }
            }

            // Then delete the character
            await removeCharacter(character.id);
        }
    };

    const handleExportCharacter = async () => {
        if (!character) return;

        // Find most recent conversation for this character
        const charConvs = conversations
            .filter((c) => c.characterId === character.id)
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

        if (charConvs.length === 0) {
            alert('No conversation found for this character.');
            return;
        }

        const latestConv = charConvs[0];
        const messages = await useChatStore.getState().getConversationMessages(latestConv.id);

        const exportData = {
            character: {
                name: character.name,
                description: character.description,
                personality: character.personality,
                scenario: character.scenario,
                first_mes: character.first_mes,
                mes_example: character.mes_example,
            },
            conversation: {
                title: latestConv.title,
                createdAt: latestConv.createdAt,
                updatedAt: latestConv.updatedAt,
                worldState: latestConv.worldState,
            },
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
                thought: m.thought,
                createdAt: m.createdAt,
                isActiveBranch: m.isActiveBranch,
            })),
            exportedAt: new Date().toISOString(),
        };

        const { exportToJson } = await import('@/lib/export-utils');
        exportToJson(exportData, `Conversation_${character.name}_${new Date().toISOString().split('T')[0]}`);
    };

    const handleImportConversation = async () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';

        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                const data = JSON.parse(text);

                // Validate structure
                if (!data.character || !data.conversation || !Array.isArray(data.messages)) {
                    alert('Invalid conversation export format');
                    return;
                }

                // Check if character already exists by name
                const { useCharacterStore } = await import('@/stores');
                const existingChar = useCharacterStore.getState().characters.find(
                    (c) => c.name === data.character.name
                );

                let characterId: string;

                if (existingChar) {
                    // Use existing character
                    characterId = existingChar.id;
                    if (confirm(`Character "${data.character.name}" already exists. Import conversation for this character?`)) {
                        // Continue with import
                    } else {
                        return;
                    }
                } else {
                    // Create new character from imported data
                    characterId = crypto.randomUUID();
                    const newCharacter = {
                        id: characterId,
                        name: data.character.name,
                        description: data.character.description || '',
                        personality: data.character.personality || '',
                        scenario: data.character.scenario || '',
                        first_mes: data.character.first_mes || '',
                        mes_example: data.character.mes_example || '',
                        createdAt: new Date(),
                    };
                    await addCharacter(newCharacter);
                }

                // Create new conversation
                const convId = await createConversation(
                    characterId,
                    data.conversation.title || `Imported Chat - ${new Date().toLocaleDateString()}`
                );

                // Import messages
                const { useChatStore } = await import('@/stores');
                const chatStore = useChatStore.getState();

                for (let i = 0; i < data.messages.length; i++) {
                    const msg = data.messages[i];
                    chatStore.addMessage({
                        id: crypto.randomUUID(),
                        conversationId: convId,
                        parentId: i > 0 ? null : null, // Simplified - all messages in main branch
                        role: msg.role,
                        content: msg.content,
                        thought: msg.thought,
                        isActiveBranch: true,
                        createdAt: new Date(msg.createdAt || new Date()),
                        messageOrder: i + 1,
                        regenerationIndex: 0,
                    });
                }

                // Update world state if present
                if (data.conversation.worldState) {
                    const { updateWorldState } = useChatStore.getState();
                    updateWorldState(convId, data.conversation.worldState);
                }

                // Switch to the imported conversation
                setActiveConversation(convId);

                alert(`Successfully imported conversation "${data.conversation.title}" with ${data.messages.length} messages!`);
            } catch (error) {
                console.error('Import error:', error);
                alert(`Failed to import conversation: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        };

        input.click();
    };

    // Hydration check
    const [isMounted, setIsMounted] = useState(false);
    useEffect(() => {
        setIsMounted(true);
    }, []);

    if (!isMounted) {
        return null;
    }

    return (
        <div className="flex h-screen bg-background overflow-hidden">
            <main className="flex-1 flex flex-col min-w-0">
                {character ? (
                    <>
                        {/* Header - Hidden in immersive mode */}
                        <AnimatePresence>
                            {!immersiveMode && (
                                <motion.header
                                    initial={{ y: -60, opacity: 0 }}
                                    animate={{ y: 0, opacity: 1 }}
                                    exit={{ y: -60, opacity: 0 }}
                                    transition={{
                                        type: 'spring' as const,
                                        stiffness: 300,
                                        damping: 30,
                                    }}
                                    className="h-14 border-b border-white/5 flex items-center px-4 justify-between glass-heavy sticky top-0 z-30 shrink-0"
                                >
                                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                                        {/* Character Panel Button */}
                                        <CharacterPanel
                                            trigger={
                                                <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8">
                                                    <Users className="h-4 w-4" />
                                                </Button>
                                            }
                                        />
                                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden shrink-0">
                                            {character.avatar ? (
                                                <div className="w-8 h-8 rounded-full overflow-hidden border border-border/50 shrink-0">
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img
                                                        src={character.avatar}
                                                        alt={character.name}
                                                        className="w-full h-full object-cover"
                                                    />
                                                </div>
                                            ) : (
                                                <span className="font-semibold text-xs text-primary">
                                                    {character.name.slice(0, 2).toUpperCase()}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <h2 className="font-semibold text-xs sm:text-sm truncate">
                                                {character.name}
                                            </h2>
                                            <p className="text-[10px] text-muted-foreground truncate opacity-80">
                                                {activeModel}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-1 sm:gap-2">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="shrink-0 h-8 w-8"
                                                >
                                                    <MoreVertical className="h-4 w-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-48">
                                                <DropdownMenuItem onClick={handleEditCharacter}>
                                                    <Edit className="h-4 w-4 mr-2" />
                                                    Edit Character
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={handleImportConversation}>
                                                    <Upload className="h-4 w-4 mr-2" />
                                                    Import Conversation
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={handleExportCharacter}>
                                                    <Download className="h-4 w-4 mr-2" />
                                                    Export Conversation
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    onClick={handleDeleteCharacter}
                                                    className="text-destructive focus:text-destructive"
                                                >
                                                    <Trash2 className="h-4 w-4 mr-2" />
                                                    Delete Character
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setIsSettingsOpen(true)}
                                            className="shrink-0 h-8 w-8"
                                        >
                                            <Settings2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </motion.header>
                            )}
                        </AnimatePresence>

                        <div className="flex-1 flex flex-col min-h-0 relative">
                            {/* Messages Area */}
                            <div className="flex-1 overflow-y-auto w-full scroll-smooth">
                                <div className="max-w-3xl mx-auto p-4 space-y-6 pb-4">
                                    {messages.length === 0 ? (
                                        <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-4 py-20 opacity-50">
                                            <div className="p-4 rounded-full bg-muted/50">
                                                <Sparkles className="h-8 w-8" />
                                            </div>
                                            <p>The story begins here...</p>
                                        </div>
                                    ) : (
                                        <>
                                            {hasMoreMessages && (
                                                <div className="flex justify-center py-4">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => setDisplayLimit(prev => prev + MESSAGE_PAGE_SIZE)}
                                                        className="gap-2 text-xs text-muted-foreground hover:text-foreground"
                                                    >
                                                        <ChevronUp className="h-3.5 w-3.5" />
                                                        Load {Math.min(MESSAGE_PAGE_SIZE, hiddenMessageCount)} more messages ({hiddenMessageCount} hidden)
                                                    </Button>
                                                </div>
                                            )}
                                            {displayedMessages.map((msg) => {
                                            const siblingsInfo = getMessageSiblingsInfo(msg.id);
                                            // Replace {{user}} with persona name for display
                                            const displayContent = msg.content.replace(
                                                /{{user}}/gi,
                                                personas.find((p) => p.id === activePersonaId)
                                                    ?.name || 'You'
                                            );

                                            return (
                                                <ChatBubble
                                                    key={msg.id}
                                                    id={msg.id}
                                                    role={msg.role as 'user' | 'assistant'}
                                                    content={displayContent}
                                                    thought={msg.thought}
                                                    avatar={
                                                        msg.role === 'user'
                                                            ? personas.find(
                                                                (p) => p.id === activePersonaId
                                                            )?.avatar
                                                            : character.avatar
                                                    }
                                                    name={
                                                        msg.role === 'user'
                                                            ? personas.find(
                                                                (p) => p.id === activePersonaId
                                                            )?.name || 'You'
                                                            : character.name
                                                    }
                                                    showThoughts={showThoughts}
                                                    onEdit={handleEditMessage}
                                                    onRegenerate={handleRegenerate}
                                                    onContinue={handleContinue}
                                                    onBranch={handleBranch}
                                                    onDelete={handleDeleteMessage}
                                                    currentBranchIndex={siblingsInfo.currentIndex}
                                                    totalBranches={siblingsInfo.total}
                                                    onNavigateBranch={navigateToSibling}
                                                />
                                            );
                                        })}
                                        </>
                                    )}

                                    <div ref={scrollRef} />
                                </div>
                            </div>
                        </div>

                        {/* Input Area - Floating in immersive mode */}
                        <motion.div
                            layout
                            className={`z-20 ${immersiveMode
                                ? 'absolute bottom-4 left-4 right-4 rounded-2xl glass-heavy shadow-2xl'
                                : 'p-4 border-t border-white/5 glass-heavy'
                                }`}
                        >
                            <div
                                className={`mx-auto w-full space-y-2 ${immersiveMode ? 'p-4 max-w-3xl' : 'max-w-4xl'}`}
                            >
                                {!immersiveMode && (
                                    <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar pb-1">
                                        <PersonaSelector />
                                        <ModelSelector />

                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                            onClick={() => setIsLorebookOpen(true)}
                                            title="Lorebook"
                                        >
                                            <Book className="h-4 w-4" />
                                        </Button>
                                        {/* WorldState Button - Dialog on desktop, Sheet on mobile */}
                                        {showWorldState && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                                onClick={() => {
                                                    // Desktop: open dialog, Mobile: opensheet
                                                    if (window.innerWidth >= 1024) {
                                                        setIsWorldStateDialogOpen(true);
                                                    } else {
                                                        setIsWorldStateSheetOpen(true);
                                                    }
                                                }}
                                                title="World Context"
                                            >
                                                <Globe2Icon className="h-4 w-4" />
                                            </Button>
                                        )}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                            onClick={() => setIsTreeOpen(true)}
                                            title="View Branch Tree"
                                        >
                                            <GitBranch className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                            onClick={() => setIsMemoryOpen(true)}
                                            title="Long-Term Memory"
                                        >
                                            <Brain className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                            onClick={handleContextPreview}
                                            title="Context Preview"
                                        >
                                            <Eye className="h-4 w-4" />
                                        </Button>
                                    </div>
                                )}
                                <ChatInput
                                    onSend={handleSend}
                                    onStop={handleStop}
                                    isLoading={isLoading}
                                    disabled={!currentApiKey}
                                    onImpersonate={handleImpersonate}
                                    onDraftChange={(draft) => { draftMessageRef.current = draft; }}
                                    placeholder={
                                        !currentApiKey
                                            ? 'Missing API Key...'
                                            : `Message for ${character.name}...`
                                    }
                                />
                                {immersiveMode && (
                                    <div className="absolute top-2 right-2">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 opacity-30 hover:opacity-100 transition-opacity"
                                            onClick={() => setIsSettingsOpen(true)}
                                            title="Settings"
                                        >
                                            <Settings2 className="h-3 w-3" />
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    </>
                ) : (
                    <>
                        {/* Header for Landing Page */}
                        <header className="h-14 border-b border-white/5 flex items-center px-4 justify-between glass-heavy sticky top-0 z-30 shrink-0">
                            <div className="flex items-center gap-2">
                                <CharacterPanel
                                    trigger={
                                        <Button variant="ghost" size="icon" className="h-8 w-8">
                                            <Users className="h-4 w-4" />
                                        </Button>
                                    }
                                />
                                <span className="font-bold text-lg">NexusAI</span>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setIsSettingsOpen(true)}
                                className="h-8 w-8"
                            >
                                <Settings2 className="h-4 w-4" />
                            </Button>
                        </header>
                        <LandingPage />
                    </>
                )}
            </main>

            <SettingsPanel open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />

            <Dialog open={isLorebookOpen} onOpenChange={setIsLorebookOpen}>
                <DialogContent className="!max-w-[95vw] !w-[95vw] h-[90vh] p-0 overflow-hidden [&>button]:hidden flex flex-col">
                    <DialogTitle className="sr-only">Lorebook Editor</DialogTitle>
                    <DialogDescription className="sr-only">
                        Edit lorebook entries for this character.
                    </DialogDescription>
                    <LorebookEditor onClose={() => setIsLorebookOpen(false)} />
                </DialogContent>
            </Dialog>

            <TreeVisualization isOpen={isTreeOpen} onClose={() => setIsTreeOpen(false)} />

            <MemoryPanel isOpen={isMemoryOpen} onClose={() => setIsMemoryOpen(false)} />

            {/* Desktop WorldState Dialog */}
            <Dialog open={isWorldStateDialogOpen} onOpenChange={setIsWorldStateDialogOpen}>
                <DialogContent className="!max-w-[600px] !w-[600px] h-[85vh] p-0 overflow-hidden">
                    <DialogTitle className="sr-only">World Context</DialogTitle>
                    <DialogDescription className="sr-only">
                        Track inventory, location, and relationships in the current conversation.
                    </DialogDescription>
                    <div className="flex flex-col h-full">
                        <div className="p-4 border-b">
                            <h2 className="text-lg font-semibold">🌍 World Context</h2>
                            <p className="text-sm text-muted-foreground">
                                Track inventory, relationships, and location
                            </p>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4">
                            <WorldStatePanel
                                inventory={worldState.inventory.map((i) =>
                                    i.replace(
                                        /{{user}}/gi,
                                        personas.find((p) => p.id === activePersonaId)?.name ||
                                        'You'
                                    )
                                )}
                                location={worldState.location.replace(
                                    /{{user}}/gi,
                                    personas.find((p) => p.id === activePersonaId)?.name || 'You'
                                )}
                                relationships={worldState.relationships}
                                isCollapsed={false}
                                onForceAnalyze={() => { handleForceAnalysis(); }}
                                isAnalyzing={isAnalyzing}
                            />
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Mobile WorldState Bottom Sheet */}
            <Sheet open={isWorldStateSheetOpen} onOpenChange={setIsWorldStateSheetOpen}>
                <SheetContent side="bottom" className="h-[70vh] p-0">
                    <SheetHeader className="p-4 border-b">
                        <SheetTitle>🌍 World Context</SheetTitle>
                        <SheetDescription>
                            Track inventory, relationships, and location
                        </SheetDescription>
                    </SheetHeader>
                    <div className="p-4 overflow-y-auto h-[calc(70vh-5rem)]">
                        <WorldStatePanel
                            inventory={worldState.inventory.map((i) =>
                                i.replace(
                                    /{{user}}/gi,
                                    personas.find((p) => p.id === activePersonaId)?.name || 'You'
                                )
                            )}
                            location={worldState.location.replace(
                                /{{user}}/gi,
                                personas.find((p) => p.id === activePersonaId)?.name || 'You'
                            )}
                            relationships={worldState.relationships}
                            isCollapsed={false}
                            onForceAnalyze={() => { handleForceAnalysis(); }}
                            isAnalyzing={isAnalyzing}
                        />
                    </div>
                </SheetContent>
            </Sheet>

            {/* Character Editor Dialog */}
            {character && (
                <CharacterEditor
                    isOpen={isCharacterEditorOpen}
                    onClose={() => setIsCharacterEditorOpen(false)}
                    character={character}
                />
            )}

            <APINotificationToast />

            {/* Context Preview Panel */}
            {contextPreviewData && (
                <ContextPreviewPanel
                    isOpen={isContextPreviewOpen}
                    onClose={() => setIsContextPreviewOpen(false)}
                    sections={contextPreviewData.sections}
                    totalTokens={contextPreviewData.totalTokens}
                    maxTokens={contextPreviewData.maxTokens}
                    maxOutputTokens={contextPreviewData.maxOutputTokens}
                    warnings={contextPreviewData.warnings}
                    includedMessages={contextPreviewData.includedMessages}
                    droppedMessages={contextPreviewData.droppedMessages}
                />
            )}
        </div>
    );
}
