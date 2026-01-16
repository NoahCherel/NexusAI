import { create } from 'zustand';
import type { Message, Conversation, WorldState } from '@/types';
import {
    saveConversation,
    getConversation,
    getConversationsByCharacter,
    deleteConversation as dbDeleteConversation
} from '@/lib/db';

interface ChatState {
    conversations: Conversation[];
    activeConversationId: string | null;
    messages: Message[];
    isStreaming: boolean;
    isLoading: boolean;

    // Actions
    loadConversations: (characterId: string) => Promise<void>;
    createConversation: (characterId: string, title: string) => Promise<string>;
    setActiveConversation: (id: string | null) => void;
    addMessage: (message: Message) => void;
    updateMessage: (id: string, updates: Partial<Message>) => void;
    deleteMessage: (id: string) => void;
    getConversationMessages: (conversationId: string) => Message[];
    getActiveBranchMessages: (conversationId: string) => Message[];
    setStreaming: (streaming: boolean) => void;
    updateWorldState: (conversationId: string, worldState: Partial<WorldState>) => void;
    clearConversation: (conversationId: string) => void;
    navigateToSibling: (messageId: string, direction: 'prev' | 'next') => void;
    getMessageSiblingsInfo: (messageId: string) => { currentIndex: number; total: number };
    persistConversation: (conversationId: string) => Promise<void>;
}

const generateId = () => crypto.randomUUID();

// Helper to serialize dates for IndexedDB
const serializeMessages = (messages: Message[]): Message[] => messages.map(m => ({
    ...m,
    createdAt: new Date(m.createdAt),
}));

export const useChatStore = create<ChatState>()((set, get) => ({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,
    isLoading: true,

    // Load all conversations for a character from IndexedDB
    loadConversations: async (characterId) => {
        try {
            const convs = await getConversationsByCharacter(characterId);
            const allMessages: Message[] = [];
            const conversations: Conversation[] = [];

            for (const conv of convs) {
                conversations.push({
                    id: conv.id,
                    characterId: conv.characterId,
                    title: conv.title,
                    worldState: conv.worldState,
                    createdAt: new Date(conv.createdAt),
                    updatedAt: new Date(conv.updatedAt),
                });
                allMessages.push(...serializeMessages(conv.messages || []));
            }

            set({ conversations, messages: allMessages, isLoading: false });
        } catch (error) {
            console.error('Failed to load conversations:', error);
            set({ isLoading: false });
        }
    },

    // Persist a single conversation to IndexedDB
    persistConversation: async (conversationId) => {
        const state = get();
        const conv = state.conversations.find(c => c.id === conversationId);
        if (!conv) return;

        const messages = state.messages.filter(m => m.conversationId === conversationId);
        await saveConversation({
            ...conv,
            messages,
        });
    },

    createConversation: async (characterId, title) => {
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

        // Persist immediately
        await saveConversation({ ...conversation, messages: [] });

        return id;
    },

    setActiveConversation: (id) => set({ activeConversationId: id }),

    addMessage: (message) =>
        set((state) => {
            // Deactivate siblings (same parent) to ensure only the new message is active in this branch
            const newMessages = state.messages.map(m => {
                if (m.parentId === message.parentId && m.isActiveBranch) {
                    return { ...m, isActiveBranch: false };
                }
                return m;
            });
            return { messages: [...newMessages, message] };
        }),

    updateMessage: (id, updates) =>
        set((state) => ({
            messages: state.messages.map((m) =>
                m.id === id ? { ...m, ...updates } : m
            ),
        })),

    deleteMessage: (id) =>
        set((state) => {
            const msgToDelete = state.messages.find(m => m.id === id);
            if (!msgToDelete) return state;

            // If deleting an active message, try to activate a sibling
            let newMessages = state.messages.filter(m => m.id !== id);

            if (msgToDelete.isActiveBranch && msgToDelete.parentId) {
                const siblings = newMessages.filter(m => m.parentId === msgToDelete.parentId);
                if (siblings.length > 0) {
                    // Activate the first sibling
                    const siblingToActivate = siblings[0];
                    newMessages = newMessages.map(m =>
                        m.id === siblingToActivate.id ? { ...m, isActiveBranch: true } : m
                    );
                }
            }

            // Restore World State from updated active branch
            const conversationId = msgToDelete.conversationId;
            const activeMsgs = newMessages
                .filter(m => m.conversationId === conversationId && m.isActiveBranch)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

            let stateToRestore: WorldState = { inventory: [], location: '', relationships: {} };
            for (const msg of activeMsgs) {
                if (msg.worldStateSnapshot) {
                    stateToRestore = msg.worldStateSnapshot;
                    break;
                }
            }

            const newConversations = state.conversations.map(c =>
                c.id === conversationId ? { ...c, worldState: stateToRestore } : c
            );

            return { messages: newMessages, conversations: newConversations };
        }),

    getConversationMessages: (conversationId) => {
        return get().messages.filter((m) => m.conversationId === conversationId);
    },

    getActiveBranchMessages: (conversationId) => {
        const messages = get().messages.filter(
            (m) => m.conversationId === conversationId
        );

        if (messages.length === 0) return [];

        // Filter by isActiveBranch manually
        return messages
            .filter(m => m.isActiveBranch)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    setStreaming: (isStreaming) => set({ isStreaming }),

    updateWorldState: (conversationId, worldStateUpdates) =>
        set((state) => {
            // 1. Calculate new global state
            const conversation = state.conversations.find(c => c.id === conversationId);
            if (!conversation) return state;

            const oldState = conversation.worldState;
            const newState = { ...oldState, ...worldStateUpdates };

            // 2. Update conversation global state
            const newConversations = state.conversations.map((c) =>
                c.id === conversationId
                    ? {
                        ...c,
                        worldState: newState,
                        updatedAt: new Date(),
                    }
                    : c
            );

            // 3. Snapshot to the latest active message (so it persists for this branch)
            const activeMessages = state.messages
                .filter(m => m.conversationId === conversationId && m.isActiveBranch)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

            let newMessages = state.messages;
            if (activeMessages.length > 0) {
                const lastMsg = activeMessages[0];
                newMessages = state.messages.map(m =>
                    m.id === lastMsg.id ? { ...m, worldStateSnapshot: newState } : m
                );
            }

            return { conversations: newConversations, messages: newMessages };
        }),

    clearConversation: (conversationId) =>
        set((state) => ({
            messages: state.messages.filter((m) => m.conversationId !== conversationId),
        })),

    // Branching Actions
    navigateToSibling: (currentMessageId, direction) => set((state) => {
        const currentMsg = state.messages.find(m => m.id === currentMessageId);
        if (!currentMsg || !currentMsg.parentId) return state;

        // Find all siblings (messages with same parent)
        const siblings = state.messages
            .filter(m => m.parentId === currentMsg.parentId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        const currentIndex = siblings.findIndex(m => m.id === currentMessageId);
        if (currentIndex === -1) return state;

        let targetIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;

        // Bounds check
        if (targetIndex < 0 || targetIndex >= siblings.length) return state;

        const targetMsg = siblings[targetIndex];

        const newMessages = state.messages.map(m => {
            if (m.id === currentMessageId) return { ...m, isActiveBranch: false };
            if (m.id === targetMsg.id) return { ...m, isActiveBranch: true };
            return m;
        });

        // Restore World State from active branch
        const activeMsgs = newMessages
            .filter(m => m.conversationId === currentMsg.conversationId && m.isActiveBranch)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        let stateToRestore: WorldState = { inventory: [], location: '', relationships: {} };
        for (const msg of activeMsgs) {
            if (msg.worldStateSnapshot) {
                stateToRestore = msg.worldStateSnapshot;
                break;
            }
        }

        const newConversations = state.conversations.map(c =>
            c.id === currentMsg.conversationId ? { ...c, worldState: stateToRestore } : c
        );

        return { messages: newMessages, conversations: newConversations };
    }),

    // Selectors
    getMessageSiblingsInfo: (messageId) => {
        const messages = get().messages;
        const currentMsg = messages.find(m => m.id === messageId);
        if (!currentMsg || !currentMsg.parentId) return { currentIndex: 1, total: 1 };

        const siblings = messages
            .filter(m => m.parentId === currentMsg.parentId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        return {
            currentIndex: siblings.findIndex(m => m.id === messageId) + 1,
            total: siblings.length
        };
    },
}));
