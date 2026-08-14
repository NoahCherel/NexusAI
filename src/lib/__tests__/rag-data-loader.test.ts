import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadRagDataByConversation } from '../rag-data-loader';
import type { MemorySummary } from '@/types/rag';

vi.mock('../db', () => ({
    getSummariesByConversation: vi.fn(),
}));

import { getSummariesByConversation } from '../db';

const mockedGetSummariesByConversation = vi.mocked(getSummariesByConversation);

describe('loadRagDataByConversation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the conversation Chronicle when the loader succeeds', async () => {
        const summaries: MemorySummary[] = [
            {
                id: 'sum-1',
                conversationId: 'conv-1',
                level: 0,
                messageRange: [0, 10],
                content: 'The party enters a ruin.',
                keyFacts: [],
                childIds: [],
                createdAt: 1,
            },
        ];

        mockedGetSummariesByConversation.mockResolvedValue(summaries);

        const result = await loadRagDataByConversation('conv-1');

        expect(result.summaries).toEqual(summaries);
        expect(result.errors).toEqual({ summaries: undefined });
    });

    it('degrades to an empty Chronicle instead of throwing when the store is unreadable', async () => {
        const error = new Error('summaries index missing');
        mockedGetSummariesByConversation.mockRejectedValue(error);

        const result = await loadRagDataByConversation('conv-1');

        expect(result.summaries).toEqual([]);
        expect(result.errors.summaries).toBe(error);
    });
});
