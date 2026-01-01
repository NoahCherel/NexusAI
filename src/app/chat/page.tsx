'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageCircle, Settings2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatBubble, ChatInput, WorldStatePanel, PersonaSelector } from '@/components/chat';
import { Sidebar, SettingsPanel } from '@/components/layout';
import { useCharacterStore, useSettingsStore } from '@/stores';
import { decryptApiKey } from '@/lib/crypto';
import type { CharacterCard } from '@/types';

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    thought?: string;
}

export default function ChatPage() {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [currentApiKey, setCurrentApiKey] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    const { getActiveCharacter } = useCharacterStore();
    const {
        apiKeys,
        activeProvider,
        activeModel,
        temperature,
        showThoughts,
        showWorldState,
        activePersonaId,
        personas,
        enableReasoning
    } = useSettingsStore();
    const character = getActiveCharacter();

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

    // Initialize with first message when character changes
    useEffect(() => {
        if (character?.first_mes) {
            setMessages([{
                id: 'first-message',
                role: 'assistant',
                content: character.first_mes,
            }]);
        } else {
            setMessages([]);
        }
    }, [character?.id, character?.first_mes]);

    // Build system prompt from character
    const buildSystemPrompt = useCallback((char: CharacterCard) => {
        let prompt = char.system_prompt || '';

        if (!prompt) {
            prompt = `You are ${char.name}. ${char.description}\n\nPersonality: ${char.personality}\n\nScenario: ${char.scenario}`;
        }

        if (char.mes_example) {
            prompt += `\n\nExample dialogue:\n${char.mes_example}`;
        }

        return prompt;
    }, []);

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const triggerAiReponse = async (history: ChatMessage[]) => {
        if (!currentApiKey || !character) return;
        setIsLoading(true);

        const activePersona = personas.find(p => p.id === activePersonaId);

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: history.map(({ id, role, content }) => ({ role, content })), // Clean message objects
                    provider: activeProvider,
                    model: activeModel,
                    temperature,
                    apiKey: currentApiKey,
                    systemPrompt: buildSystemPrompt(character),
                    userPersona: activePersona,
                    enableReasoning,
                }),
            });

            if (!response.ok) {
                throw new Error('Failed to get response');
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader');

            const decoder = new TextDecoder();
            let assistantContent = '';
            let assistantThought = '';
            const assistantId = crypto.randomUUID();

            // Add empty assistant message
            setMessages(prev => [...prev, {
                id: assistantId,
                role: 'assistant',
                content: '',
            }]);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });

                // Simple parsing for thoughts if they come mixed in text (rare with SDK but possible)
                // Actually with exclude_reasoning: false (SDK default if not specified), logical thinking might be in separate field or regular delta.
                // The API route handles calling .toTextStreamResponse() or .toDataStreamResponse().
                // If using data stream, we need to handle data protocol.
                // But current implementation uses simple text stream.
                // DeepSeek R1 via OpenRouter often sends <think> tags content.

                assistantContent += chunk;

                // Update the assistant message
                setMessages(prev => prev.map(m =>
                    m.id === assistantId ? { ...m, content: assistantContent } : m
                ));
            }
        } catch (error) {
            console.error('Chat error:', error);
            setMessages(prev => [...prev, {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: 'Erreur: Impossible d\'obtenir une réponse. Vérifiez votre clé API.',
            }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSend = async (userMessage: string) => {
        const newUserMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content: userMessage,
        };

        const newHistory = [...messages, newUserMessage];
        setMessages(newHistory);
        await triggerAiReponse(newHistory);
    };

    const handleRegenerate = (id: string) => {
        // Find the message index
        const msgIndex = messages.findIndex(m => m.id === id);
        if (msgIndex === -1) return;

        // If it's an assistant message, regenerate it based on history up to that point
        if (messages[msgIndex].role === 'assistant') {
            // Get history up to the previous user message
            const history = messages.slice(0, msgIndex);

            // Delete this message and all after
            setMessages(prev => prev.slice(0, msgIndex));

            // Trigger AI
            triggerAiReponse(history);
        }
    };

    const handleEditMessage = (id: string, newContent: string) => {
        setMessages(prev => prev.map(m =>
            m.id === id ? { ...m, content: newContent } : m
        ));
    };

    const handleDeleteMessage = (id: string) => {
        setMessages(prev => {
            const index = prev.findIndex(m => m.id === id);
            if (index === -1) return prev;
            return prev.slice(0, index);
        });
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
            <Sidebar onSettingsClick={() => setIsSettingsOpen(true)} />

            <main className="flex-1 flex flex-col min-w-0">
                {character ? (
                    <>
                        {/* Header */}
                        <header className="h-14 border-b flex items-center px-4 justify-between bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-background/60 shrink-0">
                            <div className="flex items-center gap-3 min-w-0">
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
                        </header>

                        <div className="flex-1 flex flex-col min-h-0 relative">
                            {/* Messages Area */}
                            <div className="flex-1 overflow-y-auto w-full scroll-smooth">
                                <div className="max-w-3xl mx-auto p-4 space-y-6 pb-4">
                                    {messages.length === 0 ? (
                                        <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-4 py-20 opacity-50">
                                            <div className="p-4 rounded-full bg-muted/50">
                                                <Sparkles className="h-8 w-8" />
                                            </div>
                                            <p>L'histoire commence ici...</p>
                                        </div>
                                    ) : (
                                        messages.map((msg) => (
                                            <ChatBubble
                                                key={msg.id}
                                                id={msg.id}
                                                role={msg.role}
                                                content={msg.content}
                                                thought={msg.thought}
                                                avatar={msg.role === 'user' ? (personas.find(p => p.id === activePersonaId)?.avatar) : character.avatar}
                                                name={msg.role === 'user' ? (personas.find(p => p.id === activePersonaId)?.name || 'Vous') : character.name}
                                                showThoughts={showThoughts}
                                                onEdit={handleEditMessage}
                                                onRegenerate={handleRegenerate}
                                                onBranch={handleBranch}
                                                onDelete={handleDeleteMessage}
                                            />
                                        ))
                                    )}
                                    {isLoading && (
                                        <div className="flex gap-4 max-w-[85%]">
                                            <div className="w-8 h-8 rounded-full bg-primary/10 shrink-0 overflow-hidden mt-1">
                                                {character.avatar && <img src={character.avatar} className="w-full h-full object-cover" />}
                                            </div>
                                            <div className="bg-muted/50 rounded-2xl rounded-tl-none px-4 py-3">
                                                <div className="flex gap-1">
                                                    <span className="w-1.5 h-1.5 bg-foreground/30 rounded-full animate-bounce" />
                                                    <span className="w-1.5 h-1.5 bg-foreground/30 rounded-full animate-bounce [animation-delay:0.1s]" />
                                                    <span className="w-1.5 h-1.5 bg-foreground/30 rounded-full animate-bounce [animation-delay:0.2s]" />
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                    <div ref={scrollRef} />
                                </div>
                            </div>

                            {/* World State Panel (Overlay or Side) */}
                            {showWorldState && (
                                <div className="hidden lg:block absolute right-0 top-0 bottom-0 w-64 border-l bg-background/95 backdrop-blur p-4 z-10">
                                    <WorldStatePanel
                                        inventory={['Épée rouillée', 'Potion de soin']}
                                        location="Forêt sombre"
                                        relationships={{ [character.name]: 50 }}
                                    />
                                </div>
                            )}
                        </div>

                        {/* Input Area */}
                        <div className="p-4 border-t bg-background/80 backdrop-blur z-20">
                            <div className="max-w-4xl mx-auto w-full space-y-2">
                                <PersonaSelector />
                                <ChatInput
                                    onSend={handleSend}
                                    isLoading={isLoading}
                                    disabled={!currentApiKey}
                                    placeholder={!currentApiKey ? 'Clé API manquante...' : `Message pour ${character.name}...`}
                                />
                                <div className="text-center">
                                    <span className="text-[10px] text-muted-foreground/40 font-mono">
                                        {enableReasoning ? 'THINKING MODE ON' : 'STANDARD MODE'}
                                    </span>
                                </div>
                            </div>
                        </div>
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
                                <h2 className="text-2xl font-bold tracking-tight">Bienvenue sur NexusAI</h2>
                                <p className="text-muted-foreground">
                                    Sélectionnez ou importez un personnage dans le menu latéral pour commencer votre aventure.
                                </p>
                            </div>
                        </motion.div>
                    </div>
                )}
            </main>

            <SettingsPanel open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />
        </div>
    );
}
