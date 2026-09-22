import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '@/types';

/**
 * IndexedDB reads settle out of order. These tests drive the store the way a user does —
 * clicking from one conversation to another faster than the reads come back — and pin the
 * rule that only the newest read may publish.
 */
const deferred = vi.hoisted(() => ({
    messageReads: [] as { conversationId: string; resolve: (messages: unknown[]) => void }[],
    conversationReads: [] as { resolve: (conversations: unknown[]) => void }[],
}));

vi.mock('@/lib/db', () => ({
    getConversationMessages: (conversationId: string) =>
        new Promise((resolve) => deferred.messageReads.push({ conversationId, resolve })),
    getConversationsByCharacter: () =>
        new Promise((resolve) => deferred.conversationReads.push({ resolve })),
    saveConversation: async () => {},
    saveMessage: async () => {},
    deleteMessagedb: async () => {},
}));

const { useChatStore, __resetChatLoadFences } = await import('@/stores/chat-store');

const conversation = (id: string): Conversation => ({
    id,
    characterId: 'char-1',
    title: id,
    createdAt: new Date(0),
    updatedAt: new Date(0),
});

const message = (id: string, conversationId: string): Message => ({
    id,
    conversationId,
    parentId: null,
    role: 'assistant',
    content: id,
    isActiveBranch: true,
    createdAt: new Date(1),
    messageOrder: 1,
    regenerationIndex: 0,
});

/** Let the awaited continuations after a resolve() actually run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    deferred.messageReads.length = 0;
    deferred.conversationReads.length = 0;
    __resetChatLoadFences();
    useChatStore.setState({
        conversations: [conversation('A'), conversation('B')],
        activeConversationId: null,
        messages: [],
        isLoading: false,
        loadedCharacterId: 'char-1',
    });
});

describe('conversation switching under out-of-order reads', () => {
    it('drops the messages of a conversation the user already left (A → B, A settles last)', async () => {
        const store = useChatStore.getState();
        store.setActiveConversation('A');
        store.setActiveConversation('B');
        expect(deferred.messageReads.map((r) => r.conversationId)).toEqual(['A', 'B']);

        deferred.messageReads[1].resolve([message('b1', 'B')]);
        await flush();
        deferred.messageReads[0].resolve([message('a1', 'A')]);
        await flush();

        const state = useChatStore.getState();
        expect(state.activeConversationId).toBe('B');
        expect(state.messages.map((m) => m.id)).toEqual(['b1']);
    });

    it('keeps the newest read of a conversation visited twice (A → B → A)', async () => {
        const store = useChatStore.getState();
        store.setActiveConversation('A');
        store.setActiveConversation('B');
        store.setActiveConversation('A');

        deferred.messageReads[2].resolve([message('a-fresh', 'A')]);
        await flush();
        deferred.messageReads[1].resolve([message('b1', 'B')]);
        await flush();
        // The very first read finally lands: same conversation, but a superseded snapshot.
        deferred.messageReads[0].resolve([message('a-stale', 'A')]);
        await flush();

        const state = useChatStore.getState();
        expect(state.activeConversationId).toBe('A');
        expect(state.messages.map((m) => m.id)).toEqual(['a-fresh']);
    });
});

describe('loadConversations', () => {
    it('publishes its conversation list without clobbering a selection made while it was reading', async () => {
        useChatStore.setState({ conversations: [], activeConversationId: null, messages: [] });
        const store = useChatStore.getState();

        const loading = store.loadConversations('char-1');
        // The user picks a conversation before the list read has come back.
        store.setActiveConversation('B');
        deferred.messageReads[0].resolve([message('b1', 'B')]);
        await flush();

        deferred.conversationReads[0].resolve([conversation('A'), conversation('B')]);
        await flush();
        // The list read then does its own message read, which is now the superseded one.
        deferred.messageReads[1].resolve([message('b-superseded', 'B')]);
        await loading;

        const state = useChatStore.getState();
        // The list is legitimate work and must land…
        expect(state.conversations.map((c) => c.id)).toEqual(['A', 'B']);
        expect(state.isLoading).toBe(false);
        expect(state.loadedCharacterId).toBe('char-1');
        // …while its stale message snapshot is dropped in favour of the newer read.
        expect(state.messages.map((m) => m.id)).toEqual(['b1']);
    });
});
