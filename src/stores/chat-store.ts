import { create } from 'zustand';
import type {
    Message,
    Conversation,
    ArcCompass,
    DirectedRelationship,
    CharacterRef,
} from '@/types';
import {
    saveConversation,
    patchConversation,
    patchStoredMessage,
    commitUserMessage as persistUserMessage,
    getConversationsByCharacter,
    saveMessage,
    getConversationMessages,
    deleteMessagedb,
} from '@/lib/db';
import { useSettingsStore } from '@/stores/settings-store';
import { resolvePersonaId } from '@/lib/conversation-persona';
import { mainCharacterBond } from '@/lib/ai/relationship-context';

interface ChatState {
    conversations: Conversation[];
    activeConversationId: string | null;
    messages: Message[];
    isStreaming: boolean;
    isLoading: boolean;
    loadedCharacterId: string | null;

    setConversationPersona: (id: string, personaId: string | null) => Promise<void>;
    setDraft: (id: string, text: string) => Promise<void>;
    initializePersona: (id: string, messages: Message[]) => Promise<void>;
    // Actions
    loadConversations: (characterId: string) => Promise<void>;
    /**
     * `characterName` seeds the one automatic relationship (player ↔ that character). Omit it
     * to start with no bonds at all — imports restore their own.
     */
    createConversation: (
        characterId: string,
        title: string,
        characterName?: string
    ) => Promise<string>;
    setActiveConversation: (id: string | null) => void;
    addMessage: (message: Message, persisted?: boolean) => void;
    commitUserMessage: (message: Message) => Promise<void>;
    /** Apply messages already committed by one IndexedDB scene transaction in one render. */
    applyCommittedSceneBeat: (params: {
        conversationId: string;
        messages: Message[];
        storyStateRevisionId: string;
        roster: string[];
    }) => void;
    applyStoryStateRevision: (params: {
        conversationId: string;
        messageId: string;
        storyStateRevisionId: string;
        roster: string[];
    }) => void;
    updateMessage: (
        id: string,
        updates: Partial<Message>,
        options?: {
            /**
             * false = store-only update, no IndexedDB write. Used by the streaming hot
             * path (one IDB put per chunk of a growing message is quadratic I/O); the
             * caller MUST persist once at stream end/error/abort.
             */
            persist?: boolean;
        }
    ) => void;
    deleteMessage: (id: string) => void;
    getConversationMessages: (conversationId: string) => Message[];
    getActiveBranchMessages: (conversationId: string) => Message[];
    setStreaming: (streaming: boolean) => void;
    updateConversationNotes: (conversationId: string, notes: string[]) => void;
    updateStoryGuidance: (conversationId: string, guidance: string) => void;
    updateScratchpad: (conversationId: string, scratchpad: string) => void;
    updateArc: (conversationId: string, arc: ArcCompass) => void;
    appendRpJournal: (conversationId: string, character: string, note: string) => void;
    setRpJournalForCharacter: (conversationId: string, character: string, notes: string[]) => void;
    setMomentumNudge: (conversationId: string, nudge: string | undefined) => void;
    setHistoryCut: (conversationId: string, messageId: string | undefined) => void;
    /** Single write for both history-window fields. Pass only the ones that changed. */
    setHistoryWindowState: (
        conversationId: string,
        state: { cutMessageId?: string; dynamicReserveTokens?: number }
    ) => void;
    setStickyCast: (conversationId: string, stickyCast: Record<string, number>) => void;
    setSceneMode: (conversationId: string, sceneMode: boolean) => void;
    setSceneRoster: (conversationId: string, roster: string[]) => void;
    setSceneCharacterOverride: (
        conversationId: string,
        displayName: string,
        character: CharacterRef
    ) => void;
    setSceneStyle: (conversationId: string, style: 'turns' | 'composed-turns' | 'unified') => void;
    setDirectedNarrativeVersion: (conversationId: string, version: 1 | 2) => void;
    setDirectedSceneSuggestionDismissed: (conversationId: string, dismissed: boolean) => void;
    setBanList: (conversationId: string, banList: string[]) => void;
    getActiveBranchBanList: (conversationId: string) => string[];
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
    // One O(n) index instead of an O(n) filter per BFS node (O(n²) on deep trees).
    const childrenByParent = new Map<string, string[]>();
    for (const m of messages) {
        if (!m.parentId) continue;
        const siblings = childrenByParent.get(m.parentId);
        if (siblings) siblings.push(m.id);
        else childrenByParent.set(m.parentId, [m.id]);
    }

    const descendants = new Set<string>();
    const queue = [...(childrenByParent.get(parentId) ?? [])];
    while (queue.length > 0) {
        const id = queue.pop()!;
        if (descendants.has(id)) continue;
        descendants.add(id);
        const children = childrenByParent.get(id);
        if (children) queue.push(...children);
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

/**
 * Load fencing. Every asynchronous read races against the user clicking another conversation:
 * IndexedDB reads settle out of order, so an older read could publish its messages *after* a
 * newer one and leave the store showing conversation A while B is selected.
 *
 * Two counters rather than one, because the two reads publish different things: a newer message
 * read must not cancel the conversation list an in-flight `loadConversations` is about to
 * deliver. `loadConversations` bumps both — it publishes messages too.
 */
// Serialize per-conversation acknowledgements, including draft writes queued just before Send.
const metadataWrites = new Map<string, Promise<void>>();
function queueConversationWrite<T>(id: string, write: () => Promise<T>): Promise<T> {
    const result = (metadataWrites.get(id) || Promise.resolve()).then(write);
    const settled = result.then(
        () => {},
        () => {}
    );
    metadataWrites.set(id, settled);
    void settled.then(() => {
        if (metadataWrites.get(id) === settled) metadataWrites.delete(id);
    });
    return result;
}
const localFields = new Map<string, Pick<Conversation, 'draftText' | 'lastPersonaId'>>();
let conversationsLoadGeneration = 0;
let messagesLoadGeneration = 0;

/** Test seam: drop any in-flight load so suites do not leak fences into each other. */
export const __resetChatLoadFences = () => {
    localFields.clear();
    conversationsLoadGeneration = 0;
    messagesLoadGeneration = 0;
};

export const useChatStore = create<ChatState>()((set, get) => ({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,
    isLoading: true,
    loadedCharacterId: null,

    setConversationPersona: async (id, personaId) => {
        await queueConversationWrite(id, () => patchConversation(id, { lastPersonaId: personaId }));
        localFields.set(id, { ...localFields.get(id), lastPersonaId: personaId });
        set((state) => ({
            conversations: state.conversations.map((c) =>
                c.id === id ? { ...c, lastPersonaId: personaId } : c
            ),
        }));
    },
    setDraft: async (id, text) => {
        localFields.set(id, { ...localFields.get(id), draftText: text });
        set((state) => ({
            conversations: state.conversations.map((c) =>
                c.id === id ? { ...c, draftText: text } : c
            ),
        }));
        await queueConversationWrite(id, () => patchConversation(id, { draftText: text }));
    },
    initializePersona: async (id, messages) => {
        const conversation = get().conversations.find((c) => c.id === id);
        if (!conversation || conversation.lastPersonaId !== undefined) return;
        const lastPersonaId = resolvePersonaId(
            conversation,
            messages,
            useSettingsStore.getState().activePersonaId
        );
        const saved = await patchConversation(id, { lastPersonaId }, true);
        if (saved)
            set((state) => ({
                conversations: state.conversations.map((c) =>
                    c.id === id && c.lastPersonaId === undefined
                        ? { ...c, lastPersonaId: saved.lastPersonaId }
                        : c
                ),
            }));
    },
    // Load all conversations for a character from IndexedDB (Metadata only)
    loadConversations: async (characterId) => {
        const convToken = ++conversationsLoadGeneration;
        const msgToken = ++messagesLoadGeneration;
        set({ isLoading: true });
        try {
            const convs = await getConversationsByCharacter(characterId);
            // Preserve EVERY persisted field (relationships, arc, rpJournal, scratchpad,
            // storyGuidance, notes, momentumNudge, …). The previous explicit
            // allow-list silently dropped all of these on reload even though they were saved.
            const conversations: Conversation[] = convs.map((conv) => ({
                ...conv,
                ...localFields.get(conv.id),
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
                } else if (
                    conversations.length > 0 &&
                    !conversations.some((c) => c.id === activeConvId)
                ) {
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

            // A newer loadConversations already owns the store — this whole read is stale.
            if (convToken !== conversationsLoadGeneration) return;

            // The list is still ours to publish, but the selection may have moved on while we
            // were reading (a click on another conversation). In that case keep what the newer
            // load selected and drop only our messages.
            const selectionIsStale = msgToken !== messagesLoadGeneration;
            for (const conversation of conversations)
                Object.assign(conversation, localFields.get(conversation.id));
            set(
                selectionIsStale
                    ? { conversations, isLoading: false, loadedCharacterId: characterId }
                    : {
                          conversations,
                          messages: activeMessages,
                          activeConversationId: activeConvId,
                          isLoading: false,
                          loadedCharacterId: characterId,
                      }
            );
            if (!selectionIsStale && activeConvId)
                await get().initializePersona(activeConvId, activeMessages);
        } catch (error) {
            console.error('Failed to load conversations:', error);
            if (convToken !== conversationsLoadGeneration) return;
            set({ isLoading: false, loadedCharacterId: null });
        }
    },

    // Load messages for a specific conversation
    loadMessages: async (conversationId) => {
        const msgToken = ++messagesLoadGeneration;
        try {
            const dbMessages = await getConversationMessages(conversationId);
            const messages = serializeMessages(dbMessages);
            // Superseded by a newer read, or the selection moved while we were reading.
            if (msgToken !== messagesLoadGeneration) return;
            if (get().activeConversationId !== conversationId) return;
            set({ messages });
            await get().initializePersona(conversationId, messages);
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    },

    createConversation: async (characterId, title, characterName) => {
        const selectionToken = ++messagesLoadGeneration;
        const id = generateId();
        const conversation: Conversation = {
            id,
            characterId,
            title,
            lastPersonaId: resolvePersonaId(
                get().conversations.find((c) => c.id === get().activeConversationId),
                get().messages,
                useSettingsStore.getState().activePersonaId
            ),
            draftText: '',
            createdAt: new Date(),
            updatedAt: new Date(),
            // The only bond seeded automatically, and only here: every other relationship is
            // created by hand in the Relations panel. Seeding at creation (rather than lazily,
            // per beat) is what makes deleting it stick.
            ...(characterName ? { relationships: mainCharacterBond(characterName) } : {}),
        };

        await saveConversation(conversation);
        set((state) => ({
            conversations: [...state.conversations, conversation],
            ...(selectionToken === messagesLoadGeneration
                ? { activeConversationId: id, messages: [] }
                : {}),
        }));

        if (typeof window !== 'undefined' && selectionToken === messagesLoadGeneration) {
            localStorage.setItem(`nexusai_active_conv_${characterId}`, id);
        }

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

    commitUserMessage: async (message) => {
        const messages = get().messages;
        const parent = messages.find((m) => m.id === message.parentId);
        const enriched = {
            ...message,
            messageOrder: message.parentId ? (parent?.messageOrder ?? 1) + 1 : 1,
            regenerationIndex: messages.filter((m) => m.parentId === message.parentId).length,
        };
        const saved = await queueConversationWrite(message.conversationId, () =>
            persistUserMessage(enriched)
        );
        if (get().activeConversationId === message.conversationId) get().addMessage(enriched, true);
        // A newer draft (including one typed after switching back) must survive this acknowledgement.
        if (localFields.get(message.conversationId)?.draftText?.trim() === message.content) {
            localFields.set(message.conversationId, {
                ...localFields.get(message.conversationId),
                draftText: saved.draftText,
            });
        }
        set((state) => ({
            conversations: state.conversations.map((c) =>
                c.id === message.conversationId
                    ? {
                          ...c,
                          updatedAt: saved.updatedAt,
                          draftText:
                              c.draftText?.trim() === message.content
                                  ? saved.draftText
                                  : c.draftText,
                      }
                    : c
            ),
        }));
    },
    addMessage: (message, persisted = false) => {
        // Calculate messageOrder and regenerationIndex
        const state = get();
        const messages = state.messages.filter((m) => m.conversationId === message.conversationId);
        let changedExistingMessages: Message[] = [];

        // The parent already knows its depth — no need to walk the whole ancestor chain
        // (O(depth × n) message scans on every send in long linear chats).
        const parent = message.parentId
            ? messages.find((m) => m.id === message.parentId)
            : undefined;
        const messageOrder = message.parentId ? (parent?.messageOrder ?? 1) + 1 : 1;

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
            if (state.activeConversationId && state.activeConversationId !== message.conversationId)
                return {};
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
        if (!persisted) saveMessage(enrichedMessage).catch(console.error);
    },

    applyCommittedSceneBeat: ({
        conversationId,
        messages: committedMessages,
        storyStateRevisionId,
        roster,
    }) => {
        set((state) => {
            const first = committedMessages[0];
            const conversationMessages = state.messages.filter(
                (message) => message.conversationId === conversationId
            );
            const deactivate = new Set<string>();
            for (const sibling of conversationMessages.filter(
                (message) => message.parentId === first.parentId
            )) {
                deactivate.add(sibling.id);
                getDescendantIds(conversationMessages, sibling.id).forEach((id) =>
                    deactivate.add(id)
                );
            }
            return {
                messages: [
                    ...state.messages.map((message) =>
                        deactivate.has(message.id) ? { ...message, isActiveBranch: false } : message
                    ),
                    ...committedMessages,
                ],
                conversations: state.conversations.map((conversation) =>
                    conversation.id === conversationId
                        ? {
                              ...conversation,
                              activeStoryStateRevisionId: storyStateRevisionId,
                              sceneRoster: roster,
                              updatedAt: new Date(),
                          }
                        : conversation
                ),
            };
        });
    },

    applyStoryStateRevision: ({ conversationId, messageId, storyStateRevisionId, roster }) => {
        set((state) => ({
            messages: state.messages.map((message) =>
                message.id === messageId ? { ...message, storyStateRevisionId } : message
            ),
            conversations: state.conversations.map((conversation) =>
                conversation.id === conversationId
                    ? {
                          ...conversation,
                          activeStoryStateRevisionId: storyStateRevisionId,
                          sceneRoster: roster,
                      }
                    : conversation
            ),
        }));
    },

    updateMessage: (id, updates, options) => {
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

        // Persist message (skipped on the streaming hot path — final write at stream end).
        if (updatedMessage && options?.persist !== false) {
            saveMessage(updatedMessage).catch(console.error);
        } else if (!updatedMessage && options?.persist !== false) {
            void patchStoredMessage(id, updates).catch(console.error);
        }
    },

    deleteMessage: (id) => {
        const idsToDelete: string[] = [id];
        set((state) => {
            const msgToDelete = state.messages.find((m) => m.id === id);
            if (!msgToDelete) return state;

            // The confirm dialog promises "this message and all subsequent messages in this
            // branch": delete the whole subtree. Leaving descendants orphaned (parentId
            // pointing at a deleted id) corrupts the active-branch path computation.
            const convMessages = state.messages.filter(
                (m) => m.conversationId === msgToDelete.conversationId
            );
            getDescendantIds(convMessages, id).forEach((d) => idsToDelete.push(d));
            const deleteSet = new Set(idsToDelete);

            // If deleting an active message, try to activate a sibling
            let newMessages = state.messages.filter((m) => !deleteSet.has(m.id));

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

            return { messages: newMessages };
        });

        // Persist deletions (subtree included)
        idsToDelete.forEach((d) => deleteMessagedb(d).catch(console.error));
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
                    conversationToUpdate = {
                        ...c,
                        arc,
                        arcRevision: (c.arcRevision ?? 0) + 1,
                        updatedAt: new Date(),
                    };
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

    // Prompt-cache hysteresis: persist the history-window state chosen by the payload builder
    // (anchor and/or smoothed dynamic reserve) in ONE write — they change on the same turn,
    // and two setters meant two IndexedDB writes per message.
    // NOTE: deliberately does NOT bump updatedAt — this is plumbing, not content.
    setHistoryWindowState: (conversationId, state) => {
        let conversationToUpdate: Conversation | undefined;
        set((s) => ({
            conversations: s.conversations.map((c) => {
                if (c.id !== conversationId) return c;
                conversationToUpdate = {
                    ...c,
                    ...('cutMessageId' in state ? { historyCutMessageId: state.cutMessageId } : {}),
                    ...('dynamicReserveTokens' in state
                        ? { dynamicReserveTokens: state.dynamicReserveTokens }
                        : {}),
                };
                return conversationToUpdate;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    setHistoryCut: (conversationId, messageId) => {
        get().setHistoryWindowState(conversationId, { cutMessageId: messageId });
    },

    setSceneMode: (conversationId, sceneMode) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = { ...c, sceneMode, updatedAt: new Date() };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    setSceneRoster: (conversationId, roster) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = { ...c, sceneRoster: roster };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    setSceneCharacterOverride: (conversationId, displayName, character) => {
        let conversationToUpdate: Conversation | undefined;
        const key = displayName.trim().toLocaleLowerCase();
        set((state) => ({
            conversations: state.conversations.map((conversation) => {
                if (conversation.id !== conversationId) return conversation;
                conversationToUpdate = {
                    ...conversation,
                    sceneCharacterOverrides: {
                        ...(conversation.sceneCharacterOverrides ?? {}),
                        [key]: character,
                    },
                    updatedAt: new Date(),
                };
                return conversationToUpdate;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    setSceneStyle: (conversationId, style) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = { ...c, sceneStyle: style };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    setDirectedNarrativeVersion: (conversationId, directedNarrativeVersion) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((conversation) => {
                if (conversation.id !== conversationId) return conversation;
                conversationToUpdate = {
                    ...conversation,
                    directedNarrativeVersion,
                    updatedAt: new Date(),
                };
                return conversationToUpdate;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    setDirectedSceneSuggestionDismissed: (conversationId, directedSceneSuggestionDismissed) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((conversation) => {
                if (conversation.id !== conversationId) return conversation;
                conversationToUpdate = { ...conversation, directedSceneSuggestionDismissed };
                return conversationToUpdate;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    // Canon cast stickiness (name -> history length at last mention). Same plumbing rule:
    // no updatedAt bump.
    setStickyCast: (conversationId, stickyCast) => {
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = { ...c, stickyCast };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    // The Style Guard ban list is branch-aware: it is snapshotted onto the active branch
    // tip (snapshot-per-branch pattern) so swiping/regenerating doesn't carry one branch's
    // learned rules into an unrelated one. conversation.banList remains only as a fallback
    // for branches without a snapshot (legacy chats, or a conversation with no messages yet).
    setBanList: (conversationId, banList) => {
        const convMessages = get().messages.filter((m) => m.conversationId === conversationId);
        const path = getActiveBranchPath(convMessages);
        const leaf = path[path.length - 1];

        if (leaf) {
            const updatedLeaf: Message = { ...leaf, banListSnapshot: banList };
            set((state) => ({
                messages: state.messages.map((m) => (m.id === leaf.id ? updatedLeaf : m)),
            }));
            saveMessage(updatedLeaf).catch(console.error);
            return;
        }

        // No messages on this conversation yet — fall back to conversation-level storage.
        let conversationToUpdate: Conversation | undefined;
        set((state) => ({
            conversations: state.conversations.map((c) => {
                if (c.id === conversationId) {
                    conversationToUpdate = { ...c, banList, updatedAt: new Date() };
                    return conversationToUpdate;
                }
                return c;
            }),
        }));
        if (conversationToUpdate) saveConversation(conversationToUpdate).catch(console.error);
    },

    getActiveBranchBanList: (conversationId) => {
        const state = get();
        const convMessages = state.messages.filter((m) => m.conversationId === conversationId);
        const path = getActiveBranchPath(convMessages);
        for (let i = path.length - 1; i >= 0; i--) {
            const snapshot = path[i].banListSnapshot;
            if (snapshot) return snapshot;
        }
        return state.conversations.find((c) => c.id === conversationId)?.banList ?? [];
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
            if (!currentMsg) return state;

            // Find all siblings (messages with same parent). Root messages (parentId null,
            // e.g. the greeting + its alternate greetings) are siblings of each other —
            // scope by conversation since null doesn't discriminate.
            const siblings = state.messages
                .filter(
                    (m) =>
                        m.conversationId === currentMsg.conversationId &&
                        m.parentId === currentMsg.parentId
                )
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

            // Persist all changed messages to DB
            const changedMessages = newMessages.filter((newMsg, idx) => {
                const oldMsg = state.messages[idx];
                return oldMsg && oldMsg.isActiveBranch !== newMsg.isActiveBranch;
            });
            changedMessages.forEach((msg) => saveMessage(msg).catch(console.error));

            return { messages: newMessages };
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

            // Persist all changed messages to DB
            const changedMessages = newMessages.filter((newMsg, idx) => {
                const oldMsg = state.messages[idx];
                return oldMsg && oldMsg.isActiveBranch !== newMsg.isActiveBranch;
            });
            changedMessages.forEach((msg) => saveMessage(msg).catch(console.error));

            return { messages: newMessages };
        }),

    // Selectors
    getMessageSiblingsInfo: (messageId) => {
        const messages = get().messages;
        const currentMsg = messages.find((m) => m.id === messageId);
        if (!currentMsg) return { currentIndex: 1, total: 1 };

        // Root messages (greeting + alternate greetings) are siblings of each other.
        const siblings = messages
            .filter(
                (m) =>
                    m.conversationId === currentMsg.conversationId &&
                    m.parentId === currentMsg.parentId
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        return {
            currentIndex: siblings.findIndex((m) => m.id === messageId) + 1,
            total: siblings.length,
        };
    },
}));
