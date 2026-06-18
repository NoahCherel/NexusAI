/**
 * The NanoGPT subscription usage schema is ambiguous in the wild: the published API docs describe
 * "operations" in daily/monthly windows, while the live Pro plan advertises weekly input-token
 * limits. `pickUsageWindow` must tolerate BOTH and pick the most meaningful window + infer the unit
 * without hardcoding either schema. These tests pin that behavior.
 */

import { describe, it, expect } from 'vitest';
import {
    pickUsageWindow,
    normalizeUsage,
    formatUsageCount,
    formatUsageExact,
    formatUsagePercent,
} from '@/lib/ai/nanogpt-usage';

describe('pickUsageWindow', () => {
    it('parses the real live schema (weeklyInputTokens + dailyImages, dailyInputTokens:null)', () => {
        // Captured verbatim from GET /api/subscription/v1/usage on a live Pro key (June 2026).
        const json = {
            active: true,
            limits: { weeklyInputTokens: 60_000_000, dailyInputTokens: null, dailyImages: 100 },
            dailyImages: { used: 0, remaining: 100, percentUsed: 0, resetAt: 1_781_827_200_000 },
            dailyInputTokens: null,
            weeklyInputTokens: {
                used: 31_646,
                remaining: 59_968_354,
                percentUsed: 0.0005274333,
                resetAt: 1_782_086_400_000,
            },
            state: 'active',
        };
        const { primary, windows } = pickUsageWindow(json);
        // Primary window = the headline weekly token quota.
        expect(primary?.key).toBe('weeklyInputTokens');
        expect(primary?.label).toBe('semaine');
        expect(primary?.unit).toBe('tokens');
        expect(primary?.remaining).toBe(59_968_354);
        expect(primary?.limit).toBe(60_000_000); // sourced from limits.weeklyInputTokens
        expect(primary?.resetAt).toBe(1_782_086_400_000);
        // dailyInputTokens is null → skipped; dailyImages kept as a separate images window.
        expect(windows.map((w) => w.key)).toEqual(['weeklyInputTokens', 'dailyImages']);
        const images = windows.find((w) => w.key === 'dailyImages');
        expect(images?.unit).toBe('images');
        expect(images?.remaining).toBe(100);
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

describe('formatUsageCount (compact badge)', () => {
    it('keeps 2 decimals in the millions so it tracks consumption', () => {
        // 59_968_354 must NOT collapse to "60,0 M" — that hid real usage in the first version.
        expect(formatUsageCount(59_968_354, 'tokens')).toBe('59,97 M');
        expect(formatUsageCount(58_200_000, 'tokens')).toBe('58,20 M');
        expect(formatUsageCount(4995, 'tokens')).toBe('5,0 k');
        expect(formatUsageCount(420, 'tokens')).toBe('420');
    });

    it('renders a dash for null', () => {
        expect(formatUsageCount(null, 'tokens')).toBe('—');
        expect(formatUsageCount(null, 'unités')).toBe('—');
    });
});

describe('formatUsageExact', () => {
    it('groups the full integer with no rounding', () => {
        // fr-FR groups with a narrow no-break space (U+202F); assert via digit-only comparison.
        expect(formatUsageExact(59_968_354).replace(/\D/g, '')).toBe('59968354');
        expect(formatUsageExact(0)).toBe('0');
        expect(formatUsageExact(null)).toBe('—');
    });
});

describe('formatUsagePercent', () => {
    it('shows small-but-nonzero usage instead of a flat 0%', () => {
        expect(formatUsagePercent(31_646, 60_000_000, 0.0005274333)).toBe('0,05 %');
    });

    it('adapts decimals to magnitude and floors tiny values', () => {
        expect(formatUsagePercent(null, null, 0)).toBe('0 %');
        expect(formatUsagePercent(1, 1_000_000, null)).toBe('< 0,01 %');
        expect(formatUsagePercent(null, null, 0.053)).toBe('5,3 %'); // 1–10% → 1 decimal
        expect(formatUsagePercent(null, null, 0.123)).toBe('12 %'); // ≥10% → integer
        expect(formatUsagePercent(null, null, 0.5)).toBe('50 %');
    });

    it('derives the percent from used/limit when percentUsed is absent', () => {
        expect(formatUsagePercent(30, 100, null)).toBe('30 %');
    });
});
