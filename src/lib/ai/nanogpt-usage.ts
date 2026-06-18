// NanoGPT subscription quota helper.
//
// The published API docs and the live Pro plan disagree on the usage schema:
//   - docs: "operations/generations", windows `daily` + `monthly`
//   - Pro plan page: "60 million input tokens per week" (weekly, token-based)
// So we DON'T hardcode field names. `pickUsageWindow` reads whatever windows the live endpoint
// exposes, prefers the most meaningful one (weekly → monthly → daily), and infers the unit.

import { useSettingsStore } from '@/stores/settings-store';
import { decryptApiKey } from '@/lib/crypto';

export type UsageUnit = 'tokens' | 'unités';

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

const WINDOW_PRIORITY = ['weekly', 'week', 'monthly', 'month', 'daily', 'day'] as const;

const WINDOW_LABELS: Record<string, string> = {
    weekly: 'cette semaine',
    week: 'cette semaine',
    monthly: 'ce mois',
    month: 'ce mois',
    daily: "aujourd'hui",
    day: "aujourd'hui",
};

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Build a normalized window from a raw window object + the top-level limits map. */
function buildWindow(key: string, raw: unknown, limits: Record<string, unknown> | null): NanoGPTUsageWindow | null {
    const w = asRecord(raw);
    if (!w) return null;

    let used = num(w.used);
    let remaining = num(w.remaining);
    let limit = num(w.limit) ?? (limits ? num(limits[key]) : null);
    let percentUsed = num(w.percentUsed);

    if (limit == null && used != null && remaining != null) limit = used + remaining;
    if (remaining == null && limit != null && used != null) remaining = limit - used;
    if (used == null && limit != null && remaining != null) used = limit - remaining;
    if (percentUsed == null && limit && used != null) percentUsed = limit > 0 ? used / limit : 0;

    // Unit inference: token-based if a field/key hints "token" or the magnitude is large
    // (the weekly Pro quota is tens of millions, far above any per-day operation count).
    const hint = JSON.stringify(w).toLowerCase();
    const unit: UsageUnit =
        hint.includes('token') || (limit ?? 0) >= 1_000_000 ? 'tokens' : 'unités';

    return {
        key,
        label: WINDOW_LABELS[key] ?? key,
        used,
        remaining,
        limit,
        percentUsed,
        resetAt: num(w.resetAt) ?? num(w.reset) ?? num(w.resetsAt) ?? null,
        unit,
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
    for (const key of WINDOW_PRIORITY) {
        if (seen.has(key)) continue;
        const built = buildWindow(key, root[key], limits);
        if (built) {
            windows.push(built);
            seen.add(key);
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

/** Format a count for display, compacting large token counts (e.g. 58_200_000 → "58,2 M"). */
export function formatUsageCount(n: number | null, unit: UsageUnit): string {
    if (n == null) return '—';
    if (unit === 'tokens') {
        if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`;
        if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)} k`;
        return `${n}`;
    }
    return n.toLocaleString('fr-FR');
}
