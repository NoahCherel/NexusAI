import { describe, expect, it } from 'vitest';
import { getActiveBranchPath } from '@/stores/chat-store';
import type { Message } from '@/types';

const message = (
    id: string,
    parentId: string | null,
    createdAt: string,
    isActiveBranch = true,
    messageOrder = 1
): Message => ({
    id,
    conversationId: 'conversation-1',
    parentId,
    role: id.startsWith('u') ? 'user' : 'assistant',
    content: id,
    isActiveBranch,
    createdAt: new Date(createdAt),
    messageOrder,
    regenerationIndex: 0,
});

describe('getActiveBranchPath', () => {
    it('returns one lineage when multiple regenerated siblings are marked active', () => {
        const messages = [
            message('u1', null, '2026-01-01T00:00:00.000Z', true, 1),
            message('a1', 'u1', '2026-01-01T00:01:00.000Z', true, 2),
            message('a2', 'u1', '2026-01-01T00:02:00.000Z', true, 2),
            message('u2', 'a2', '2026-01-01T00:03:00.000Z', true, 3),
        ];

        expect(getActiveBranchPath(messages).map((m) => m.id)).toEqual(['u1', 'a2', 'u2']);
    });

    it('prefers a newer regenerated sibling over stale active descendants from the old branch', () => {
        const messages = [
            message('u1', null, '2026-01-01T00:00:00.000Z', true, 1),
            message('a1', 'u1', '2026-01-01T00:01:00.000Z', false, 2),
            message('u2', 'a1', '2026-01-01T00:02:00.000Z', true, 3),
            message('a2', 'u1', '2026-01-01T00:03:00.000Z', true, 2),
        ];

        expect(getActiveBranchPath(messages).map((m) => m.id)).toEqual(['u1', 'a2']);
    });

    it('keeps legacy flat imported timelines visible', () => {
        const messages = [
            message('u1', null, '2026-01-01T00:00:00.000Z', true, 1),
            message('a1', null, '2026-01-01T00:01:00.000Z', true, 2),
            message('u2', null, '2026-01-01T00:02:00.000Z', true, 3),
        ];

        expect(getActiveBranchPath(messages).map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    });
});
