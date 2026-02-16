/**
 * Tests for the hierarchical summarizer.
 */
import { describe, it, expect } from 'vitest';
import {
    shouldCreateL0Summary,
    shouldCreateL1Summary,
    shouldCreateL2Summary,
    getNextChunkToSummarize,
    getL0SummariesForL1,
    getL1SummariesForL2,
    parseSummarizationResponse,
} from '../ai/hierarchical-summarizer';
import type { MemorySummary } from '@/types/rag';
import type { Message } from '@/types/chat';

// Helper to create mock summary
function mockSummary(overrides: Partial<MemorySummary> = {}): MemorySummary {
    return {
        id: `summary-${Math.random().toString(36).slice(2)}`,
        conversationId: 'conv-1',
        level: 0,
        content: 'Test summary',
        keyFacts: [],
        messageRange: [0, 10],
        childIds: [],
        createdAt: Date.now(),
        ...overrides,
    };
}

// Helper to create mock messages
function mockMessages(count: number): Message[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `msg-${i}`,
        conversationId: 'conv-1',
        parentId: i > 0 ? `msg-${i - 1}` : null,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message content ${i}`,
        createdAt: new Date(Date.now() + i * 1000),
        isActiveBranch: true,
        messageOrder: i + 1,
        regenerationIndex: 0,
    })) as Message[];
}

describe('shouldCreateL0Summary', () => {
    it('returns true when enough uncovered messages exist', () => {
        expect(shouldCreateL0Summary(10, [])).toBe(true);
        expect(shouldCreateL0Summary(20, [mockSummary()])).toBe(true);
    });

    it('returns false when messages are already covered', () => {
        expect(shouldCreateL0Summary(5, [])).toBe(false);
        expect(shouldCreateL0Summary(10, [mockSummary()])).toBe(false);
    });

    it('returns false for zero messages', () => {
        expect(shouldCreateL0Summary(0, [])).toBe(false);
    });
});

describe('shouldCreateL1Summary', () => {
    it('returns true when 5+ L0 summaries exist uncovered', () => {
        const l0s = Array.from({ length: 5 }, (_, i) =>
            mockSummary({ id: `l0-${i}`, level: 0 })
        );
        expect(shouldCreateL1Summary(l0s)).toBe(true);
    });

    it('returns false when fewer than 5 L0 summaries', () => {
        const l0s = Array.from({ length: 4 }, (_, i) =>
            mockSummary({ id: `l0-${i}`, level: 0 })
        );
        expect(shouldCreateL1Summary(l0s)).toBe(false);
    });
});

describe('shouldCreateL2Summary', () => {
    it('returns true when 3+ L1 summaries exist uncovered', () => {
        const summaries = Array.from({ length: 3 }, (_, i) =>
            mockSummary({ id: `l1-${i}`, level: 1 })
        );
        expect(shouldCreateL2Summary(summaries)).toBe(true);
    });

    it('returns false when fewer than 3 L1 summaries', () => {
        const summaries = Array.from({ length: 2 }, (_, i) =>
            mockSummary({ id: `l1-${i}`, level: 1 })
        );
        expect(shouldCreateL2Summary(summaries)).toBe(false);
    });
});

describe('getNextChunkToSummarize', () => {
    it('returns first 10 messages when no summaries exist', () => {
        const messages = mockMessages(15);
        const chunk = getNextChunkToSummarize(messages, []);
        expect(chunk).not.toBeNull();
        expect(chunk!.length).toBe(10);
    });

    it('returns next chunk after existing summaries', () => {
        const messages = mockMessages(25);
        const summaries = [mockSummary()]; // 1 L0 = 10 messages covered
        const chunk = getNextChunkToSummarize(messages, summaries);
        expect(chunk).not.toBeNull();
        expect(chunk!.length).toBe(10);
        expect(chunk![0].id).toBe('msg-10'); // Starts from message 10
    });

    it('returns null when not enough unsummarized messages', () => {
        const messages = mockMessages(5);
        const chunk = getNextChunkToSummarize(messages, []);
        expect(chunk).toBeNull();
    });
});

describe('getL0SummariesForL1', () => {
    it('returns uncovered L0s when threshold reached', () => {
        const summaries = Array.from({ length: 5 }, (_, i) =>
            mockSummary({ id: `l0-${i}`, level: 0, messageRange: [i * 10, i * 10 + 9] })
        );
        const result = getL0SummariesForL1(summaries);
        expect(result).not.toBeNull();
        expect(result!.length).toBe(5);
    });

    it('returns null when not enough uncovered L0s', () => {
        const l0s = Array.from({ length: 5 }, (_, i) =>
            mockSummary({ id: `l0-${i}`, level: 0 })
        );
        const l1 = mockSummary({
            id: 'l1-0',
            level: 1,
            childIds: l0s.map(s => s.id),
        });
        const result = getL0SummariesForL1([...l0s, l1]);
        expect(result).toBeNull();
    });
});

describe('getL1SummariesForL2', () => {
    it('returns uncovered L1s when threshold reached', () => {
        const summaries = Array.from({ length: 3 }, (_, i) =>
            mockSummary({ id: `l1-${i}`, level: 1, messageRange: [i * 50, i * 50 + 49] })
        );
        const result = getL1SummariesForL2(summaries);
        expect(result).not.toBeNull();
        expect(result!.length).toBe(3);
    });
});

describe('parseSummarizationResponse', () => {
    it('parses valid JSON response', () => {
        const response = '{"summary": "The hero fought the dragon.", "keyFacts": ["Dragon defeated", "Hero injured"]}';
        const result = parseSummarizationResponse(response);
        expect(result).not.toBeNull();
        expect(result!.summary).toBe('The hero fought the dragon.');
        expect(result!.keyFacts).toHaveLength(2);
    });

    it('extracts JSON from markdown fences', () => {
        const response = '```json\n{"summary": "Test summary", "keyFacts": []}\n```';
        const result = parseSummarizationResponse(response);
        expect(result).not.toBeNull();
        expect(result!.summary).toBe('Test summary');
    });

    it('strips <think> blocks and uses raw text as fallback', () => {
        const response = '<think>internal reasoning</think>This is the actual summary.';
        const result = parseSummarizationResponse(response);
        expect(result).not.toBeNull();
        expect(result!.summary).toBe('This is the actual summary.');
    });

    it('returns null for empty string', () => {
        const result = parseSummarizationResponse('');
        expect(result).toBeNull();
    });

    it('handles JSON with extra text around it', () => {
        const response = 'Here is the summary:\n{"summary": "Important events", "keyFacts": ["fact1"]}\nDone!';
        const result = parseSummarizationResponse(response);
        expect(result).not.toBeNull();
        expect(result!.summary).toBe('Important events');
    });
});
