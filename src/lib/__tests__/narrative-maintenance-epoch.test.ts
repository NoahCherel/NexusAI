import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';

const path: Message[] = [
    {
        id: 'beat-final',
        conversationId: 'c',
        parentId: null,
        role: 'assistant',
        content: 'x',
        isActiveBranch: true,
        createdAt: new Date(0),
        messageOrder: 1,
        regenerationIndex: 0,
        storyStateRevisionId: 'r1',
    },
];

vi.mock('@/stores/chat-store', () => ({
    useChatStore: { getState: () => ({ getActiveBranchMessages: () => path }) },
}));
vi.mock('@/lib/db', () => ({
    commitStoryStateRevision: vi.fn(),
    getArcOutline: vi.fn(),
    getSceneBeat: vi.fn(),
    getSceneBeatsByConversation: vi.fn(),
    getStoryState: vi.fn(),
}));
vi.mock('@/lib/ai/background-ai', () => ({
    backgroundAICall: vi.fn(),
    resolveBackgroundRoute: vi.fn(),
    BackgroundContextLengthError: class extends Error {},
}));
vi.mock('@/lib/ai/conversation-context', () => ({ buildAgentPayload: vi.fn() }));

import { invalidateNarrativeMaintenance, stillCurrent } from '@/lib/ai/narrative-maintenance';

describe('narrative maintenance epoch', () => {
    it('a beat that starts generating invalidates a maintenance pass captured before it', () => {
        expect(stillCurrent('c', 'beat-final', 'r1', 0)).toBe(true);
        invalidateNarrativeMaintenance('c');
        expect(stillCurrent('c', 'beat-final', 'r1', 0)).toBe(false);
        expect(stillCurrent('c', 'beat-final', 'r1', 1)).toBe(true);
        // A pass that captured no epoch keeps the historical branch/revision rule only.
        expect(stillCurrent('c', 'beat-final', 'r1')).toBe(true);
        expect(stillCurrent('c', 'beat-final', 'r0')).toBe(false);
    });
});
