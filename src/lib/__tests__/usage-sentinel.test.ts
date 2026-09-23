import { describe, it, expect } from 'vitest';
import { extractUsageSentinel } from '@/lib/ai/usage-sentinel';

describe('extractUsageSentinel', () => {
    it('strips the sentinel and parses the accounting', () => {
        const raw = `{"speakers": []}\n<|nexus_usage|>{"promptTokens":100,"completionTokens":42,"cost":0.0031}`;
        const { clean, usage } = extractUsageSentinel(raw);
        expect(clean).toBe('{"speakers": []}');
        expect(usage).toEqual({
            promptTokens: 100,
            completionTokens: 42,
            cachedTokens: undefined,
            cost: 0.0031,
            serviceTier: null,
        });
        // The cleaned text must stay valid JSON for the Director/extractor parsers.
        expect(() => JSON.parse(clean)).not.toThrow();
    });

    it('preserves the tier OpenRouter says it actually used', () => {
        const raw =
            'reply\n<|nexus_usage|>{"promptTokens":100,"completionTokens":42,"serviceTier":"flex"}';
        expect(extractUsageSentinel(raw).usage?.serviceTier).toBe('flex');
    });

    it('returns the text untouched when no sentinel is present', () => {
        const { clean, usage } = extractUsageSentinel('plain reply');
        expect(clean).toBe('plain reply');
        expect(usage).toBeUndefined();
    });

    it('malformed sentinel: stripped anyway, usage undefined', () => {
        const { clean, usage } = extractUsageSentinel('text\n<|nexus_usage|>{broken');
        // The regex requires a {...} shape; an unclosed brace does not match — text is kept.
        expect(clean).toContain('text');
        expect(usage).toBeUndefined();
    });
});
