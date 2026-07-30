'use client';

/**
 * Weekly OpenRouter budget badge — the OpenRouter twin of the NanoGPT quota badge.
 *
 * The user sets a weekly budget (USD) in Settings; every generation's REAL accounted cost
 * (OpenRouter's `usage.cost`, captured by the stream sentinel) accumulates in the store,
 * rolling over each Monday. The badge shows spend vs budget, plus an ESTIMATE of how many
 * tokens the remaining budget buys at the ACTIVE model's price (from OpenRouter's public
 * models API; RP is prompt-heavy so the blend weighs prompt 3:1 over completion).
 */

import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { useSettingsStore, currentWeekStart } from '@/stores/settings-store';

interface ModelPrice {
    prompt: number; // USD per token
    completion: number;
}

// Session-wide pricing cache (the models list is ~1MB; fetch once).
let pricingPromise: Promise<Map<string, ModelPrice>> | null = null;

function getPricing(): Promise<Map<string, ModelPrice>> {
    if (!pricingPromise) {
        pricingPromise = fetch('https://openrouter.ai/api/v1/models')
            .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
            .then((json: { data?: { id: string; pricing?: { prompt?: string; completion?: string } }[] }) => {
                const map = new Map<string, ModelPrice>();
                for (const m of json.data ?? []) {
                    const prompt = Number(m.pricing?.prompt ?? NaN);
                    const completion = Number(m.pricing?.completion ?? NaN);
                    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
                        map.set(m.id, { prompt, completion });
                    }
                }
                return map;
            })
            .catch((err) => {
                console.warn('[Budget] OpenRouter pricing fetch failed:', err);
                pricingPromise = null; // allow a later retry
                return new Map<string, ModelPrice>();
            });
    }
    return pricingPromise;
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)} k`;
    return String(Math.round(n));
}

export function OpenRouterBudgetBadge() {
    const activeProvider = useSettingsStore((s) => s.activeProvider);
    const activeModel = useSettingsStore((s) => s.activeModel);
    const weeklyBudgetUsd = useSettingsStore((s) => s.weeklyBudgetUsd);
    const weeklySpend = useSettingsStore((s) => s.weeklySpend);
    const [price, setPrice] = useState<ModelPrice | null>(null);

    const enabled =
        (activeProvider === 'openrouter' || activeProvider === 'anthropic') &&
        !!weeklyBudgetUsd &&
        weeklyBudgetUsd > 0;

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        getPricing().then((map) => {
            if (!cancelled) setPrice(map.get(activeModel) ?? null);
        });
        return () => {
            cancelled = true;
        };
    }, [enabled, activeModel]);

    if (!enabled) return null;

    const spent = weeklySpend.weekStart === currentWeekStart() ? weeklySpend.cost : 0;
    const budget = weeklyBudgetUsd!;
    const remaining = Math.max(0, budget - spent);
    const usedPct = Math.min(100, (spent / budget) * 100);

    // Blended RP price (prompt-heavy 3:1). Null when the model has no listed pricing.
    const blended = price ? (3 * price.prompt + price.completion) / 4 : null;
    const tokensLeft = blended && blended > 0 ? remaining / blended : null;

    const color =
        usedPct > 95 ? 'text-red-500' : usedPct > 80 ? 'text-yellow-500' : 'text-green-500';

    return (
        <div
            className="flex items-center gap-1.5 h-8 px-2 rounded-md text-xs font-medium text-muted-foreground shrink-0 border border-border/40 bg-muted/20"
            title={`Budget OpenRouter — ${spent.toFixed(2)} $ dépensés sur ${budget.toFixed(2)} $ cette semaine (reset lundi).${
                tokensLeft !== null
                    ? ` Le restant ≈ ${formatTokens(tokensLeft)} tokens au prix de ${activeModel}.`
                    : ''
            } Coûts réels facturés par OpenRouter uniquement.`}
        >
            <Wallet className={`w-3.5 h-3.5 shrink-0 ${color}`} />
            <span className="hidden sm:inline-block whitespace-nowrap">
                {remaining.toFixed(2)} $
                {tokensLeft !== null ? ` · ≈ ${formatTokens(tokensLeft)} tok` : ''} · semaine
            </span>
            <span className="sm:hidden whitespace-nowrap">
                {tokensLeft !== null ? `≈ ${formatTokens(tokensLeft)} tok` : `${remaining.toFixed(2)} $`}
            </span>
        </div>
    );
}
