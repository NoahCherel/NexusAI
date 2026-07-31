/**
 * The /api/chat stream appends a trailing `<|nexus_usage|>{json}` sentinel carrying the
 * provider-reported token accounting (OpenRouter's REAL billed cost included). EVERY
 * consumer of that stream must strip it — a JSON parser downstream (Director, extractors)
 * or a saved note would otherwise ingest the raw sentinel as content.
 */

export interface ProviderUsage {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
    cost?: number;
}

export const USAGE_SENTINEL_RE = /\n?<\|nexus_usage\|>(\{[\s\S]*?\})\s*$/;

/** Strip the sentinel and parse its payload (undefined when absent/malformed). */
export function extractUsageSentinel(raw: string): { clean: string; usage?: ProviderUsage } {
    const match = raw.match(USAGE_SENTINEL_RE);
    if (!match) return { clean: raw };
    const clean = raw.replace(USAGE_SENTINEL_RE, '');
    try {
        const u = JSON.parse(match[1]);
        return {
            clean,
            usage: {
                promptTokens: u.promptTokens ?? 0,
                completionTokens: u.completionTokens ?? 0,
                cachedTokens: u.cachedTokens,
                cost: u.cost,
            },
        };
    } catch {
        return { clean }; // malformed sentinel — caller falls back to local estimates
    }
}
