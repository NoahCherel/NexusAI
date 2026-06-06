import { describe, it, expect } from 'vitest';
import { lexicalSimilarity, detectStall, buildMomentumNudge } from '@/lib/ai/momentum';

describe('lexicalSimilarity', () => {
    it('returns 1 for identical content', () => {
        const t = 'The dragon circled the burning tower slowly.';
        expect(lexicalSimilarity(t, t)).toBeCloseTo(1, 5);
    });

    it('returns 0 for fully disjoint content', () => {
        expect(lexicalSimilarity('dragon tower fire', 'banker spreadsheet meeting')).toBe(0);
    });

    it('ignores stop words and punctuation', () => {
        const a = 'The knight, with his sword, rode.';
        const b = 'A knight rode his sword!';
        expect(lexicalSimilarity(a, b)).toBeGreaterThan(0.5);
    });
});

describe('detectStall', () => {
    it('is not stalled without a previous beat', () => {
        expect(detectStall('anything', undefined, false).stalled).toBe(false);
    });

    it('flags near-identical consecutive beats when state did not change', () => {
        const beat = 'Rukia stares at the rain, saying nothing, waiting for a sign.';
        const res = detectStall(beat, beat, false);
        expect(res.stalled).toBe(true);
        expect(res.similarity).toBeGreaterThan(0.5);
    });

    it('does not flag when the world state moved', () => {
        const beat = 'Rukia stares at the rain, saying nothing.';
        expect(detectStall(beat, beat, true).stalled).toBe(false);
    });

    it('does not flag genuinely novel beats', () => {
        const a = 'Rukia draws her zanpakuto and lunges at the hollow.';
        const b = 'Renji bursts through the door with urgent news from Soul Society.';
        expect(detectStall(a, b, false).stalled).toBe(false);
    });
});

describe('buildMomentumNudge', () => {
    it('targets the next beat when provided', () => {
        expect(buildMomentumNudge('the Chunin exams begin')).toContain('the Chunin exams begin');
    });

    it('falls back to a generic complication when no beat is set', () => {
        expect(buildMomentumNudge()).toMatch(/complication|new goal|external event/);
    });
});
