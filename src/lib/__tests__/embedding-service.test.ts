/**
 * Tests for the embedding service.
 * These tests focus on the TF-IDF fallback since ML model loading
 * requires a browser environment.
 */
import { describe, it, expect } from 'vitest';
import { cosineSimilarity, findTopK } from '../ai/embedding-service';

describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
        const vec = [1, 0, 0, 1];
        expect(cosineSimilarity(vec, vec)).toBeCloseTo(1, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
        const a = [1, 0, 0, 0];
        const b = [0, 1, 0, 0];
        expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('returns -1 for opposite vectors', () => {
        const a = [1, 0];
        const b = [-1, 0];
        expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
    });

    it('returns 0 for zero vectors', () => {
        expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
        expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
    });

    it('returns 0 for mismatched lengths', () => {
        expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it('correctly computes similarity for known vectors', () => {
        const a = [1, 2, 3];
        const b = [4, 5, 6];
        // Manual: dot=32, normA=sqrt(14), normB=sqrt(77), sim=32/sqrt(1078)=0.9746
        const sim = cosineSimilarity(a, b);
        expect(sim).toBeCloseTo(0.9746, 3);
    });
});

describe('findTopK', () => {
    it('returns empty array for empty items', () => {
        const result = findTopK([1, 0, 0], [], 5);
        expect(result).toEqual([]);
    });

    it('finds most similar items', () => {
        const query = [1, 0, 0];
        const items = [
            { id: 'a', embedding: [1, 0, 0] },
            { id: 'b', embedding: [0, 1, 0] },
            { id: 'c', embedding: [0.9, 0.1, 0] },
        ];
        const result = findTopK(query, items, 2);
        expect(result.length).toBe(2);
        expect(result[0].item.id).toBe('a'); // Most similar
        expect(result[0].score).toBeCloseTo(1, 3);
    });

    it('respects minScore filter', () => {
        const query = [1, 0, 0];
        const items = [
            { id: 'a', embedding: [1, 0, 0] },
            { id: 'b', embedding: [0, 1, 0] }, // score = 0, below minScore
        ];
        const result = findTopK(query, items, 5, 0.5);
        expect(result.length).toBe(1);
        expect(result[0].item.id).toBe('a');
    });

    it('limits to k results', () => {
        const query = [1, 0, 0];
        const items = Array.from({ length: 20 }, (_, i) => ({
            id: `item-${i}`,
            embedding: [1 - i * 0.04, i * 0.04, 0],
        }));
        const result = findTopK(query, items, 3);
        expect(result.length).toBeLessThanOrEqual(3);
    });

    it('skips items without embeddings', () => {
        const query = [1, 0, 0];
        const items = [
            { id: 'a', embedding: [1, 0, 0] },
            { id: 'b', embedding: undefined },
            { id: 'c' },
        ] as any[];
        const result = findTopK(query, items, 5);
        expect(result.length).toBe(1);
    });
});
