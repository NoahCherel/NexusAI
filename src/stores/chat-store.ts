import { create } from 'zustand';
import type { Message, Conversation, WorldState } from '@/types';

interface ChatState {
    conversations: Conversation[];
    activeConversationId: string | null;
    messages: Message[];
    isStreaming: boolean;

    // Actions
    createConversation: (characterId: string, title: string) => string;
    setActiveConversation: (id: string | null) => void;
    addMessage: (message: Message) => void;
    updateMessage: (id: string, updates: Partial<Message>) => void;
    deleteMessage: (id: string) => void;
    getConversationMessages: (conversationId: string) => Message[];
    getActiveBranchMessages: (conversationId: string) => Message[];
    setStreaming: (streaming: boolean) => void;
    updateWorldState: (conversationId: string, worldState: Partial<WorldState>) => void;
    clearConversation: (conversationId: string) => void;
}

const generateId = () => crypto.randomUUID();

export const useChatStore = create<ChatState>()((set, get) => ({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,

    createConversation: (characterId, title) => {
        const id = generateId();
        const conversation: Conversation = {
            id,
            characterId,
            title,
            worldState: {
                inventory: [],
                location: '',
                relationships: {},
            },
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        set((state) => ({
            conversations: [...state.conversations, conversation],
            activeConversationId: id,
        }));
        return id;
    },

    setActiveConversation: (id) => set({ activeConversationId: id }),

    addMessage: (message) =>
        set((state) => ({
            messages: [...state.messages, message],
        })),

    updateMessage: (id, updates) =>
        set((state) => ({
            messages: state.messages.map((m) =>
                m.id === id ? { ...m, ...updates } : m
            ),
        })),

    deleteMessage: (id) =>
        set((state) => ({
            messages: state.messages.filter((m) => m.id !== id),
        })),

    getConversationMessages: (conversationId) => {
        return get().messages.filter((m) => m.conversationId === conversationId);
    },

    getActiveBranchMessages: (conversationId) => {
        const messages = get().messages.filter(
            (m) => m.conversationId === conversationId && m.isActiveBranch
        );
        // Sort by creation date
        return messages.sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        );
    },

    setStreaming: (isStreaming) => set({ isStreaming }),

    updateWorldState: (conversationId, worldStateUpdates) =>
        set((state) => ({
            conversations: state.conversations.map((c) =>
                c.id === conversationId
                    ? {
                        ...c,
                        worldState: { ...c.worldState, ...worldStateUpdates },
                        updatedAt: new Date(),
                    }
                    : c
            ),
        })),

    clearConversation: (conversationId) =>
        set((state) => ({
            messages: state.messages.filter((m) => m.conversationId !== conversationId),
        })),
}));
