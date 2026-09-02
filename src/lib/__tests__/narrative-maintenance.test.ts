import { afterEach, describe, expect, it } from 'vitest';
import type { Conversation, Message } from '@/types';
import { stillCurrent } from '@/lib/ai/narrative-maintenance';
import { useChatStore } from '@/stores/chat-store';

const conversation: Conversation = {
    id: 'stale-conversation',
    characterId: 'character',
    title: 'Stale guard',
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

const message = (id: string, parentId: string | null, revision?: string): Message => ({
    id,
    conversationId: conversation.id,
    parentId,
    role: id.startsWith('u') ? 'user' : 'assistant',
    content: id,
    isActiveBranch: true,
    createdAt: new Date(0),
    messageOrder: parentId ? 2 : 1,
    regenerationIndex: 0,
    storyStateRevisionId: revision,
});

afterEach(() => {
    useChatStore.setState({ activeConversationId: null, conversations: [], messages: [] });
});

describe('narrative maintenance stale-result guard', () => {
    it('accepts the current branch revision and rejects a late result after a branch switch', () => {
        const root = message('u-root', null);
        const firstBranch = message('a-first', root.id, 'revision-a');
        useChatStore.setState({
            activeConversationId: conversation.id,
            conversations: [conversation],
            messages: [root, firstBranch],
        });
        expect(stillCurrent(conversation.id, firstBranch.id, 'revision-a')).toBe(true);

        const secondBranch = message('a-second', root.id, 'revision-b');
        useChatStore.setState({
            messages: [
                { ...root, isActiveBranch: true },
                { ...firstBranch, isActiveBranch: false },
                secondBranch,
            ],
        });
        expect(stillCurrent(conversation.id, firstBranch.id, 'revision-a')).toBe(false);
        expect(stillCurrent(conversation.id, secondBranch.id, 'revision-b')).toBe(true);
    });
});
