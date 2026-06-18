import { describe, expect, it } from 'vitest';
import {
    buildRetrievalQueryText,
    extractSearchTerms,
    lexicalOverlapScore,
} from '@/lib/ai/rag-ranking';

describe('rag-ranking', () => {
    it('builds a retrieval query from the current turn, recent scene, and world anchors', () => {
        const query = buildRetrievalQueryText('Where did Serana hide the ring?', {
            recentMessages: [
                { role: 'assistant', content: 'Serana whispered near the old harbor.' },
                { role: 'user', content: 'I check my satchel.' },
            ],
            worldState: {
                location: 'Old Harbor',
                inventory: ['silver ring'],
                relationships: { Serana: 24 },
            },
        });

        expect(query).toContain('Where did Serana hide the ring?');
        expect(query).toContain('Serana whispered near the old harbor.');
        expect(query).toContain('Location: Old Harbor');
        expect(query).toContain('Inventory: silver ring');
    });

    it('extracts useful search terms while dropping common filler words', () => {
        const terms = extractSearchTerms('Et alors Serana cache la bague dans le vieux port.');

        expect(terms.has('serana')).toBe(true);
        expect(terms.has('cache')).toBe(true);
        expect(terms.has('bague')).toBe(true);
        expect(terms.has('dans')).toBe(false);
    });

    it('scores lexical overlap from content and structured extra terms', () => {
        const queryTerms = extractSearchTerms('Serana silver ring harbor');

        const score = lexicalOverlapScore(queryTerms, 'A promise was made.', [
            'Serana',
            'silver ring',
            'Old Harbor',
        ]);

        expect(score).toBeGreaterThanOrEqual(0.75);
    });
});
