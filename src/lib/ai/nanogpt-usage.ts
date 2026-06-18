// NanoGPT subscription quota helper.
//
// The published API docs and the live Pro plan disagree on the usage schema:
//   - docs: "operations/generations", windows `daily` + `monthly`
//   - Pro plan page: "60 million input tokens per week" (weekly, token-based)
// So we DON'T hardcode field names. `pickUsageWindow` reads whatever windows the live endpoint
// exposes, prefers the most meaningful one (weekly → monthly → daily), and infers the unit.

import { useSettingsStore } from '@/stores/settings-store';
import { decryptApiKey } from '@/lib/crypto';

export type UsageUnit = 'tokens' | 'images' | 'unités';

export interface NanoGPTUsageWindow {
    key: string; // raw window key, e.g. 'weekly' | 'monthly' | 'daily'
    label: string; // human label, e.g. 'cette semaine'
    used: number | null;
    remaining: number | null;
    limit: number | null;
    percentUsed: number | null; // 0..1
    resetAt: number | null; // epoch ms
    unit: UsageUnit;
}

export interface NanoGPTUsage {
    active: boolean;
    state: string | null;
    primary: NanoGPTUsageWindow | null; // best window for the compact badge
    windows: NanoGPTUsageWindow[]; // every detected window (for the settings detail)
    raw: unknown;
}

interface WindowDef {
    key: string;
    label: string; // time-window descriptor only; the unit noun is shown separately
    unit?: UsageUnit; // explicit unit; omitted defs infer it
}

// Real NanoGPT subscription usage keys (confirmed against the live endpoint, June 2026):
//   limits/values are `weeklyInputTokens`, `dailyInputTokens` (may be null), `dailyImages`.
// The generic weekly/monthly/daily names are kept as a fallback for the older doc-style schema.
// Order = priority: the headline token quota (weekly) is the badge's primary window.
const WINDOW_DEFS: WindowDef[] = [
    { key: 'weeklyInputTokens', label: 'semaine', unit: 'tokens' },
    { key: 'dailyInputTokens', label: 'jour', unit: 'tokens' },
    { key: 'monthlyInputTokens', label: 'mois', unit: 'tokens' },
    { key: 'dailyImages', label: 'images / jour', unit: 'images' },
    { key: 'weekly', label: 'semaine' },
    { key: 'week', label: 'semaine' },
    { key: 'monthly', label: 'mois' },
    { key: 'month', label: 'mois' },
    { key: 'daily', label: 'jour' },
    { key: 'day', label: 'jour' },
];

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function inferUnit(w: Record<string, unknown>, limit: number | null): UsageUnit {
    const hint = JSON.stringify(w).toLowerCase();
    return hint.includes('token') || (limit ?? 0) >= 1_000_000 ? 'tokens' : 'unités';
}

/** Build a normalized window from a raw window object + the top-level limits map. */
function buildWindow(
    def: WindowDef,
    raw: unknown,
    limits: Record<string, unknown> | null
): NanoGPTUsageWindow | null {
    const w = asRecord(raw);
    if (!w) return null; // null/absent windows (e.g. dailyInputTokens:null) are skipped

    let used = num(w.used);
    let remaining = num(w.remaining);
    let limit = num(w.limit) ?? (limits ? num(limits[def.key]) : null);
    let percentUsed = num(w.percentUsed);

    if (limit == null && used != null && remaining != null) limit = used + remaining;
    if (remaining == null && limit != null && used != null) remaining = limit - used;
    if (used == null && limit != null && remaining != null) used = limit - remaining;
    if (percentUsed == null && limit && used != null) percentUsed = limit > 0 ? used / limit : 0;

    return {
        key: def.key,
        label: def.label,
        used,
        remaining,
        limit,
        percentUsed,
        resetAt: num(w.resetAt) ?? num(w.reset) ?? num(w.resetsAt) ?? null,
        unit: def.unit ?? inferUnit(w, limit),
    };
}

/** Pick the most meaningful usage window from the raw subscription/v1/usage JSON. */
export function pickUsageWindow(json: unknown): { primary: NanoGPTUsageWindow | null; windows: NanoGPTUsageWindow[] } {
    const root = asRecord(json);
    if (!root) return { primary: null, windows: [] };

    const limits = asRecord(root.limits);
    const windows: NanoGPTUsageWindow[] = [];

    // Detect windows by the known keys, in priority order, deduping.
    const seen = new Set<string>();
    for (const def of WINDOW_DEFS) {
        if (seen.has(def.key)) continue;
        const built = buildWindow(def, root[def.key], limits);
        if (built) {
            windows.push(built);
            seen.add(def.key);
        }
    }

    return { primary: windows[0] ?? null, windows };
}

/** Normalize the full raw JSON into a NanoGPTUsage object. */
export function normalizeUsage(json: unknown): NanoGPTUsage {
    const root = asRecord(json) ?? {};
    const { primary, windows } = pickUsageWindow(json);
    return {
        active: root.active === true,
        state: typeof root.state === 'string' ? root.state : null,
        primary,
        windows,
        raw: json,
    };
}

// ---- Fetch + short-lived cache --------------------------------------------------------------

let cache: { value: NanoGPTUsage; at: number } | null = null;
const TTL_MS = 60_000;

/** Resolve and decrypt the stored NanoGPT key, or null if none. */
async function getNanoGptKey(): Promise<string | null> {
    const { apiKeys } = useSettingsStore.getState();
    const cfg = apiKeys.find((k) => k.provider === 'nanogpt');
    if (!cfg) return null;
    try {
        return (await decryptApiKey(cfg.encryptedKey)) || null;
    } catch {
        return null;
    }
}

/**
 * Fetch the subscription usage. Cached for 60s; pass `force` to bypass the cache
 * (e.g. right after a generation). Returns null if there's no NanoGPT key or the call fails.
 */
export async function fetchNanoGPTUsage(force = false): Promise<NanoGPTUsage | null> {
    if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;

    const apiKey = await getNanoGptKey();
    if (!apiKey) return null;

    try {
        const res = await fetch('/api/nanogpt/usage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        const value = normalizeUsage(json);
        cache = { value, at: Date.now() };
        return value;
    } catch {
        return null;
    }
}

/** Invalidate the cached usage (call after a generation so the next read refetches). */
export function invalidateNanoGPTUsage(): void {
    cache = null;
}

/**
 * Compact count for the tight header badge. Keeps 2 significant decimals in the millions so the
 * value visibly tracks consumption (59_968_354 → "59,97 M", not a misleading "60,0 M").
 */
export function formatUsageCount(n: number | null, unit: UsageUnit): string {
    if (n == null) return '—';
    if (unit === 'tokens') {
        if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace('.', ',')} M`;
        if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace('.', ',')} k`;
        return `${n}`;
    }
    return n.toLocaleString('fr-FR');
}

/** Exact, grouped count for the detail panel (e.g. 59_968_354 → "59 968 354"). No rounding. */
export function formatUsageExact(n: number | null): string {
    if (n == null) return '—';
    return n.toLocaleString('fr-FR');
}

/**
 * Percent-used string with adaptive precision so small-but-nonzero usage is visible
 * (0.000527 → "0,05 %", not "0 %"). Prefers the API's percentUsed; falls back to used/limit.
 */
export function formatUsagePercent(
    used: number | null,
    limit: number | null,
    percentUsed: number | null
): string {
    const p =
        percentUsed != null
            ? percentUsed * 100
            : limit && used != null
              ? (used / limit) * 100
              : 0;
    if (!Number.isFinite(p) || p <= 0) return '0 %';
    if (p < 0.01) return '< 0,01 %';
    const decimals = p < 1 ? 2 : p < 10 ? 1 : 0;
    return `${p.toFixed(decimals).replace('.', ',')} %`;
}
