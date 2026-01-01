'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageCircle, Settings2, Sparkles, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatBubble, ChatInput, WorldStatePanel, PersonaSelector, ModelSelector, ThinkingModeToggle } from '@/components/chat';
import { Sidebar, SettingsPanel, MobileSidebar } from '@/components/layout';
import { useCharacterStore, useSettingsStore, useChatStore, useLorebookStore } from '@/stores';
import { useWorldStateAnalyzer } from '@/hooks';
import { decryptApiKey } from '@/lib/crypto';
import { parseStreamingChunk, normalizeCoT } from '@/lib/ai/cot-middleware';
import { buildSystemPrompt, getActiveLorebookEntries } from '@/lib/ai/context-builder';
import { LorebookEditor } from '@/components/lorebook';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Book } from 'lucide-react';
import { TreeVisualization } from '@/components/chat/TreeVisualization';
import type { CharacterCard, Message } from '@/types';

export default function ChatPage() {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isWorldStateCollapsed, setIsWorldStateCollapsed] = useState(false);
    const [isLorebookOpen, setIsLorebookOpen] = useState(false);
    const [isTreeOpen, setIsTreeOpen] = useState(false);
    const [currentApiKey, setCurrentApiKey] = useState<string | null>(null);

    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    const { getActiveCharacter } = useCharacterStore();
    const {
        conversations,
        activeConversationId,
        createConversation,
        updateWorldState,
        addMessage,
        updateMessage,
        getActiveBranchMessages,
        getMessageSiblingsInfo,
        navigateToSibling,
        setActiveConversation,
        deleteMessage
    } = useChatStore();
    const { activeLorebook, setActiveLorebook } = useLorebookStore();

    // Get active messages from store
    const messages = activeConversationId ? getActiveBranchMessages(activeConversationId) : [];
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
        immersiveMode
    } = useSettingsStore();
    const character = getActiveCharacter();

    // Get current world state from active conversation
    const currentConversation = conversations.find(c => c.id === activeConversationId);
    const worldState = currentConversation?.worldState || { inventory: [], location: '', relationships: {} };

    // Get decrypted API key on mount/change
    useEffect(() => {
        const loadApiKey = async () => {
            const keyConfig = apiKeys.find(k => k.provider === activeProvider);
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
                setActiveLorebook(character.character_book);
            } else {
                setActiveLorebook({ entries: [] });
            }
        }
    }, [character?.id, setActiveLorebook]);

    // Initialize conversation when character changes
    useEffect(() => {
        if (character && (!activeConversationId || conversations.find(c => c.id === activeConversationId)?.characterId !== character.id)) {
            // Check if there's an existing conversation for this character? 
            // For now, always create new for simplicity or find last used.
            const newId = createConversation(character.id, `Chat with ${character.name}`);

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
    }, [character?.id, character?.first_mes, activeConversationId, createConversation, addMessage, conversations, analyzeMessage]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const triggerAiReponse = async (history: ChatMessage[]) => {
        if (!currentApiKey || !character) return;
        setIsLoading(true);


        // Stop any previous request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        abortControllerRef.current = new AbortController();

        const activePersona = personas.find(p => p.id === activePersonaId);

        // 1. Calculate Active Lorebook Entries (World Info) using STORE data
        const activeEntries = getActiveLorebookEntries(
            history.map(m => ({ ...m, conversationId: '', parentId: null, isActiveBranch: true, createdAt: new Date() })),
            activeLorebook || undefined
        );

        // 2. Build Enhanced System Prompt (Char + World + Lore)
        const systemPrompt = buildSystemPrompt(character, worldState, activeEntries);

        // PRE-EMPTIVELY Add empty assistant message to store (Instant UI feedback)
        const assistantId = crypto.randomUUID();
        if (activeConversationId) {
            addMessage({
                id: assistantId,
                conversationId: activeConversationId,
                parentId: history[history.length - 1]?.id || null,
                role: 'assistant',
                content: '',
                isActiveBranch: true,
                createdAt: new Date(),
            });
        }

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: history.map(({ id, role, content }) => ({ role, content })), // Clean message objects
                    provider: activeProvider,
                    model: activeModel,
                    apiKey: currentApiKey,
                    temperature,
                    systemPrompt, // We pass the fully constructed prompt here
                    userPersona: activePersona,
                    enableReasoning
                }),
                signal: abortControllerRef.current.signal
            });

            if (!response.ok) {
                throw new Error('Failed to get response');
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader');

            const decoder = new TextDecoder();
            let assistantContent = '';
            let assistantThought = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                assistantContent += chunk;

                // Parse for thoughts in real-time using CoT middleware
                const { visibleContent, thoughtContent, inThought } = parseStreamingChunk(
                    assistantContent,
                    activeProvider
                );

                assistantThought = thoughtContent;

                // Update the assistant message in store
                updateMessage(assistantId, {
                    content: visibleContent,
                    thought: assistantThought || undefined
                });
            }

            // Final parse to ensure thoughts are fully extracted
            const finalResult = normalizeCoT(assistantContent, activeProvider);
            updateMessage(assistantId, {
                content: finalResult.content,
                thought: finalResult.thought || undefined
            });

            // Analyze messages for world state changes (background)
            if (character) {
                // Analyze the last user message
                const lastUserMsg = history[history.length - 1];
                if (lastUserMsg && lastUserMsg.role === 'user') {
                    analyzeMessage(lastUserMsg.content, character.name);
                }
                // Also analyze AI response for state changes it describes
                if (assistantContent) {
                    analyzeMessage(assistantContent, character.name);
                }
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('Request aborted');
                return;
            }
            console.error('Chat error:', error);
            // Update the message with error info instead of adding new one, or just leave as is/delete
            if (activeConversationId) {
                updateMessage(assistantId, {
                    content: 'Error: Failed to get response. Check API Key or Network.',
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

        // Construct history for API (include the new message)
        const history = [...messages, newUserMessage];
        await triggerAiReponse(history);
    };

    const handleRegenerate = async (id: string) => {
        if (!activeConversationId) return;

        // Find the message
        const msgIndex = messages.findIndex(m => m.id === id);
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
                <Sidebar onSettingsClick={() => setIsSettingsOpen(true)} />
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
                                    transition={{ type: 'spring' as const, stiffness: 300, damping: 30 }}
                                    className="h-14 border-b border-white/5 flex items-center px-4 justify-between glass-heavy sticky top-0 z-30 shrink-0"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        {/* Mobile Menu Button */}
                                        <MobileSidebar
                                            onCharacterSelect={() => { }}
                                            onSettingsClick={() => setIsSettingsOpen(true)}
                                        />
                                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden shrink-0">
                                            {character.avatar ? (
                                                <img
                                                    src={character.avatar}
                                                    alt={character.name}
                                                    className="w-full h-full object-cover"
                                                />
                                            ) : (
                                                <span className="font-semibold text-xs text-primary">
                                                    {character.name.slice(0, 2).toUpperCase()}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <h2 className="font-semibold text-sm truncate">{character.name}</h2>
                                            <p className="text-[10px] text-muted-foreground truncate opacity-80">
                                                {activeModel}
                                            </p>
                                        </div>
                                    </div>

                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setIsSettingsOpen(true)}
                                        className="shrink-0"
                                    >
                                        <Settings2 className="h-4 w-4" />
                                    </Button>
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
                                            const displayContent = msg.content.replace(/{{user}}/gi, personas.find(p => p.id === activePersonaId)?.name || 'You');

                                            return (
                                                <ChatBubble
                                                    key={msg.id}
                                                    id={msg.id}
                                                    role={msg.role}
                                                    content={displayContent}
                                                    thought={msg.thought}
                                                    avatar={msg.role === 'user' ? (personas.find(p => p.id === activePersonaId)?.avatar) : character.avatar}
                                                    name={msg.role === 'user' ? (personas.find(p => p.id === activePersonaId)?.name || 'You') : character.name}
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
                                <div className={`hidden lg:block absolute right-0 top-0 bottom-0 border-l bg-background/95 backdrop-blur z-10 transition-all duration-300 ${isWorldStateCollapsed ? 'w-[50px] overflow-hidden' : 'w-64 p-4'}`}>
                                    <WorldStatePanel
                                        inventory={worldState.inventory.map(i => i.replace(/{{user}}/gi, personas.find(p => p.id === activePersonaId)?.name || 'You'))}
                                        location={worldState.location.replace(/{{user}}/gi, personas.find(p => p.id === activePersonaId)?.name || 'You')}
                                        relationships={worldState.relationships}
                                        isCollapsed={isWorldStateCollapsed}
                                        onToggle={() => setIsWorldStateCollapsed(!isWorldStateCollapsed)}
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
                            <div className={`mx-auto w-full space-y-2 ${immersiveMode ? 'p-4 max-w-3xl' : 'max-w-4xl'}`}>
                                {!immersiveMode && (
                                    <div className="flex items-center gap-2">
                                        <PersonaSelector />
                                        <ModelSelector />
                                        <ThinkingModeToggle />
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                            onClick={() => setIsLorebookOpen(true)}
                                            title="Lorebook"
                                        >
                                            <Book className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                            onClick={() => setIsTreeOpen(true)}
                                            title="View Branch Tree"
                                        >
                                            <GitBranch className="h-4 w-4" />
                                        </Button>
                                    </div>
                                )}
                                <ChatInput
                                    onSend={handleSend}
                                    onStop={handleStop}
                                    isLoading={isLoading}
                                    disabled={!currentApiKey}
                                    placeholder={!currentApiKey ? 'Missing API Key...' : `Message for ${character.name}...`}
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
                    /* Empty State - No Character Selected */
                    <div className="flex-1 flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="text-center max-w-md space-y-6"
                        >
                            <div className="w-24 h-24 rounded-3xl bg-primary/5 flex items-center justify-center mx-auto rotate-3">
                                <MessageCircle className="w-12 h-12 text-primary/40" />
                            </div>
                            <div className="space-y-2">
                                <h2 className="text-2xl font-bold tracking-tight">Welcome to NexusAI</h2>
                                <p className="text-muted-foreground">
                                    Select or import a character from the sidebar to begin your adventure.
                                </p>
                            </div>
                        </motion.div>
                    </div>
                )}
            </main>

            <SettingsPanel open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />

            <Dialog open={isLorebookOpen} onOpenChange={setIsLorebookOpen}>
                <DialogContent className="max-w-4xl h-[80vh] p-0 overflow-hidden [&>button]:hidden">
                    <DialogTitle className="sr-only">Lorebook Editor</DialogTitle>
                    <LorebookEditor onClose={() => setIsLorebookOpen(false)} />
                </DialogContent>
            </Dialog>

            <TreeVisualization isOpen={isTreeOpen} onClose={() => setIsTreeOpen(false)} />
        </div>
    );
}
