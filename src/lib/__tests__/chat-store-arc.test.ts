import { describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '@/types';

vi.mock('@/lib/db', () => ({
    saveConversation: vi.fn(async () => undefined),
    saveMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    getConversationMessages: vi.fn(async () => []),
    getAllConversations: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => undefined),
    saveStoryState: vi.fn(async () => undefined),
    getStoryState: vi.fn(async () => undefined),
}));

import { useChatStore } from '@/stores/chat-store';

const conversation: Conversation = {
    id: 'conv',
    characterId: 'card',
    title: 't',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    arc: { currentPosition: 'édition utilisateur' },
    arcRevision: 2,
};
const bubble: Message = {
    id: 'm1',
    conversationId: 'conv',
    parentId: null,
    role: 'assistant',
    content: 'x',
    isActiveBranch: true,
    createdAt: new Date(0),
    messageOrder: 1,
    regenerationIndex: 0,
};

describe('applyCommittedSceneBeat and the Arc Compass', () => {
    it('records the revision and roster without touching the arc', () => {
        useChatStore.setState({ conversations: [conversation], messages: [] });
        useChatStore.getState().applyCommittedSceneBeat({
            conversationId: 'conv',
            messages: [bubble],
            storyStateRevisionId: 'r',
            roster: ['Alice'],
        });
        const updated = useChatStore.getState().conversations[0];
        expect(updated.activeStoryStateRevisionId).toBe('r');
        expect(updated.sceneRoster).toEqual(['Alice']);
        expect(updated.arc?.currentPosition).toBe('édition utilisateur');
        expect(updated.arcRevision).toBe(2);
    });

    it('a user arc edit bumps the arc revision', () => {
        useChatStore.setState({ conversations: [conversation], messages: [] });
        useChatStore.getState().updateArc('conv', { currentPosition: 'Chapitre 12' });
        const updated = useChatStore.getState().conversations[0];
        expect(updated.arc?.currentPosition).toBe('Chapitre 12');
        expect(updated.arcRevision).toBe(3);
    });
});
