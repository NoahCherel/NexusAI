'use client';

import { useRef, useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings2, Sparkles, GitBranch, Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Message as CAMessage } from '@/types';
import {
    ChatBubble,
    ChatInput,
    WorldStatePanel,
    PersonaSelector,
    ModelSelector,

} from '@/components/chat';
import { Sidebar, SettingsPanel, MobileSidebar } from '@/components/layout';
import { useCharacterStore, useSettingsStore, useChatStore, useLorebookStore } from '@/stores';
import { useWorldStateAnalyzer } from '@/hooks';
import { decryptApiKey } from '@/lib/crypto';
import { parseStreamingChunk, normalizeCoT } from '@/lib/ai/cot-middleware';
import { buildSystemPrompt, getActiveLorebookEntries } from '@/lib/ai/context-builder';
import { LorebookEditor } from '@/components/lorebook';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Book, Globe2Icon } from 'lucide-react';
import { TreeVisualization } from '@/components/chat/TreeVisualization';
import { MemoryPanel } from '@/components/chat/MemoryPanel';
import { LandingPage } from '@/components/chat/LandingPage';
import { useAppInitialization } from '@/hooks/useAppInitialization';
import { extractLorebookEntries } from '@/lib/lorebook-extractor';
import { APINotificationToast } from '@/components/ui/api-notification';
import type { Message } from '@/types';

export default function ChatPage() {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
    const [isWorldStateCollapsed, setIsWorldStateCollapsed] = useState(false);
    const [isLorebookOpen, setIsLorebookOpen] = useState(false);
    const [isTreeOpen, setIsTreeOpen] = useState(false);
    const [isMemoryOpen, setIsMemoryOpen] = useState(false);
    const [isWorldStateSheetOpen, setIsWorldStateSheetOpen] = useState(false); // Mobile bottom sheet
    const [currentApiKey, setCurrentApiKey] = useState<string | null>(null);

    // Initialize IndexedDB and load data
    useAppInitialization();

    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const { getActiveCharacter } = useCharacterStore();
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
    const { analyzeMessage } = useWorldStateAnalyzer();
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
                console.log('[ChatPage] Waiting for sync...', {
                    char: character?.id,
                    loaded: loadedCharacterId,
                    loading: isLoadingConversations,
                });
                return;
            }

            console.log('[ChatPage] initConversation checking...', {
                hasCharacter: !!character,
                isLoadingConversations: isLoadingConversations,
                activeConversationId,
                loadedConversationsCount: conversations.length,
            });

            // Check if we already have a valid active conversation for this character
            const currentConv = conversations.find((c) => c.id === activeConversationId);
            if (currentConv && currentConv.characterId === character.id) {
                console.log('[ChatPage] Valid conversation already active:', activeConversationId);
                return;
            }

            // Try to find an existing conversation for this character
            // The store's loadConversations should have already tried to set activeConversationId from localStorage
            // But if it failed or wasn't set, we pick the most recent one
            const characterConvs = conversations
                .filter((c) => c.characterId === character.id)
                .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

            if (characterConvs.length > 0) {
                console.log('[ChatPage] Resuming existing conversation:', characterConvs[0].id);
                setActiveConversation(characterConvs[0].id);
            } else {
                console.log('[ChatPage] Creating NEW conversation for', character.name);
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

    const triggerAiReponse = async (
        history: CAMessage[],
        options: {
            isImpersonation?: boolean;
            prefill?: string;
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

        // 1. Calculate Active Lorebook Entries (World Info) using STORE data
        const useLorebooks = activePreset?.useLorebooks ?? true;
        const activeEntries = useLorebooks
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
                    tokenBudget: activePreset?.lorebookTokenBudget,
                    recursive: activePreset?.lorebookRecursiveScanning,
                    matchWholeWords: activePreset?.matchWholeWords,
                }
            )
            : [];

        // 2. Build Enhanced System Prompt
        let systemPrompt = buildSystemPrompt(
            character,
            worldState,
            activeEntries,
            {
                template: activePreset?.systemPromptTemplate,
                preHistory: activePreset?.preHistoryInstructions,
                postHistory: activePreset?.postHistoryInstructions,
                userPersonaName: activePersona?.name || 'User',
            }
        );

        // Handle Impersonation System Prompt Override
        if (options.isImpersonation) {
            const impersonationInstruction = activePreset?.impersonationPrompt ||
                'Write the next message for {{user}}. Stay in character as {{user}}. Do not respond as the AI/Assistant.';

            const resolvedImpersonation = impersonationInstruction.replace(
                /{{user}}/gi,
                activePersona?.name || 'User'
            );

            // Append or Replace? Usually we want to force the role.
            // We append it to the END of the system prompt to override previous instructions.
            systemPrompt += `\n\n[SYSTEM: ${resolvedImpersonation}]`;
        }

        // 3. Prepare Target Message (Assistant or User)
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
            });
        }

        // 4. API Request Construction
        const messagesPayload = history.map(({ role, content }) => ({ role, content }));

        // Handle Prefill for API (Add active message to history if supported/needed)
        // For simple usage, if we have prefill, we might NOT send it to API if we want API to complete it, 
        // OR we send it as the *last* message if the provider supports prefill (Anthropic).
        // Since we are using standard streamText, standard behavior is: 
        // If last message is assistant, it continues.
        if (options.prefill && targetRole === 'assistant') {
            const supportsPrefill = activeProvider === 'anthropic' || activeProvider === 'openrouter';
            if (supportsPrefill) {
                messagesPayload.push({ role: 'assistant', content: options.prefill });
            } else {
                // Determine workaround for providers that don't support prefill?
                // For now, we just rely on client-side appending and don't send it to API.
                // The AI will generate from scratch (hopefully compatible), and we prepend the prefill.
            }
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
                    systemPrompt,
                    userPersona: activePersona,
                    enableReasoning: activePreset?.enableReasoning ?? enableReasoning,
                }),
                signal: abortControllerRef.current.signal,
            });

            if (!response.ok) {
                throw new Error('Failed to get response');
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
                // Wait, if we provided prefill to Anthropic, it returns ONLY the new text.
                // If we didn't provide it (OpenAI), it returns the whole text (which shouldn't include prefill matching).

                // So appending is always correct?
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

                // Lorebook extraction
                if (activeLorebook && fullContent) {
                    const existingKeys = activeLorebook.entries.flatMap((e) => e.keys);
                    extractLorebookEntries(fullContent, existingKeys)
                        .then((newEntries) => {
                            if (newEntries.length > 0) {
                                const { addAIEntry } = useLorebookStore.getState();
                                newEntries.forEach((entry) => addAIEntry(entry));
                            }
                        })
                        .catch((err) => console.error('Lorebook extraction failed:', err));
                }
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                console.log('Request aborted');
                return;
            }
            console.error('Chat error:', error);
            if (activeConversationId) {
                updateMessage(targetId, {
                    content: fullContent + '\n[Error: Failed to get response. Check API Key or Network.]',
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

    const handleSend = async (userMessage: string) => {
        if (!activeConversationId) return;

        const lastParams = messages.length > 0 ? messages[messages.length - 1] : null;

        const newUserMessage: Message = {
            id: crypto.randomUUID(),
            conversationId: activeConversationId,
            parentId: lastParams?.id || null,
            role: 'user',
            content: userMessage,
            isActiveBranch: true,
            createdAt: new Date(),
        };

        addMessage(newUserMessage);

        const activePreset = getActivePreset();
        const prefill = activePreset?.assistantPrefill || undefined;

        // Construct history for API (include the new message)
        const history = [...messages, newUserMessage];
        await triggerAiReponse(history, { prefill });
    };

    const handleImpersonate = async (): Promise<string | void> => {
        if (!activeConversationId || isLoading || !currentApiKey) return;

        setIsLoading(true);

        let generatedText = '';

        try {
            const activePreset = getActivePreset();
            const activePersona = personas.find((p) => p.id === activePersonaId);

            // 1. Context
            const useLorebooks = activePreset?.useLorebooks ?? true;
            const activeEntries = useLorebooks
                ? getActiveLorebookEntries(
                    messages.map((m) => ({ ...m, conversationId: '', parentId: null, isActiveBranch: true, createdAt: new Date() })) as unknown as CAMessage[],
                    activeLorebook || undefined,
                    {
                        scanDepth: activePreset?.lorebookScanDepth,
                        tokenBudget: activePreset?.lorebookTokenBudget,
                        recursive: activePreset?.lorebookRecursiveScanning,
                        matchWholeWords: activePreset?.matchWholeWords,
                    }
                )
                : [];

            let systemPrompt = buildSystemPrompt(
                character,
                worldState,
                activeEntries,
                {
                    template: activePreset?.systemPromptTemplate,
                    preHistory: activePreset?.preHistoryInstructions,
                    postHistory: activePreset?.postHistoryInstructions,
                    userPersonaName: activePersona?.name || 'User',
                }
            );

            // Impersonation Override
            const impersonationInstruction = activePreset?.impersonationPrompt ||
                'Write the next message for {{user}}. Stay in character as {{user}}. Do not respond as the AI/Assistant.';
            const resolvedImpersonation = impersonationInstruction.replace(
                /{{user}}/gi,
                activePersona?.name || 'User'
            );
            systemPrompt += `\n\n[SYSTEM: ${resolvedImpersonation}]`;

            // 2. API Call
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: messages.map(({ role, content }) => ({ role, content })),
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
            await triggerAiReponse(history);
        }
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
            {/* Desktop Sidebar - hidden on mobile */}
            <div className="hidden lg:block">
                <Sidebar
                    isCollapsed={isSidebarCollapsed}
                    onToggle={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                    onSettingsClick={() => setIsSettingsOpen(true)}
                />
            </div>

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
                                        {/* Mobile Menu Button */}
                                        <MobileSidebar
                                            onCharacterSelect={() => { }}
                                            onSettingsClick={() => setIsSettingsOpen(true)}
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
                                        messages.map((msg) => {
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
                                                    onBranch={handleBranch}
                                                    onDelete={handleDeleteMessage}
                                                    currentBranchIndex={siblingsInfo.currentIndex}
                                                    totalBranches={siblingsInfo.total}
                                                    onNavigateBranch={navigateToSibling}
                                                />
                                            );
                                        })
                                    )}

                                    <div ref={scrollRef} />
                                </div>
                            </div>

                            {/* World State Panel (Overlay or Side) */}
                            {showWorldState && (
                                <div
                                    className={`hidden lg:block absolute right-0 top-0 bottom-0 border-l bg-background/95 backdrop-blur z-10 transition-all duration-300 ${isWorldStateCollapsed ? 'w-[50px] overflow-hidden' : 'w-64 p-4'}`}
                                >
                                    <WorldStatePanel
                                        inventory={worldState.inventory.map((i) =>
                                            i.replace(
                                                /{{user}}/gi,
                                                personas.find((p) => p.id === activePersonaId)
                                                    ?.name || 'You'
                                            )
                                        )}
                                        location={worldState.location.replace(
                                            /{{user}}/gi,
                                            personas.find((p) => p.id === activePersonaId)?.name ||
                                            'You'
                                        )}
                                        relationships={worldState.relationships}
                                        isCollapsed={isWorldStateCollapsed}
                                        onToggle={() =>
                                            setIsWorldStateCollapsed(!isWorldStateCollapsed)
                                        }
                                    />
                                </div>
                            )}
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
                                        {/* Mobile WorldState Button */}
                                        {showWorldState && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground shrink-0 lg:hidden"
                                                onClick={() => setIsWorldStateSheetOpen(true)}
                                                title="World Context"
                                            >
                                                <Globe2Icon className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </div>
                                )}
                                <ChatInput
                                    onSend={handleSend}
                                    onStop={handleStop}
                                    isLoading={isLoading}
                                    disabled={!currentApiKey}
                                    onImpersonate={handleImpersonate}
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
                    <LandingPage onImportClick={() => setIsSidebarCollapsed(false)} />
                )}
            </main>

            <SettingsPanel open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />

            <Dialog open={isLorebookOpen} onOpenChange={setIsLorebookOpen}>
                <DialogContent className="!max-w-[95vw] !w-[95vw] h-[90vh] p-0 overflow-hidden [&>button]:hidden">
                    <DialogTitle className="sr-only">Lorebook Editor</DialogTitle>
                    <DialogDescription className="sr-only">
                        Edit lorebook entries for this character.
                    </DialogDescription>
                    <LorebookEditor onClose={() => setIsLorebookOpen(false)} />
                </DialogContent>
            </Dialog>

            <TreeVisualization isOpen={isTreeOpen} onClose={() => setIsTreeOpen(false)} />

            <MemoryPanel isOpen={isMemoryOpen} onClose={() => setIsMemoryOpen(false)} />

            {/* Mobile WorldState Bottom Sheet */}
            <Sheet open={isWorldStateSheetOpen} onOpenChange={setIsWorldStateSheetOpen}>
                <SheetContent side="bottom" className="h-[70vh] p-0">
                    <SheetHeader className="p-4 border-b">
                        <SheetTitle>🌍 World Context</SheetTitle>
                        <SheetDescription>Track inventory, relationships, and location</SheetDescription>
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
                        />
                    </div>
                </SheetContent>
            </Sheet>

            <APINotificationToast />
        </div>
    );
}
