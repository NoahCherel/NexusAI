'use client';

import { useRef, useEffect, useState, useMemo } from 'react';
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
    const [isLorebookOpen, setIsLorebookOpen] = useState(false);
    const [isTreeOpen, setIsTreeOpen] = useState(false);
    const [isMemoryOpen, setIsMemoryOpen] = useState(false);
    const [isCanonOpen, setIsCanonOpen] = useState(false);
    const [isWorldStateSheetOpen, setIsWorldStateSheetOpen] = useState(false);
    const [isWorldStateDialogOpen, setIsWorldStateDialogOpen] = useState(false);
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

    const {
        activeProvider,
        activeModel,
        showThoughts,
        showUsageBadge,
        showWorldState,
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

    // Get current world state from active conversation
    const currentConversation = conversations.find((c) => c.id === activeConversationId);
    const worldState = currentConversation?.worldState || {
        inventory: [],
        location: '',
        relationships: {},
    };

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

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    // Background memory pipeline: hierarchical-summaries effect + post-beat analyses
    // (arc capture, momentum, relations, fact extraction) — extracted to a dedicated hook.
    const { runPostBeat } = useBackgroundPipeline({
        character,
        activeConversationId,
        messages,
        currentApiKey,
        worldStateLocation: worldState.location,
    });

    // Generation flow (send / stop / regenerate / continue / impersonate / retry) —
    // extracted to useChatGeneration; behaviour unchanged.
    const {
        isLoading,
        send: handleSend,
        stop: handleStop,
        regenerate: handleRegenerate,
        continueMessage: handleContinue,
        impersonate: handleImpersonate,
        retry: handleRetry,
    } = useChatGeneration({
        character,
        activeConversationId,
        messages,
        worldState,
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
            worldState,
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
                    worldState,
                    recentMessages: simulatedMessages as CAMessage[],
                    activeBranchMessageIds: simulatedMessages.map((m) => m.id),
                    minConfidence: previewMinConf,
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
            worldState,
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
                          `Draft message included: "${draftText.slice(0, 80)}${draftText.length > 80 ? '...' : ''}"`,
                      ]
                    : []),
            ],
        });
        setIsContextPreviewOpen(true);
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

        const message =
            convCount > 0
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
                                            <p>The story begins here...</p>
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
                                                        Load{' '}
                                                        {Math.min(
                                                            MESSAGE_PAGE_SIZE,
                                                            hiddenMessageCount
                                                        )}{' '}
                                                        more messages ({hiddenMessageCount} hidden)
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
                                                        error={msg.error}
                                                        usage={
                                                            showUsageBadge ? msg.usage : undefined
                                                        }
                                                        avatar={
                                                            msg.role === 'user'
                                                                ? personas.find(
                                                                      (p) =>
                                                                          p.id === activePersonaId
                                                                  )?.avatar
                                                                : character.avatar
                                                        }
                                                        name={
                                                            msg.role === 'user'
                                                                ? personas.find(
                                                                      (p) =>
                                                                          p.id === activePersonaId
                                                                  )?.name || 'You'
                                                                : character.name
                                                        }
                                                        showThoughts={showThoughts}
                                                        onEdit={handleEditMessage}
                                                        onRegenerate={handleRegenerate}
                                                        onContinue={handleContinue}
                                                        onBranch={handleBranch}
                                                        onDelete={handleDeleteMessage}
                                                        onRetry={handleRetry}
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
                                {!immersiveMode && (
                                    <ChatToolbar
                                        showWorldState={showWorldState}
                                        onOpenLorebook={() => setIsLorebookOpen(true)}
                                        onOpenRelations={() => {
                                            // Desktop: dialog — Mobile: bottom sheet
                                            if (window.innerWidth >= 1024) {
                                                setIsWorldStateDialogOpen(true);
                                            } else {
                                                setIsWorldStateSheetOpen(true);
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
                <DialogContent className="!max-w-[95vw] !w-[95vw] h-[90vh] p-0 overflow-hidden [&>button]:hidden flex flex-col max-sm:!w-screen max-sm:!max-w-none max-sm:h-dvh max-sm:rounded-none max-sm:border-0 max-sm:top-0 max-sm:left-0 max-sm:translate-x-0 max-sm:translate-y-0">
                    <DialogTitle className="sr-only">Lorebook Editor</DialogTitle>
                    <DialogDescription className="sr-only">
                        Edit lorebook entries for this character.
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
            <Dialog open={isWorldStateDialogOpen} onOpenChange={setIsWorldStateDialogOpen}>
                <DialogContent className="!max-w-[640px] !w-[640px] h-[85vh] p-0 overflow-hidden flex flex-col">
                    <DialogTitle className="sr-only">Relations</DialogTitle>
                    <DialogDescription className="sr-only">
                        Directional, multi-axis relationships between the characters in this story.
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

            {/* Mobile Relationships Bottom Sheet */}
            <Sheet open={isWorldStateSheetOpen} onOpenChange={setIsWorldStateSheetOpen}>
                <SheetContent side="bottom" className="h-[75vh] p-0">
                    <SheetHeader className="p-4 border-b">
                        <SheetTitle>💞 Relations</SheetTitle>
                        <SheetDescription>
                            Dirigées et asymétriques (Confiance / Affection / Respect / Attirance)
                        </SheetDescription>
                    </SheetHeader>
                    <div className="p-4 overflow-y-auto h-[calc(75vh-5rem)]">
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
