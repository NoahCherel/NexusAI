import { create } from 'zustand';
import type { Message, Conversation, WorldState, ArcCompass, DirectedRelationship } from '@/types';
import {
    saveConversation,
    getConversationsByCharacter,
    saveMessage,
    getConversationMessages,
    deleteMessagedb,
} from '@/lib/db';

interface ChatState {
    conversations: Conversation[];
    activeConversationId: string | null;
    messages: Message[];
    isStreaming: boolean;
    isLoading: boolean;
    loadedCharacterId: string | null;

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
    updateConversationNotes: (conversationId: string, notes: string[]) => void;
    updateStoryGuidance: (conversationId: string, guidance: string) => void;
    updateScratchpad: (conversationId: string, scratchpad: string) => void;
    updateArc: (conversationId: string, arc: ArcCompass) => void;
    appendRpJournal: (conversationId: string, character: string, note: string) => void;
    setRpJournalForCharacter: (conversationId: string, character: string, notes: string[]) => void;
    setMomentumNudge: (conversationId: string, nudge: string | undefined) => void;
    setRelationships: (conversationId: string, relationships: DirectedRelationship[]) => void;
    clearConversation: (conversationId: string) => void;
    navigateToSibling: (messageId: string, direction: 'prev' | 'next') => void;
    navigateToMessage: (messageId: string) => void;
    getMessageSiblingsInfo: (messageId: string) => { currentIndex: number; total: number };
    loadMessages: (conversationId: string) => Promise<void>;
}

const generateId = () => crypto.randomUUID();

// Helper to serialize dates for IndexedDB
const serializeMessages = (messages: Message[]): Message[] =>
    messages.map((m) => ({
        ...m,
        createdAt: new Date(m.createdAt),
    }));

const getMessageTime = (message: Message) => new Date(message.createdAt).getTime();

const sortByTimeline = (a: Message, b: Message) => {
    const orderDelta = a.messageOrder - b.messageOrder;
    if (orderDelta !== 0) return orderDelta;
    return getMessageTime(a) - getMessageTime(b);
};

const getDescendantIds = (messages: Message[], parentId: string): Set<string> => {
    const descendants = new Set<string>();
    const queue = messages.filter((m) => m.parentId === parentId).map((m) => m.id);

    while (queue.length > 0) {
        const id = queue.shift()!;
        if (descendants.has(id)) continue;
        descendants.add(id);
        queue.push(...messages.filter((m) => m.parentId === id).map((m) => m.id));
    }

    return descendants;
};

const getMessagePath = (messages: Message[], leafId: string): Message[] => {
    const byId = new Map(messages.map((m) => [m.id, m]));
    const path: Message[] = [];
    let current = byId.get(leafId);

    while (current) {
        path.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    return path.reverse();
};

const chooseBranchLeaf = (messages: Message[]): Message | undefined => {
    if (messages.length === 0) return undefined;

    const activeMessages = messages.filter((m) => m.isActiveBranch);
    const candidates = activeMessages.length > 0 ? activeMessages : messages;
    const parentIds = new Set(
        candidates
            .map((m) => m.parentId)
            .filter((parentId): parentId is string => Boolean(parentId))
    );
    const leaves = candidates.filter((m) => !parentIds.has(m.id));
    const leafCandidates = leaves.length > 0 ? leaves : candidates;

    return [...leafCandidates].sort((a, b) => {
        const timeDelta = getMessageTime(a) - getMessageTime(b);
        if (timeDelta !== 0) return timeDelta;
        return a.messageOrder - b.messageOrder;
    })[leafCandidates.length - 1];
};

const getBranchPathThroughMessage = (messages: Message[], targetMessage: Message): Message[] => {
    const ancestorPath = getMessagePath(messages, targetMessage.id);
    const subtreeIds = getDescendantIds(messages, targetMessage.id);
    const subtreeMessages = messages.filter((m) => subtreeIds.has(m.id));

    if (subtreeMessages.length === 0) return ancestorPath;

    const leaf = chooseBranchLeaf(subtreeMessages);
    if (!leaf) return ancestorPath;

    const descendantPath = getMessagePath(messages, leaf.id).filter(
        (m) => m.id !== targetMessage.id && subtreeIds.has(m.id)
    );

    return [...ancestorPath, ...descendantPath];
};

export const getActiveBranchPath = (messages: Message[]): Message[] => {
    const leaf = chooseBranchLeaf(messages);
    if (!leaf) return [];

    const path = getMessagePath(messages, leaf.id);
    const root = path[0];
    if (!root) return path;

    const pathIds = new Set(path.map((m) => m.id));
    const legacyFlatPrefix = messages
        .filter(
            (m) =>
                m.isActiveBranch &&
                !pathIds.has(m.id) &&
                !m.parentId &&
                m.messageOrder < root.messageOrder
        )
        .sort(sortByTimeline);

    return [...legacyFlatPrefix, ...path];
};

export const useChatStore = create<ChatState>()((set, get) => ({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,
    isLoading: true,
    loadedCharacterId: null,

    // Load all conversations for a character from IndexedDB (Metadata only)
    loadConversations: async (characterId) => {
        set({ isLoading: true });
        try {
            const convs = await getConversationsByCharacter(characterId);
            // Preserve EVERY persisted field (relationships, arc, rpJournal, scratchpad,
            // storyGuidance, notes, momentumNudge, worldStates, …). The previous explicit
            // allow-list silently dropped all of these on reload even though they were saved.
            const conversations: Conversation[] = convs.map((conv) => ({
                ...conv,
                createdAt: new Date(conv.createdAt),
                updatedAt: new Date(conv.updatedAt),
            }));

            // Restore active conversation for this character if valid
            let activeConvId = get().activeConversationId;
            if (typeof window !== 'undefined') {
                const persistedId = localStorage.getItem(`nexusai_active_conv_${characterId}`);
                // Verify it belongs to loaded conversations
                if (persistedId && conversations.some((c) => c.id === persistedId)) {
                    activeConvId = persistedId;
                } else if (conversations.length > 0 && !activeConvId) {
                    // Default to most recent if none selected
                    const sorted = [...conversations].sort(
                        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
                    );
                    activeConvId = sorted[0].id;
                }
            }

            // Load messages for the active conversation
            let activeMessages: Message[] = [];
            if (activeConvId) {
                const dbMessages = await getConversationMessages(activeConvId);
                activeMessages = serializeMessages(dbMessages);
            }

            set({
                conversations,
                messages: activeMessages,
                activeConversationId: activeConvId,
                isLoading: false,
                loadedCharacterId: characterId,
            });
        } catch (error) {
            console.error('Failed to load conversations:', error);
            set({ isLoading: false, loadedCharacterId: null });
        }
    },

    // Load messages for a specific conversation
    loadMessages: async (conversationId) => {
        try {
            const dbMessages = await getConversationMessages(conversationId);
            const messages = serializeMessages(dbMessages);
            set({ messages });
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
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

        if (typeof window !== 'undefined') {
            localStorage.setItem(`nexusai_active_conv_${characterId}`, id);
        }

        // Persist immediately (Metadata only)
        await saveConversation(conversation);

        return id;
    },

    setActiveConversation: (id) => {
        set({ activeConversationId: id, messages: [] }); // Clear current messages immediately to avoid ghosting

        if (id) {
            get().loadMessages(id);

            // We need the character ID to namespace the active conversation
            const state = get();
            const conv = state.conversations.find((c) => c.id === id);
            if (typeof window !== 'undefined' && conv) {
                localStorage.setItem(`nexusai_active_conv_${conv.characterId}`, id);
            }
        }
    },

    addMessage: (message) => {
        // Calculate messageOrder and regenerationIndex
        const state = get();
        const messages = state.messages;
        let changedExistingMessages: Message[] = [];

        // Calculate messageOrder by finding parent chain depth
        let messageOrder = 1;
        let currentParentId = message.parentId;
        while (currentParentId) {
            messageOrder++;
            const parent = messages.find((m) => m.id === currentParentId);
            currentParentId = parent?.parentId || null;
        }

        // Calculate regenerationIndex by counting siblings
        const siblings = messages.filter((m) => m.parentId === message.parentId);
        const regenerationIndex = siblings.length;

        // Add calculated fields to message
        const enrichedMessage: Message = {
            ...message,
            messageOrder,
            regenerationIndex,
        };

        set((state) => {
            const messagesInConversation = state.messages.filter(
                (m) => m.conversationId === enrichedMessage.conversationId
            );
            const siblingIds = messagesInConversation
                .filter((m) => m.parentId === enrichedMessage.parentId)
                .map((m) => m.id);
            const idsToDeactivate = new Set<string>(siblingIds);
            siblingIds.forEach((siblingId) => {
                getDescendantIds(messagesInConversation, siblingId).forEach((id) =>
                    idsToDeactivate.add(id)
                );
            });

            // Selecting a new sibling invalidates the old sibling branches below that parent.
            const newMessages = state.messages.map((m) => {
                if (idsToDeactivate.has(m.id) && m.isActiveBranch) {
                    return { ...m, isActiveBranch: false };
                }
                return m;
            });

            changedExistingMessages = newMessages.filter((newMsg, idx) => {
                const oldMsg = state.messages[idx];
                return oldMsg && oldMsg.isActiveBranch !== newMsg.isActiveBranch;
            });

            return { messages: [...newMessages, enrichedMessage] };
        });

        changedExistingMessages.forEach((msg) => saveMessage(msg).catch(console.error));
        saveMessage(enrichedMessage).catch(console.error);
    },

    updateMessage: (id, updates) => {
        let updatedMessage: Message | undefined;
        set((state) => ({
            messages: state.messages.map((m) => {
                if (m.id === id) {
                    updatedMessage = { ...m, ...updates };
                    return updatedMessage;
                }
                return m;
            }),
        }));

        // Persist message
        if (updatedMessage) {
            saveMessage(updatedMessage).catch(console.error);
        }
    },

    deleteMessage: (id) => {
        let conversationId: string | undefined;
        let conversationToUpdate: Conversation | undefined;

        set((state) => {
            const msgToDelete = state.messages.find((m) => m.id === id);
            if (!msgToDelete) return state;

            conversationId = msgToDelete.conversationId;

            // If deleting an active message, try to activate a sibling
            let newMessages = state.messages.filter((m) => m.id !== id);

            if (msgToDelete.isActiveBranch && msgToDelete.parentId) {
                const siblings = newMessages.filter((m) => m.parentId === msgToDelete.parentId);
                if (siblings.length > 0) {
                    // Activate the first sibling
                    const siblingToActivate = siblings[0];
                    newMessages = newMessages.map((m) =>
                        m.id === siblingToActivate.id ? { ...m, isActiveBranch: true } : m
                    );
                }
            }

            // Restore World State from updated active branch
            const activeMsgs = newMessages
                .filter((m) => m.conversationId === conversationId && m.isActiveBranch)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

            let stateToRestore: WorldState = { inventory: [], location: '', relationships: {} };
            for (const msg of activeMsgs) {
                if (msg.worldStateSnapshot) {
                    stateToRestore = msg.worldStateSnapshot;
                    break;
                }
            }

            const newConversations = state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = { ...c, worldState: stateToRestore };
                    return conversationToUpdate;
                }
                return c;
            });

            return { messages: newMessages, conversations: newConversations };
        });

        // Persist deletion and potential world state update
        deleteMessagedb(id).catch(console.error);
        if (conversationToUpdate) {
            saveConversation(conversationToUpdate).catch(console.error);
        }
    },

    getConversationMessages: (conversationId) => {
        return get().messages.filter((m) => m.conversationId === conversationId);
    },

    getActiveBranchMessages: (conversationId) => {
        const messages = get().messages.filter((m) => m.conversationId === conversationId);

        if (messages.length === 0) return [];

        return getActiveBranchPath(messages);
    },

    setStreaming: (isStreaming) => set({ isStreaming }),

    updateWorldState: (conversationId, worldStateUpdates) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => {
            // 1. Calculate new global state
            const conversation = state.conversations.find((c) => c.id === conversationId);
            if (!conversation) return state;

            const oldState = conversation.worldState;
            const newState = { ...oldState, ...worldStateUpdates };

            // 2. Update conversation global state
            const newConversations = state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = {
                        ...c,
                        worldState: newState,
                        updatedAt: new Date(),
                    };
                    return conversationToUpdate;
                }
                return c;
            });

            // 3. Snapshot to the latest active message (so it persists for this branch)
            const activeMessages = state.messages
                .filter((m) => m.conversationId === conversationId && m.isActiveBranch)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

            let newMessages = state.messages;
            if (activeMessages.length > 0) {
                const lastMsg = activeMessages[0];
                if (lastMsg.worldStateSnapshot !== newState) {
                    newMessages = state.messages.map((m) =>
                        m.id === lastMsg.id ? { ...m, worldStateSnapshot: newState } : m
                    );
                    // Also need to save the message with the new snapshot
                    saveMessage({ ...lastMsg, worldStateSnapshot: newState }).catch(console.error);
                }
            }

            return {
                conversations: newConversations,
                messages: newMessages,
            };
        });

        // Persist conversation update
        if (conversationToUpdate) {
            saveConversation(conversationToUpdate).catch(console.error);
        }
    },

    updateConversationNotes: (conversationId, notes) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => {
            const newConversations = state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = {
                        ...c,
                        notes,
                        updatedAt: new Date(),
                    };
                    return conversationToUpdate;
                }
                return c;
            });
            return { conversations: newConversations };
        });
        if (conversationToUpdate) {
            saveConversation(conversationToUpdate).catch(console.error);
        }
    },

    updateStoryGuidance: (conversationId, guidance) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => {
            const newConversations = state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = {
                        ...c,
                        storyGuidance: guidance,
                        updatedAt: new Date(),
                    };
                    return conversationToUpdate;
                }
                return c;
            });
            return { conversations: newConversations };
        });
        if (conversationToUpdate) {
            saveConversation(conversationToUpdate).catch(console.error);
        }
    },

    updateScratchpad: (conversationId, scratchpad) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => {
            const newConversations = state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = {
                        ...c,
                        scratchpad: scratchpad,
                        updatedAt: new Date(),
                    };
                    return conversationToUpdate;
                }
                return c;
            });
            return { conversations: newConversations };
        });
        if (conversationToUpdate) {
            saveConversation(conversationToUpdate).catch(console.error);
        }
    },

    updateArc: (conversationId, arc) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = { ...c, arc, updatedAt: new Date() };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    appendRpJournal: (conversationId, character, note) => {
        const trimmed = note.trim();
        if (!trimmed) return;
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    const journal = { ...(c.rpJournal || {}) };
                    const existing = journal[character] || [];
                    // Avoid duplicate consecutive notes
                    if (existing[existing.length - 1] !== trimmed) {
                        journal[character] = [...existing, trimmed];
                    }
                    conversationToUpdate = { ...c, rpJournal: journal, updatedAt: new Date() };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    setRpJournalForCharacter: (conversationId, character, notes) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    const journal = { ...(c.rpJournal || {}) };
                    const cleaned = notes.map((n) => n.trim()).filter(Boolean);
                    if (cleaned.length > 0) journal[character] = cleaned;
                    else delete journal[character];
                    conversationToUpdate = { ...c, rpJournal: journal, updatedAt: new Date() };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    setMomentumNudge: (conversationId, nudge) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = { ...c, momentumNudge: nudge, updatedAt: new Date() };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    setRelationships: (conversationId, relationships) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = { ...c, relationships, updatedAt: new Date() };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    clearConversation: (conversationId) =>
        set((state) => ({
            messages: state.messages.filter((m) => m.conversationId !== conversationId),
        })),

    // Branching Actions
    navigateToSibling: (currentMessageId, direction) =>
        set((state) => {
            const currentMsg = state.messages.find((m) => m.id === currentMessageId);
            if (!currentMsg || !currentMsg.parentId) return state;

            // Find all siblings (messages with same parent)
            const siblings = state.messages
                .filter((m) => m.parentId === currentMsg.parentId)
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

            const currentIndex = siblings.findIndex((m) => m.id === currentMessageId);
            if (currentIndex === -1) return state;

            const targetIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;

            // Bounds check
            if (targetIndex < 0 || targetIndex >= siblings.length) return state;

            const targetMsg = siblings[targetIndex];
            const messagesInConversation = state.messages.filter(
                (m) => m.conversationId === currentMsg.conversationId
            );
            const targetPathIds = new Set(
                getBranchPathThroughMessage(messagesInConversation, targetMsg).map((m) => m.id)
            );

            const newMessages = state.messages.map((m) => {
                if (m.conversationId !== currentMsg.conversationId) return m;
                const shouldBeActive = targetPathIds.has(m.id);
                if (m.isActiveBranch !== shouldBeActive) {
                    return { ...m, isActiveBranch: shouldBeActive };
                }
                return m;
            });

            // Restore World State from active branch
            const activeMsgs = newMessages
                .filter((m) => m.conversationId === currentMsg.conversationId && m.isActiveBranch)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

            let stateToRestore: WorldState = { inventory: [], location: '', relationships: {} };
            for (const msg of activeMsgs) {
                if (msg.worldStateSnapshot) {
                    stateToRestore = msg.worldStateSnapshot;
                    break;
                }
            }

            const newConversations = state.conversations.map((c) =>
                c.id === currentMsg.conversationId ? { ...c, worldState: stateToRestore } : c
            );

            // Persist all changed messages to DB
            const changedMessages = newMessages.filter((newMsg, idx) => {
                const oldMsg = state.messages[idx];
                return oldMsg && oldMsg.isActiveBranch !== newMsg.isActiveBranch;
            });
            changedMessages.forEach((msg) => saveMessage(msg).catch(console.error));

            return { messages: newMessages, conversations: newConversations };
        }),

    navigateToMessage: (messageId) =>
        set((state) => {
            const targetMessage = state.messages.find((m) => m.id === messageId);
            if (!targetMessage) return state;

            // 1. Identify valid path (ancestors + target)
            const pathIds = new Set<string>();
            let iterator: Message | undefined = targetMessage;
            while (iterator) {
                pathIds.add(iterator.id);
                iterator = state.messages.find((m) => m.id === iterator?.parentId);
            }

            // 2. Update branch flags
            const newMessages = state.messages.map((m) => {
                if (m.conversationId !== targetMessage.conversationId) return m;
                const shouldBeActive = pathIds.has(m.id);
                if (m.isActiveBranch !== shouldBeActive) {
                    return { ...m, isActiveBranch: shouldBeActive };
                }
                return m;
            });

            // 3. Restore World State from target message (if it has a snapshot, or calculate?)
            // For now, if the target message has a snapshot, use it.
            // Otherwise, we might need to re-calculate (complex).
            // We'll use the 'latest snapshot on path' approach.

            const activePath = newMessages
                .filter((m) => pathIds.has(m.id))
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

            let stateToRestore = state.conversations.find(
                (c) => c.id === targetMessage.conversationId
            )?.worldState; // Default to current

            // Try to find a snapshot on the path, starting from leaf
            for (const msg of activePath) {
                if (msg.worldStateSnapshot) {
                    stateToRestore = msg.worldStateSnapshot;
                    break;
                }
            }

            const newConversations = state.conversations.map((c) =>
                c.id === targetMessage.conversationId
                    ? { ...c, worldState: stateToRestore || c.worldState }
                    : c
            );

            // Persist all changed messages to DB
            const changedMessages = newMessages.filter((newMsg, idx) => {
                const oldMsg = state.messages[idx];
                return oldMsg && oldMsg.isActiveBranch !== newMsg.isActiveBranch;
            });
            changedMessages.forEach((msg) => saveMessage(msg).catch(console.error));

            return { messages: newMessages, conversations: newConversations };
        }),

    // Selectors
    getMessageSiblingsInfo: (messageId) => {
        const messages = get().messages;
        const currentMsg = messages.find((m) => m.id === messageId);
        if (!currentMsg || !currentMsg.parentId) return { currentIndex: 1, total: 1 };

        const siblings = messages
            .filter((m) => m.parentId === currentMsg.parentId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        return {
            currentIndex: siblings.findIndex((m) => m.id === messageId) + 1,
            total: siblings.length,
        };
    },
}));
