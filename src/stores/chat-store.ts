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
    navigateToSibling: (messageId: string, direction: 'prev' | 'next') => void;
    getMessageSiblingsInfo: (messageId: string) => { currentIndex: number; total: number };
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
        set((state) => ({
            messages: state.messages.filter((m) => m.id !== id),
        })),

    getConversationMessages: (conversationId) => {
        return get().messages.filter((m) => m.conversationId === conversationId);
    },

    getActiveBranchMessages: (conversationId) => {
        const messages = get().messages.filter(
            (m) => m.conversationId === conversationId
        );

        if (messages.length === 0) return [];

        // Build a map for O(1) access
        const msgMap = new Map(messages.map(m => [m.id, m]));

        // Find the leaf node of the active branch
        // For simplicity, we assume there's one "active" leaf or we track the path.
        // Current implementation uses isActiveBranch flag.

        // Filter by isActiveBranch manually
        return messages
            .filter(m => m.isActiveBranch)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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

        // 1. Deactivate current branch recursively downwards
        // (This is complex, for MVP we just toggle the sibling pair active status if they are leaves or switch the path)
        // A simpler approach for MVP:
        // Set all siblings to inactive, set target to active.
        // And ensure all children of the new active one that were previously active become active?
        // No, we just need to switch the "active pointer" at this node.

        // Let's implement a recursive "setActivePath" helper if needed, but for now:

        const newMessages = state.messages.map(m => {
            if (m.id === currentMessageId) return { ...m, isActiveBranch: false };
            if (m.id === targetMsg.id) return { ...m, isActiveBranch: true };
            return m;
        });

        return { messages: newMessages };
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
