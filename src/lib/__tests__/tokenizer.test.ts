/**
 * Tests for the tokenizer utility.
 */
import { describe, it, expect } from 'vitest';
import { countTokens, countTokensBatch, truncateToTokenBudget } from '../tokenizer';

describe('countTokens', () => {
    it('returns 0 for empty string', () => {
        expect(countTokens('')).toBe(0);
    });

    it('returns 0 for null/undefined input', () => {
        expect(countTokens(null as unknown as string)).toBe(0);
        expect(countTokens(undefined as unknown as string)).toBe(0);
    });

    it('counts tokens for a simple English sentence', () => {
        const tokens = countTokens('Hello, world!');
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(10);
    });

    it('counts more tokens for longer text', () => {
        const short = countTokens('Hello');
        const long = countTokens('Hello, this is a much longer sentence with many more words to count.');
        expect(long).toBeGreaterThan(short);
    });

    it('handles special characters and unicode', () => {
        const tokens = countTokens('🎲 Le guerrier frappe avec son épée ⚔️');
        expect(tokens).toBeGreaterThan(0);
    });

    it('handles very long text without crashing', () => {
        const longText = 'word '.repeat(10000);
        const tokens = countTokens(longText);
        expect(tokens).toBeGreaterThan(1000);
    });
});

describe('countTokensBatch', () => {
    it('returns 0 for empty array', () => {
        expect(countTokensBatch([])).toBe(0);
    });

    it('sums tokens across multiple texts', () => {
        const texts = ['Hello', 'World', 'Test'];
        const batchCount = countTokensBatch(texts);
        const manualCount = texts.reduce((s, t) => s + countTokens(t), 0);
        expect(batchCount).toBe(manualCount);
    });
});

describe('truncateToTokenBudget', () => {
    it('returns full text if within budget', () => {
        const result = truncateToTokenBudget('Hello', 100);
        expect(result.text).toBe('Hello');
        expect(result.tokens).toBeLessThanOrEqual(100);
    });

    it('truncates text exceeding budget', () => {
        const longText = 'word '.repeat(1000);
        const result = truncateToTokenBudget(longText, 50);
        expect(result.tokens).toBeLessThanOrEqual(50);
        expect(result.text.length).toBeLessThan(longText.length);
    });

    it('returns empty-ish result for budget of 0', () => {
        const result = truncateToTokenBudget('Hello world', 0);
        expect(result.tokens).toBe(0);
    });

    it('handles exact budget match', () => {
        const text = 'Hello';
        const tokens = countTokens(text);
        const result = truncateToTokenBudget(text, tokens);
        expect(result.text).toBe(text);
        expect(result.tokens).toBe(tokens);
    });
});
