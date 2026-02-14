/**
 * Tests for the fact extractor.
 */
import { describe, it, expect } from 'vitest';
import {
    parseFactExtractionResponse,
    heuristicImportance,
    deduplicateFacts,
} from '../ai/fact-extractor';
import type { WorldFact } from '@/types/rag';

describe('parseFactExtractionResponse', () => {
    it('parses a valid JSON response', () => {
        const response = `[
            {
                "fact": "The warrior defeated the dragon",
                "category": "event",
                "importance": 9,
                "entities": ["Warrior", "Dragon"],
                "tags": ["combat", "victory"]
            },
            {
                "fact": "A magical sword was found in the cave",
                "category": "item",
                "importance": 7,
                "entities": ["Magical Sword"],
                "tags": ["discovery"]
            }
        ]`;

        const result = parseFactExtractionResponse(response, 'conv-1', 'msg-1');
        expect(result).toHaveLength(2);
        expect(result[0].fact).toBe('The warrior defeated the dragon');
        expect(result[0].category).toBe('event');
        expect(result[0].importance).toBe(9);
        expect(result[0].relatedEntities).toEqual(['Warrior', 'Dragon']);
        expect(result[0].conversationId).toBe('conv-1');
        expect(result[0].messageId).toBe('msg-1');
    });

    it('handles response with markdown fences', () => {
        const response = '```json\n[{"fact":"test","category":"event","importance":5,"entities":[],"tags":[]}]\n```';
        const result = parseFactExtractionResponse(response, 'c', 'm');
        expect(result).toHaveLength(1);
        expect(result[0].fact).toBe('test');
    });

    it('returns empty array for invalid JSON', () => {
        const result = parseFactExtractionResponse('not valid json', 'c', 'm');
        expect(result).toEqual([]);
    });

    it('returns empty array for empty response', () => {
        const result = parseFactExtractionResponse('', 'c', 'm');
        expect(result).toEqual([]);
    });

    it('clamps importance between 1 and 10', () => {
        const response = `[
            {"fact":"low","category":"event","importance":-5,"entities":[],"tags":[]},
            {"fact":"high","category":"event","importance":99,"entities":[],"tags":[]}
        ]`;
        const result = parseFactExtractionResponse(response, 'c', 'm');
        expect(result[0].importance).toBe(1);
        expect(result[1].importance).toBe(10);
    });

    it('validates category to known types', () => {
        const response = `[{"fact":"test","category":"invalid_category","importance":5,"entities":[],"tags":[]}]`;
        const result = parseFactExtractionResponse(response, 'c', 'm');
        expect(result[0].category).toBe('event'); // Falls back to 'event'
    });

    it('filters out entries missing required fields', () => {
        const response = `[
            {"fact":"good","category":"event","importance":5,"entities":[]},
            {"category":"event","importance":5},
            {"fact":"also good","importance":5,"category":"item","entities":[]}
        ]`;
        const result = parseFactExtractionResponse(response, 'c', 'm');
        expect(result).toHaveLength(2);
    });
});

describe('heuristicImportance', () => {
    it('gives high score for combat/death keywords', () => {
        expect(heuristicImportance('The dragon was killed in battle')).toBeGreaterThanOrEqual(7);
        expect(heuristicImportance('She died protecting the village')).toBeGreaterThanOrEqual(7);
    });

    it('gives medium score for action keywords', () => {
        expect(heuristicImportance('He steals the treasure from the chest')).toBeGreaterThanOrEqual(5);
        expect(heuristicImportance('They attacked the fortress walls')).toBeGreaterThanOrEqual(5);
    });

    it('gives low/base score for mundane text', () => {
        expect(heuristicImportance('The weather was nice today')).toBeLessThanOrEqual(5);
    });

    it('handles French keywords', () => {
        expect(heuristicImportance('Le guerrier est mort au combat')).toBeGreaterThanOrEqual(7);
        expect(heuristicImportance('Il a découvert un passage secret')).toBeGreaterThanOrEqual(7);
    });

    it('boosts score for longer text', () => {
        const shortText = 'A brief note.';
        const longText = 'word '.repeat(200); // ~1000 chars
        const shortScore = heuristicImportance(shortText);
        const longScore = heuristicImportance(longText);
        expect(longScore).toBeGreaterThanOrEqual(shortScore);
    });
});

describe('deduplicateFacts', () => {
    const existingFacts: WorldFact[] = [
        {
            id: 'f1',
            conversationId: 'c1',
            messageId: 'm1',
            fact: 'The warrior found a magical sword',
            category: 'item',
            importance: 7,
            active: true,
            timestamp: Date.now(),
            relatedEntities: ['Warrior', 'Magical Sword'],
            lastAccessedAt: Date.now(),
            accessCount: 1,
        },
    ];

    it('removes exact duplicates', () => {
        const newFacts = [{
            conversationId: 'c1',
            messageId: 'm2',
            fact: 'The warrior found a magical sword',
            category: 'item' as const,
            importance: 7,
            active: true,
            timestamp: Date.now(),
            relatedEntities: ['Warrior', 'Magical Sword'],
            lastAccessedAt: Date.now(),
            accessCount: 0,
        }];
        const result = deduplicateFacts(newFacts, existingFacts);
        expect(result).toHaveLength(0);
    });

    it('keeps genuinely new facts', () => {
        const newFacts = [{
            conversationId: 'c1',
            messageId: 'm2',
            fact: 'The mage cast a protective barrier',
            category: 'event' as const,
            importance: 6,
            active: true,
            timestamp: Date.now(),
            relatedEntities: ['Mage'],
            lastAccessedAt: Date.now(),
            accessCount: 0,
        }];
        const result = deduplicateFacts(newFacts, existingFacts);
        expect(result).toHaveLength(1);
    });

    it('handles empty existing facts', () => {
        const newFacts = [{
            conversationId: 'c1',
            messageId: 'm1',
            fact: 'Something happened',
            category: 'event' as const,
            importance: 5,
            active: true,
            timestamp: Date.now(),
            relatedEntities: [],
            lastAccessedAt: Date.now(),
            accessCount: 0,
        }];
        const result = deduplicateFacts(newFacts, []);
        expect(result).toHaveLength(1);
    });
});
