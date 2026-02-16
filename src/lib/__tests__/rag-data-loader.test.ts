import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadRagDataByConversation } from '../rag-data-loader';
import type { MemorySummary, WorldFact } from '@/types/rag';

vi.mock('../db', () => ({
    getFactsByConversation: vi.fn(),
    getSummariesByConversation: vi.fn(),
}));

import { getFactsByConversation, getSummariesByConversation } from '../db';

const mockedGetFactsByConversation = vi.mocked(getFactsByConversation);
const mockedGetSummariesByConversation = vi.mocked(getSummariesByConversation);

describe('loadRagDataByConversation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns facts and summaries when both loaders succeed', async () => {
        const facts: WorldFact[] = [
            {
                id: 'fact-1',
                conversationId: 'conv-1',
                messageId: 'msg-1',
                fact: 'The hero found a key',
                category: 'event',
                importance: 6,
                active: true,
                timestamp: 1,
                relatedEntities: [],
                lastAccessedAt: 1,
                accessCount: 0,
            },
        ];
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

        mockedGetFactsByConversation.mockResolvedValue(facts);
        mockedGetSummariesByConversation.mockResolvedValue(summaries);

        const result = await loadRagDataByConversation('conv-1');

        expect(result.facts).toEqual(facts);
        expect(result.summaries).toEqual(summaries);
        expect(result.errors).toEqual({ facts: undefined, summaries: undefined });
    });

    it('still returns summaries when facts loading fails', async () => {
        const summaries: MemorySummary[] = [
            {
                id: 'sum-1',
                conversationId: 'conv-1',
                level: 1,
                messageRange: [0, 50],
                content: 'The group escaped the fortress.',
                keyFacts: [],
                childIds: ['sum-l0-a'],
                createdAt: 2,
            },
        ];
        const error = new Error('facts index missing');

        mockedGetFactsByConversation.mockRejectedValue(error);
        mockedGetSummariesByConversation.mockResolvedValue(summaries);

        const result = await loadRagDataByConversation('conv-1');

        expect(result.facts).toEqual([]);
        expect(result.summaries).toEqual(summaries);
        expect(result.errors.facts).toBe(error);
        expect(result.errors.summaries).toBeUndefined();
    });

    it('still returns facts when summaries loading fails', async () => {
        const facts: WorldFact[] = [
            {
                id: 'fact-1',
                conversationId: 'conv-1',
                messageId: 'msg-1',
                fact: 'The city gates are sealed',
                category: 'location',
                importance: 7,
                active: true,
                timestamp: 1,
                relatedEntities: ['City Gate'],
                lastAccessedAt: 1,
                accessCount: 0,
            },
        ];
        const error = new Error('summaries index missing');

        mockedGetFactsByConversation.mockResolvedValue(facts);
        mockedGetSummariesByConversation.mockRejectedValue(error);

        const result = await loadRagDataByConversation('conv-1');

        expect(result.facts).toEqual(facts);
        expect(result.summaries).toEqual([]);
        expect(result.errors.facts).toBeUndefined();
        expect(result.errors.summaries).toBe(error);
    });
});
