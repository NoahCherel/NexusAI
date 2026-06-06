import { describe, it, expect } from 'vitest';
import {
    applyAxisDelta,
    applyDeltas,
    makeRelationship,
    axisLabel,
    NORMAL_DELTA_CAP,
    LEDGER_MAX,
} from '@/lib/ai/relationship-engine';

describe('applyAxisDelta — caps', () => {
    it('caps a normal raw delta to NORMAL_DELTA_CAP before inertia', () => {
        // affection up ×0.8: a huge +500 request, capped to +8, ×0.8 = +6.4 → +6
        const { applied } = applyAxisDelta(0, 500, 'affection');
        expect(applied).toBe(Math.round(NORMAL_DELTA_CAP * 0.8));
    });

    it('allows a larger jump for a major event', () => {
        const normal = applyAxisDelta(0, 100, 'trust', false).applied;
        const major = applyAxisDelta(0, 100, 'trust', true).applied;
        expect(major).toBeGreaterThan(normal);
    });
});

describe('applyAxisDelta — trust is slow up, fast down (anti-positivity)', () => {
    it('gains trust slowly', () => {
        // +8 raw × 0.5 = +4
        expect(applyAxisDelta(0, 8, 'trust').applied).toBe(4);
    });

    it('loses trust fast', () => {
        // -8 raw × 1.2 = -9.6 → -10
        expect(applyAxisDelta(0, -8, 'trust').applied).toBe(-10);
    });

    it('it is strictly harder to gain trust than to lose it for the same raw magnitude', () => {
        const gain = applyAxisDelta(0, 8, 'trust').applied; // +4
        const loss = applyAxisDelta(0, -8, 'trust').applied; // -10
        expect(Math.abs(loss)).toBeGreaterThan(Math.abs(gain));
    });
});

describe('applyAxisDelta — resistance near extremes', () => {
    it('moves less when already high and pushing higher', () => {
        const lowMove = applyAxisDelta(0, 8, 'affection').applied; // from 0
        const highMove = applyAxisDelta(80, 8, 'affection').applied; // from 80, resisted
        expect(highMove).toBeLessThan(lowMove);
    });

    it('does NOT resist when pulling back toward zero from a high value', () => {
        // From +80, a negative delta should not be dampened by extreme-resistance.
        const pullBack = applyAxisDelta(80, -8, 'affection').applied; // ×1.0 down, no resistance
        expect(pullBack).toBe(-8);
    });

    it('cannot exceed the bounds', () => {
        expect(applyAxisDelta(98, 100, 'attraction', true).value).toBe(100);
        expect(applyAxisDelta(-98, -100, 'trust', true).value).toBe(-100);
    });
});

describe('applyDeltas — ledger', () => {
    it('records the EFFECTIVE delta and reason, not the raw request', () => {
        const rel = makeRelationship('Naruto', '{{user}}');
        const next = applyDeltas(
            rel,
            [{ axis: 'trust', delta: 8, reason: 'shared a meal' }],
            'msg1'
        );
        expect(next.axes.trust).toBe(4); // +8 raw × 0.5
        expect(next.ledger).toHaveLength(1);
        expect(next.ledger[0]).toMatchObject({
            axis: 'trust',
            delta: 4,
            reason: 'shared a meal',
            messageId: 'msg1',
        });
    });

    it('drops deltas that round to zero (no phantom ledger spam)', () => {
        const rel = makeRelationship('A', 'B', { trust: 100 });
        // pushing +1 against a maxed, resisted axis → rounds to 0 → no entry
        const next = applyDeltas(rel, [{ axis: 'trust', delta: 1, reason: 'tiny' }]);
        expect(next.ledger).toHaveLength(0);
        expect(next).toBe(rel); // unchanged reference when nothing applied
    });

    it('caps ledger length to LEDGER_MAX', () => {
        let rel = makeRelationship('A', 'B');
        for (let i = 0; i < LEDGER_MAX + 5; i++) {
            rel = applyDeltas(rel, [{ axis: 'affection', delta: -8, reason: `event ${i}` }]);
        }
        expect(rel.ledger.length).toBe(LEDGER_MAX);
        // The most recent entry is kept
        expect(rel.ledger[rel.ledger.length - 1].reason).toBe(`event ${LEDGER_MAX + 4}`);
    });

    it('applies multiple axes in one batch', () => {
        const rel = makeRelationship('A', 'B');
        const next = applyDeltas(rel, [
            { axis: 'affection', delta: 8, reason: 'kind' },
            { axis: 'respect', delta: 8, reason: 'skilled' },
        ]);
        expect(next.axes.affection).toBeGreaterThan(0);
        expect(next.axes.respect).toBeGreaterThan(0);
        expect(next.ledger).toHaveLength(2);
    });
});

describe('axisLabel', () => {
    it('labels trust extremes and middle', () => {
        expect(axisLabel('trust', -80)).toBe('betrayed/hostile');
        expect(axisLabel('trust', 5)).toBe('wary');
        expect(axisLabel('trust', 90)).toBe('fully relies on them');
    });
});
