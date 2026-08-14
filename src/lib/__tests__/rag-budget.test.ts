import { describe, it, expect } from 'vitest';
import { fitRankedBlock } from '@/lib/ai/rag-budget';
import { countTokens } from '@/lib/tokenizer';

const HEADER = '📖 Chronique:';
const render = (s: string) => s;

/** Items of roughly equal, non-trivial size, ranked most-relevant first. */
function rankedItems(n: number, wordsEach = 20): string[] {
    return Array.from({ length: n }, (_, i) => `item${i} ` + `contenu narratif `.repeat(wordsEach));
}

describe('fitRankedBlock', () => {
    it('keeps every item when the budget is generous', () => {
        const items = rankedItems(5);
        const r = fitRankedBlock(items, render, HEADER, 100_000);
        expect(r).not.toBeNull();
        expect(r!.kept).toEqual(items);
        expect(r!.dropped).toBe(0);
    });

    it('drops the TAIL, never the head, when the budget is tight', () => {
        const items = rankedItems(6);
        const full = countTokens(`${HEADER}\n${items.join('\n')}`);
        const r = fitRankedBlock(items, render, HEADER, Math.floor(full / 2));

        expect(r).not.toBeNull();
        expect(r!.kept.length).toBeGreaterThan(0);
        expect(r!.kept.length).toBeLessThan(items.length);
        // The survivors are a PREFIX of the ranking: highest-priority items first.
        expect(r!.kept).toEqual(items.slice(0, r!.kept.length));
        expect(r!.dropped).toBe(items.length - r!.kept.length);
    });

    it('survives a one-token overshoot instead of dropping the whole block', () => {
        // This is the exact regression: `if (tokens <= remaining)` threw away 100% of a block
        // that was over by a single token.
        const items = rankedItems(4);
        const full = countTokens(`${HEADER}\n${items.join('\n')}`);
        const r = fitRankedBlock(items, render, HEADER, full - 1);

        expect(r).not.toBeNull();
        expect(r!.kept.length).toBeGreaterThan(0);
    });

    it('never exceeds the budget — the count is the real one, not the sum of parts', () => {
        const items = rankedItems(8);
        const full = countTokens(`${HEADER}\n${items.join('\n')}`);
        // Sweep a range of budgets: BPE merges at the joins must never push us over.
        for (const budget of [40, 80, 150, 300, 600, full - 1, full, full + 50]) {
            const r = fitRankedBlock(items, render, HEADER, budget);
            if (!r) continue;
            expect(r.tokens).toBe(countTokens(r.text));
            expect(r.tokens).toBeLessThanOrEqual(budget);
        }
    });

    it('truncates the best item rather than returning nothing, when allowed', () => {
        const items = rankedItems(3, 60);
        const oneItem = countTokens(items[0]);
        // Room for a good chunk of the first item, but not all of it.
        const r = fitRankedBlock(items, render, HEADER, Math.floor(oneItem / 2), {
            truncateLast: true,
        });

        expect(r).not.toBeNull();
        expect(r!.text).toContain('[…]');
        expect(r!.kept.length).toBe(1);
        expect(r!.dropped).toBe(2);
    });

    it('returns null rather than a half-sentence when truncation is not allowed', () => {
        const items = rankedItems(3, 60);
        const oneItem = countTokens(items[0]);
        const r = fitRankedBlock(items, render, HEADER, Math.floor(oneItem / 2));
        expect(r).toBeNull();
    });

    it('refuses a leftover too small to leave anything readable', () => {
        const items = rankedItems(3, 60);
        const r = fitRankedBlock(items, render, HEADER, countTokens(HEADER) + 10, {
            truncateLast: true,
        });
        expect(r).toBeNull();
    });

    it('returns null on an empty list or a non-positive budget', () => {
        expect(fitRankedBlock([], render, HEADER, 1000)).toBeNull();
        expect(fitRankedBlock(rankedItems(3), render, HEADER, 0)).toBeNull();
        expect(fitRankedBlock(rankedItems(3), render, HEADER, -5)).toBeNull();
    });

    it('renders with the given separator and header', () => {
        const items = ['alpha', 'beta'];
        const r = fitRankedBlock(items, render, HEADER, 1000, { separator: '\n---\n' });
        expect(r!.text).toBe(`${HEADER}\n---\nalpha\n---\nbeta`);
    });

    it('supports structured items through renderItem', () => {
        const facts = [
            { text: 'la porte est verrouillée', score: 0.9 },
            { text: 'le gardien dort', score: 0.4 },
        ];
        const r = fitRankedBlock(facts, (f) => `• ${f.text}`, HEADER, 1000);
        expect(r!.text).toContain('• la porte est verrouillée');
        expect(r!.kept[0].score).toBe(0.9);
    });
});
