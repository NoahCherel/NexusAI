import { describe, it, expect } from 'vitest';
import { parseRepeatedPhrases, isAnalysisStale } from '@/lib/ai/style-analyzer';
import { buildLearnedBanBlock } from '@/lib/ai/rp-engine';

describe('parseRepeatedPhrases', () => {
    it('parses a plain JSON array', () => {
        expect(parseRepeatedPhrases('["rule one", "rule two"]')).toEqual(['rule one', 'rule two']);
    });

    it('tolerates code fences and surrounding prose', () => {
        const raw = 'Here you go:\n```json\n["avoid cliches", "vary openings"]\n```\nDone.';
        expect(parseRepeatedPhrases(raw)).toEqual(['avoid cliches', 'vary openings']);
    });

    it('strips <think> leakage before parsing', () => {
        expect(parseRepeatedPhrases('<think>let me see</think>["rule a"]')).toEqual(['rule a']);
    });

    it('caps at 5 results and drops too-short entries', () => {
        const raw = JSON.stringify(['a', 'one', 'two', 'three', 'four', 'five', 'six']);
        expect(parseRepeatedPhrases(raw)).toEqual(['one', 'two', 'three', 'four', 'five']);
    });

    it('returns [] on non-array or garbage', () => {
        expect(parseRepeatedPhrases('not json at all')).toEqual([]);
        expect(parseRepeatedPhrases('{"a":1}')).toEqual([]);
    });
});

describe('isAnalysisStale', () => {
    const base = { runId: 1, conversationId: 'conv-1', branchTipId: 'tip-a' };

    it('is fresh when the run, conversation and branch tip all match', () => {
        expect(isAnalysisStale(base, { ...base })).toBe(false);
    });

    it('is stale when a newer analysis run has started', () => {
        expect(isAnalysisStale(base, { ...base, runId: 2 })).toBe(true);
    });

    it('is stale when the conversation changed', () => {
        expect(isAnalysisStale(base, { ...base, conversationId: 'conv-2' })).toBe(true);
    });

    it('is stale after a swipe (same conversation, different branch tip)', () => {
        expect(isAnalysisStale(base, { ...base, branchTipId: 'tip-b' })).toBe(true);
    });

    it('is stale on A→B→A even though the tip returned to the same value (runId moved)', () => {
        // Returned to tip-a, but two swipes bumped the run counter in between.
        expect(isAnalysisStale(base, { ...base, runId: 3, branchTipId: 'tip-a' })).toBe(true);
    });
});

describe('buildLearnedBanBlock', () => {
    it('formats a STYLE GUARD block with bulleted rules', () => {
        const block = buildLearnedBanBlock(['avoid X', 'avoid Y']);
        expect(block).toContain('STYLE GUARD');
        expect(block).toContain('- avoid X');
        expect(block).toContain('- avoid Y');
    });

    it('returns an empty string when there are no real rules', () => {
        expect(buildLearnedBanBlock([])).toBe('');
        expect(buildLearnedBanBlock(['   '])).toBe('');
    });
});
