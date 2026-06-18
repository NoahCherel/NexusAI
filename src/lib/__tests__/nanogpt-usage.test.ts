/**
 * The NanoGPT subscription usage schema is ambiguous in the wild: the published API docs describe
 * "operations" in daily/monthly windows, while the live Pro plan advertises weekly input-token
 * limits. `pickUsageWindow` must tolerate BOTH and pick the most meaningful window + infer the unit
 * without hardcoding either schema. These tests pin that behavior.
 */

import { describe, it, expect } from 'vitest';
import { pickUsageWindow, normalizeUsage, formatUsageCount } from '@/lib/ai/nanogpt-usage';

describe('pickUsageWindow', () => {
    it('prefers a weekly token window and infers the tokens unit', () => {
        const json = {
            active: true,
            limits: { weekly: 60_000_000 },
            weekly: {
                used: 1_800_000,
                remaining: 58_200_000,
                percentUsed: 0.03,
                resetAt: 1_750_000_000_000,
            },
            state: 'active',
        };
        const { primary, windows } = pickUsageWindow(json);
        expect(primary?.key).toBe('weekly');
        expect(primary?.label).toBe('cette semaine');
        expect(primary?.unit).toBe('tokens');
        expect(primary?.remaining).toBe(58_200_000);
        expect(primary?.limit).toBe(60_000_000);
        expect(primary?.resetAt).toBe(1_750_000_000_000);
        expect(windows).toHaveLength(1);
    });

    it('falls back to monthly (over daily) for the stale operations schema', () => {
        const json = {
            active: true,
            limits: { daily: 5000, monthly: 60000 },
            daily: { used: 5, remaining: 4995, percentUsed: 0.001, resetAt: 1 },
            monthly: { used: 45, remaining: 59955, percentUsed: 0.00075, resetAt: 2 },
            state: 'active',
        };
        const { primary, windows } = pickUsageWindow(json);
        // No weekly window → monthly wins, and small magnitudes read as "unités", not tokens.
        expect(primary?.key).toBe('monthly');
        expect(primary?.unit).toBe('unités');
        expect(primary?.remaining).toBe(59955);
        // Both windows detected, monthly listed before daily (priority order).
        expect(windows.map((w) => w.key)).toEqual(['monthly', 'daily']);
    });

    it('derives remaining/percentUsed from used + limit when missing', () => {
        const json = { weekly: { used: 10_000_000, limit: 60_000_000 } };
        const { primary } = pickUsageWindow(json);
        expect(primary?.remaining).toBe(50_000_000);
        expect(primary?.percentUsed).toBeCloseTo(10_000_000 / 60_000_000, 5);
        expect(primary?.unit).toBe('tokens'); // large magnitude
    });

    it('infers limit from used + remaining when no explicit limit is given', () => {
        const json = { daily: { used: 30, remaining: 70 } };
        const { primary } = pickUsageWindow(json);
        expect(primary?.limit).toBe(100);
        expect(primary?.percentUsed).toBeCloseTo(0.3, 5);
    });

    it('returns empty for non-object / empty input', () => {
        expect(pickUsageWindow(null).primary).toBeNull();
        expect(pickUsageWindow(undefined).windows).toHaveLength(0);
        expect(pickUsageWindow({}).primary).toBeNull();
    });
});

describe('normalizeUsage', () => {
    it('surfaces active + state alongside the picked window', () => {
        const usage = normalizeUsage({
            active: true,
            state: 'active',
            weekly: { used: 0, remaining: 60_000_000, limit: 60_000_000 },
        });
        expect(usage.active).toBe(true);
        expect(usage.state).toBe('active');
        expect(usage.primary?.remaining).toBe(60_000_000);
    });

    it('treats a missing active flag as inactive', () => {
        const usage = normalizeUsage({ weekly: { used: 0, remaining: 1, limit: 1 } });
        expect(usage.active).toBe(false);
        expect(usage.state).toBeNull();
    });
});

describe('formatUsageCount', () => {
    it('compacts large token counts', () => {
        expect(formatUsageCount(58_200_000, 'tokens')).toBe('58,2 M');
        expect(formatUsageCount(4995, 'tokens')).toBe('5 k');
        expect(formatUsageCount(420, 'tokens')).toBe('420');
    });

    it('renders a dash for null', () => {
        expect(formatUsageCount(null, 'tokens')).toBe('—');
        expect(formatUsageCount(null, 'unités')).toBe('—');
    });
});
