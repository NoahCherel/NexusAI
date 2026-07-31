'use client';

import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings2, Sparkles, Users, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Message as CAMessage } from '@/types';
import { ChatBubble, ChatInput, RelationshipPanel, ContextPreviewPanel } from '@/components/chat';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { ChatToolbar } from '@/components/chat/ChatToolbar';
import {
    exportConversationForCharacter,
    importConversationFromFile,
} from '@/lib/conversation-transfer';
import { SettingsPanel, CharacterPanel } from '@/components/layout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SceneBar } from '@/components/chat/SceneBar';
import { CharacterEditor } from '@/components/character';
import { useCharacterStore, useSettingsStore, useChatStore, useLorebookStore } from '@/stores';
import { buildConversationPayload } from '@/lib/ai/payload-builder';
import { LorebookEditor } from '@/components/lorebook';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from '@/components/ui/sheet';
import { TreeVisualization } from '@/components/chat/TreeVisualization';
import { MemoryPanel } from '@/components/chat/MemoryPanel';
import { CanonEditor } from '@/components/canon/CanonEditor';
import { LandingPage } from '@/components/chat/LandingPage';
import { useAppInitialization } from '@/hooks/useAppInitialization';
import { useBackgroundPipeline } from '@/hooks/useBackgroundPipeline';
import { useChatGeneration, useActiveApiKey } from '@/hooks/useChatGeneration';
import { APINotificationToast } from '@/components/ui/api-notification';
import {
    retrieveRelevantContext,
    resolveActiveLorebookEntries,
    buildContextPreview,
} from '@/lib/ai/rag-service';
import { buildCanonOptions } from '@/lib/ai/canon-context';
import type { ContextSection } from '@/types/rag';

export default function ChatPage() {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isDeleteCharacterOpen, setIsDeleteCharacterOpen] = useState(false);
    const [isLorebookOpen, setIsLorebookOpen] = useState(false);
    const [isTreeOpen, setIsTreeOpen] = useState(false);
    const [isMemoryOpen, setIsMemoryOpen] = useState(false);
    const [isCanonOpen, setIsCanonOpen] = useState(false);
    const [isRelationsSheetOpen, setIsRelationsSheetOpen] = useState(false);
    const [isRelationsDialogOpen, setIsRelationsDialogOpen] = useState(false);
    const currentApiKey = useActiveApiKey();
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

    const scrollRef = useRef<HTMLDivElement>(null);
    const { getActiveCharacter, removeCharacter } = useCharacterStore();
    const {
        conversations,
        activeConversationId,
        createConversation,
        addMessage,
        updateMessage,
        getActiveBranchMessages,
        getActiveBranchBanList,
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

    // Sibling info for EVERY message in one pass — the previous per-bubble
    // getMessageSiblingsInfo() call was an O(n log n) filter+sort per bubble per render
    // (≈200 × per stream chunk). Same semantics: same conversation + same parentId,
    // sorted by createdAt, 1-based index.
    const siblingsInfoById = useMemo(() => {
        const byParent = new Map<string, typeof storeMessages>();
        for (const m of storeMessages) {
            if (activeConversationId && m.conversationId !== activeConversationId) continue;
            const key = `${m.conversationId}:${m.parentId ?? 'root'}`;
            const group = byParent.get(key);
            if (group) group.push(m);
            else byParent.set(key, [m]);
        }
        const info = new Map<string, { currentIndex: number; total: number }>();
        for (const group of byParent.values()) {
            group.sort(
                (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            );
            group.forEach((m, i) =>
                info.set(m.id, { currentIndex: i + 1, total: group.length })
            );
        }
        return info;
    }, [storeMessages, activeConversationId]);

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

    const {
        activeProvider,
        activeModel,
        showThoughts,
        showUsageBadge,
        enableTroupeMode,
        activePersonaId,
        personas,
        immersiveMode,
        getActivePreset,
        getActiveEngine,
        initializeDefaultPresets,
    } = useSettingsStore();
    const character = getActiveCharacter();

    // Seed/reconcile built-in presets on load so new built-ins (e.g. "Immersive RP")
    // appear without needing to open the Presets tab first.
    useEffect(() => {
        initializeDefaultPresets();
    }, [initializeDefaultPresets]);


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
                const newId = await createConversation(
                    character.id,
                    `Discussion avec ${character.name}`
                );

                if (character.first_mes) {
                    // Seed the greeting + V2 alternate greetings as swipable ROOT siblings.
                    // addMessage activates the latest-added sibling, so the alternates go in
                    // first and first_mes last (with the earliest createdAt, so the sibling
                    // sort shows it as 1/N and it starts active).
                    const base = Date.now();
                    const alternates = (character.alternate_greetings ?? []).filter((g) =>
                        g?.trim()
                    );
                    alternates.forEach((greeting, i) => {
                        addMessage({
                            id: crypto.randomUUID(),
                            conversationId: newId,
                            parentId: null,
                            role: 'assistant',
                            content: greeting,
                            isActiveBranch: true,
                            createdAt: new Date(base + 1 + i),
                            messageOrder: 1,
                            regenerationIndex: 0,
                        });
                    });
                    addMessage({
                        id: crypto.randomUUID(),
                        conversationId: newId,
                        parentId: null,
                        role: 'assistant',
                        content: character.first_mes,
                        isActiveBranch: true,
                        createdAt: new Date(base),
                        messageOrder: 1,
                        regenerationIndex: 0,
                    });
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
        loadedCharacterId,
        isLoadingConversations,
        setActiveConversation,
    ]);

    // Auto-scroll: rAF-throttled (once per frame, not per stream chunk) and only while
    // the user is already near the bottom — scrolling up to reread must not be fought.
    const scrollRafPending = useRef(false);
    useEffect(() => {
        if (scrollRafPending.current) return;
        scrollRafPending.current = true;
        requestAnimationFrame(() => {
            scrollRafPending.current = false;
            const sentinel = scrollRef.current;
            if (!sentinel) return;
            const rect = sentinel.getBoundingClientRect();
            if (rect.top < window.innerHeight + 400) {
                sentinel.scrollIntoView({ block: 'end' });
            }
        });
    }, [messages]);

    // Background memory pipeline: hierarchical-summaries effect + post-beat analyses
    // (arc capture, momentum, relations, fact extraction) — extracted to a dedicated hook.
    const { runPostBeat } = useBackgroundPipeline({
        character,
        activeConversationId,
        messages,
        currentApiKey,

    });

    // Generation flow (send / stop / regenerate / continue / impersonate / retry) —
    // extracted to useChatGeneration; behaviour unchanged.
    const {
        isLoading,
        isSceneRunning,
        send: handleSend,
        stop: handleStop,
        regenerate: handleRegenerate,
        continueMessage: handleContinue,
        impersonate: handleImpersonate,
        retry: handleRetry,
        runSceneBeat,
    } = useChatGeneration({
        character,
        activeConversationId,
        messages,
        currentApiKey,
        runPostBeat,
    });

    // Context Preview handler - builds a preview of what would be sent
    const handleContextPreview = async () => {
        if (!character || !activeConversationId || !currentApiKey) return;

        const activePreset = getActivePreset();
        const activePersona = personas.find((p) => p.id === activePersonaId);

        const activeEngine = getActiveEngine();

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

        // Keyword-only lorebook scan (same shared resolver as generation, hybrid off).
        const activeEntries = await resolveActiveLorebookEntries({
            messages: simulatedMessages,
            lorebook: activeLorebook,
            preset: activePreset,
            characterName: character.name,
            userPersonaName: activePersona?.name,
            tokenBudget: activePreset?.lorebookTokenBudget ?? 2000,
        });

        const conv = conversations.find((c) => c.id === activeConversationId);
        const combinedMem = [...(conv?.notes || []), ...(character.longTermMemory || [])];
        const previewCanonOptions = await buildCanonOptions(
            character,
            conv,
            simulatedMessages,
            activePersona?.name || 'the player'
        );
        const maxContextTokens = activePreset?.maxContextTokens ?? 16384;
        const maxOutputTokens = activePreset?.maxOutputTokens ?? 2048;
        const { minRAGConfidence: previewMinConf, enableScratchpad: previewScratchpad } =
            useSettingsStore.getState();
        const lastMsg = simulatedMessages[simulatedMessages.length - 1]?.content || '';

        const {
            systemPrompt,
            effectivePostHistory,
            ragSections,
            messagesPayload,
            includedMessageCount,
            droppedMessageCount,
        } = await buildConversationPayload({
            mode: 'preview',
            character,
            activeEntries,
            history: simulatedMessages as CAMessage[],
            recentMessages: simulatedMessages as CAMessage[],
            activePreset,
            activeEngine,
            learnedBanList: activeConversationId
                ? getActiveBranchBanList(activeConversationId)
                : undefined,
            userPersona: activePersona,
            longTermMemory: combinedMem,
            storyGuidance: conv?.storyGuidance,
            scratchpad: conv?.scratchpad,
            enableScratchpad: previewScratchpad,
            canonOptions: previewCanonOptions,
            activeProvider,
            maxContextTokens,
            maxOutputTokens,
            historyCutMessageId: conv?.historyCutMessageId,
            retrieveRag: (ragBudget) =>
                retrieveRelevantContext(lastMsg, activeConversationId, ragBudget, {

                    recentMessages: simulatedMessages as CAMessage[],
                    activeBranchMessageIds: simulatedMessages.map((m) => m.id),
                    minConfidence: previewMinConf,
                    // Mirror generation: same dedup + same summary eviction gate, so the
                    // preview shows what the real call actually injects.
                    dedupAgainstTexts: [
                        ...(previewCanonOptions.canonDossiers ?? []).map(
                            (d) => `${d.identity}\n${d.backstory ?? ''}\n${d.abilities ?? ''}`
                        ),
                        ...activeEntries.map((e) => e.content),
                    ],
                    evictedMessageCount: conv?.historyCutMessageId
                        ? Math.max(
                              0,
                              simulatedMessages.findIndex(
                                  (m) => m.id === conv.historyCutMessageId
                              )
                          )
                        : 0,
                }),
        });

        // Build preview sections
        // Pass original systemPrompt (without RAG) so preview shows sections separately without duplication
        const previewData = await buildContextPreview(
            systemPrompt,
            ragSections,
            messagesPayload.filter((m) => m.role !== 'system'),
            effectivePostHistory,
            maxContextTokens,
            maxOutputTokens,
            activeEntries,
            previewCanonOptions.injectionMeta
        );

        setContextPreviewData({
            ...previewData,
            maxOutputTokens,
            includedMessages: includedMessageCount,
            droppedMessages: droppedMessageCount,
            warnings: [
                ...previewData.warnings,
                ...(draftText
                    ? [
                          `Brouillon inclus : « ${draftText.slice(0, 80)}${draftText.length > 80 ? '…' : ''} »`,
                      ]
                    : []),
            ],
        });
        setIsContextPreviewOpen(true);
    };

    // Stable identities for the bubble callbacks: ChatBubble is memo'd, and fresh function
    // props on every render defeated it — all ~200 bubbles (with framer-motion layout
    // measurement) re-rendered on every stream chunk. The generation handlers are
    // recreated by the hook each render, so they're routed through a ref.
    const bubbleActionsRef = useRef({
        regenerate: handleRegenerate,
        continueMsg: handleContinue,
        retry: handleRetry,
    });
    useEffect(() => {
        bubbleActionsRef.current = {
            regenerate: handleRegenerate,
            continueMsg: handleContinue,
            retry: handleRetry,
        };
    });
    const onBubbleRegenerate = useCallback(
        (id: string) => bubbleActionsRef.current.regenerate(id),
        []
    );
    const onBubbleContinue = useCallback(
        (id: string) => bubbleActionsRef.current.continueMsg(id),
        []
    );
    const onBubbleRetry = useCallback((id: string) => bubbleActionsRef.current.retry(id), []);

    // Zustand actions have stable identities — plain useCallback is enough here.
    const handleEditMessage = useCallback(
        (id: string, newContent: string) => {
            updateMessage(id, { content: newContent });
        },
        [updateMessage]
    );

    const handleDeleteMessage = useCallback(
        (id: string) => {
            deleteMessage(id);
        },
        [deleteMessage]
    );

    // Branching = regenerate from this point.
    const handleBranch = onBubbleRegenerate;

    // Character actions
    const handleEditCharacter = () => {
        setIsCharacterEditorOpen(true);
    };

    const handleDeleteCharacter = () => {
        if (!character) return;
        setIsDeleteCharacterOpen(true);
    };

    const confirmDeleteCharacter = async () => {
        if (!character) return;
        const charConvs = conversations.filter((c) => c.characterId === character.id);
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
    };

    const handleExportCharacter = async () => {
        if (!character) return;
        await exportConversationForCharacter(character);
    };

    const handleImportConversation = () => {
        importConversationFromFile();
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
        // h-dvh (not h-screen/100vh): correct height on mobile Safari/Chrome where the URL
        // bar collapses; keeps the input visible with the keyboard open.
        <div className="flex h-dvh bg-background overflow-hidden">
            <main className="flex-1 flex flex-col min-w-0">
                {character ? (
                    <>
                        {/* Header - Hidden in immersive mode */}
                        <AnimatePresence>
                            {!immersiveMode && (
                                <ChatHeader
                                    character={character}
                                    activeModel={activeModel}
                                    onEditCharacter={handleEditCharacter}
                                    onImportConversation={handleImportConversation}
                                    onExportConversation={handleExportCharacter}
                                    onDeleteCharacter={handleDeleteCharacter}
                                    onOpenSettings={() => setIsSettingsOpen(true)}
                                />
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
                                            <p>L’histoire commence ici…</p>
                                        </div>
                                    ) : (
                                        <>
                                            {hasMoreMessages && (
                                                <div className="flex justify-center py-4">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() =>
                                                            setDisplayLimit(
                                                                (prev) => prev + MESSAGE_PAGE_SIZE
                                                            )
                                                        }
                                                        className="gap-2 text-xs text-muted-foreground hover:text-foreground"
                                                    >
                                                        <ChevronUp className="h-3.5 w-3.5" />
                                                        Charger{' '}
                                                        {Math.min(
                                                            MESSAGE_PAGE_SIZE,
                                                            hiddenMessageCount
                                                        )}{' '}
                                                        messages de plus ({hiddenMessageCount}{' '}
                                                        masqués)
                                                    </Button>
                                                </div>
                                            )}
                                            {displayedMessages.map((msg) => {
                                                const siblingsInfo = siblingsInfoById.get(
                                                    msg.id
                                                ) ?? { currentIndex: 1, total: 1 };
                                                // Replace {{user}} with persona name for display
                                                const displayContent = msg.content.replace(
                                                    /{{user}}/gi,
                                                    personas.find((p) => p.id === activePersonaId)
                                                        ?.name || 'Vous'
                                                );

                                                return (
                                                    <ChatBubble
                                                        key={msg.id}
                                                        id={msg.id}
                                                        role={msg.role as 'user' | 'assistant'}
                                                        content={displayContent}
                                                        thought={msg.thought}
                                                        error={msg.error}
                                                        usage={
                                                            showUsageBadge ? msg.usage : undefined
                                                        }
                                                        avatar={
                                                            msg.role === 'user'
                                                                ? // Persona AT SEND TIME (by id,
                                                                  // then name); legacy messages
                                                                  // fall back to the active one.
                                                                  personas.find(
                                                                      (p) =>
                                                                          p.id ===
                                                                          (msg.speaker
                                                                              ?.personaId ??
                                                                              activePersonaId)
                                                                  )?.avatar ??
                                                                  personas.find(
                                                                      (p) =>
                                                                          p.name ===
                                                                          msg.speaker?.name
                                                                  )?.avatar
                                                                : character.avatar
                                                        }
                                                        name={
                                                            msg.role === 'user'
                                                                ? msg.speaker?.name ||
                                                                  personas.find(
                                                                      (p) =>
                                                                          p.id === activePersonaId
                                                                  )?.name ||
                                                                  'Vous'
                                                                : msg.speaker?.name ||
                                                                  character.name
                                                        }
                                                        narrator={
                                                            msg.speaker?.kind === 'narrator'
                                                        }
                                                        showThoughts={showThoughts}
                                                        animateLayout={!isLoading}
                                                        onEdit={handleEditMessage}
                                                        onRegenerate={onBubbleRegenerate}
                                                        onContinue={onBubbleContinue}
                                                        onBranch={handleBranch}
                                                        onDelete={handleDeleteMessage}
                                                        onRetry={onBubbleRetry}
                                                        currentBranchIndex={
                                                            siblingsInfo.currentIndex
                                                        }
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
                            className={`z-20 ${
                                immersiveMode
                                    ? 'absolute bottom-4 left-4 right-4 rounded-2xl glass-heavy shadow-2xl'
                                    : 'p-4 border-t border-white/5 glass-heavy'
                            }`}
                        >
                            <div
                                className={`mx-auto w-full space-y-2 ${immersiveMode ? 'p-4 max-w-3xl' : 'max-w-4xl'}`}
                            >
                                {enableTroupeMode && !immersiveMode && (
                                    <SceneBar
                                        conversation={conversations.find(
                                            (c) => c.id === activeConversationId
                                        )}
                                        character={character}
                                        messages={messages}
                                        isSceneRunning={isSceneRunning}
                                        onAdvanceScene={() => void runSceneBeat()}
                                    />
                                )}
                                {!immersiveMode && (
                                    <ChatToolbar
                                        onOpenLorebook={() => setIsLorebookOpen(true)}
                                        onOpenRelations={() => {
                                            // Desktop: dialog — Mobile: bottom sheet
                                            if (window.innerWidth >= 1024) {
                                                setIsRelationsDialogOpen(true);
                                            } else {
                                                setIsRelationsSheetOpen(true);
                                            }
                                        }}
                                        onOpenTree={() => setIsTreeOpen(true)}
                                        onOpenMemory={() => setIsMemoryOpen(true)}
                                        onOpenCanon={() => setIsCanonOpen(true)}
                                        onContextPreview={handleContextPreview}
                                    />
                                )}
                                <ChatInput
                                    onSend={handleSend}
                                    onStop={handleStop}
                                    isLoading={isLoading}
                                    disabled={!currentApiKey}
                                    onImpersonate={handleImpersonate}
                                    onDraftChange={(draft) => {
                                        draftMessageRef.current = draft;
                                    }}
                                    placeholder={
                                        !currentApiKey
                                            ? 'Clé API manquante — ouvrez les Réglages'
                                            : `Message pour ${character.name}…`
                                    }
                                />
                                {immersiveMode && (
                                    <div className="absolute top-2 right-2">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 opacity-30 hover:opacity-100 transition-opacity"
                                            onClick={() => setIsSettingsOpen(true)}
                                            title="Réglages"
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

            <ConfirmDialog
                open={isDeleteCharacterOpen}
                onOpenChange={setIsDeleteCharacterOpen}
                title={`Supprimer ${character?.name ?? 'ce personnage'} ?`}
                description={(() => {
                    const n = character
                        ? conversations.filter((c) => c.characterId === character.id).length
                        : 0;
                    return n > 0
                        ? `Ses ${n} conversation${n > 1 ? 's' : ''} seront supprimées aussi. Cette action est irréversible.`
                        : 'Cette action est irréversible.';
                })()}
                confirmLabel="Supprimer"
                destructive
                onConfirm={() => void confirmDeleteCharacter()}
            />

            <Dialog open={isLorebookOpen} onOpenChange={setIsLorebookOpen}>
                <DialogContent className="!max-w-[95vw] !w-[95vw] h-[90vh] p-0 overflow-hidden [&>button]:hidden flex flex-col max-sm:!w-screen max-sm:!max-w-none max-sm:h-dvh max-sm:rounded-none max-sm:border-0 max-sm:top-0 max-sm:left-0 max-sm:translate-x-0 max-sm:translate-y-0">
                    <DialogTitle className="sr-only">Éditeur de lorebook</DialogTitle>
                    <DialogDescription className="sr-only">
                        Modifier les entrées du lorebook de ce personnage.
                    </DialogDescription>
                    <LorebookEditor onClose={() => setIsLorebookOpen(false)} />
                </DialogContent>
            </Dialog>

            <TreeVisualization isOpen={isTreeOpen} onClose={() => setIsTreeOpen(false)} />

            <MemoryPanel isOpen={isMemoryOpen} onClose={() => setIsMemoryOpen(false)} />

            <Dialog open={isCanonOpen} onOpenChange={setIsCanonOpen}>
                <DialogContent className="!max-w-[95vw] !w-[95vw] h-[90vh] p-0 overflow-hidden [&>button]:hidden flex flex-col max-sm:!w-screen max-sm:!max-w-none max-sm:h-dvh max-sm:rounded-none max-sm:border-0 max-sm:top-0 max-sm:left-0 max-sm:translate-x-0 max-sm:translate-y-0">
                    <DialogTitle className="sr-only">Canon Codex</DialogTitle>
                    <DialogDescription className="sr-only">
                        Arc Compass, casting canon et outils du Directeur.
                    </DialogDescription>
                    <CanonEditor onClose={() => setIsCanonOpen(false)} />
                </DialogContent>
            </Dialog>

            {/* Desktop Relationships Dialog */}
            <Dialog open={isRelationsDialogOpen} onOpenChange={setIsRelationsDialogOpen}>
                <DialogContent className="!max-w-[640px] !w-[640px] h-[85vh] p-0 overflow-hidden flex flex-col">
                    <DialogTitle className="sr-only">Relations</DialogTitle>
                    <DialogDescription className="sr-only">
                        Relations directionnelles multi-axes entre les personnages de cette
                        histoire.
                    </DialogDescription>
                    <div className="flex flex-col h-full">
                        <div className="p-4 border-b">
                            <h2 className="text-lg font-semibold">💞 Relations</h2>
                            <p className="text-sm text-muted-foreground">
                                Confiance / Affection / Respect / Attirance — dirigées et asymétriques
                            </p>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4">
                            <RelationshipPanel />
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Mobile Relationships Bottom Sheet — flex column: the header takes its real
                height and the list gets exactly the rest (a hardcoded calc() reserved less
                than the header's actual size → double scroll + last items hidden). */}
            <Sheet open={isRelationsSheetOpen} onOpenChange={setIsRelationsSheetOpen}>
                <SheetContent side="bottom" className="h-[75vh] p-0 gap-0 flex flex-col">
                    <SheetHeader className="p-4 border-b shrink-0">
                        <SheetTitle>💞 Relations</SheetTitle>
                        <SheetDescription>
                            Dirigées et asymétriques (Confiance / Affection / Respect / Attirance)
                        </SheetDescription>
                    </SheetHeader>
                    <div className="p-4 overflow-y-auto flex-1 min-h-0">
                        <RelationshipPanel />
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
