'use client';

import { useCallback, useEffect, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores';
import {
    fetchNanoGPTUsage,
    formatUsageCount,
    formatUsageExact,
    formatUsagePercent,
    type NanoGPTUsage,
    type NanoGPTUsageWindow,
} from '@/lib/ai/nanogpt-usage';

// Window event other parts of the app dispatch to ask the badge/panel to refetch
// (e.g. the chat page after a generation consumes quota).
export const NANOGPT_USAGE_REFRESH_EVENT = 'nanogpt-usage-refresh';

/** Shared hook: fetch + cache the subscription usage, refetch on the global refresh event. */
function useNanoGPTUsage() {
    const [usage, setUsage] = useState<NanoGPTUsage | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (force = false) => {
        setLoading(true);
        const u = await fetchNanoGPTUsage(force);
        setUsage(u);
        setLoading(false);
    }, []);

    useEffect(() => {
        void load(false);
        const onRefresh = () => void load(true);
        window.addEventListener(NANOGPT_USAGE_REFRESH_EVENT, onRefresh);
        return () => window.removeEventListener(NANOGPT_USAGE_REFRESH_EVENT, onRefresh);
    }, [load]);

    return { usage, loading, refresh: () => load(true) };
}

// Float percentage (0..100) for the bar width — not rounded, so the bar tracks usage faithfully.
function usedPercent(w: NanoGPTUsageWindow): number {
    if (w.percentUsed != null) return Math.min(100, Math.max(0, w.percentUsed * 100));
    if (w.limit && w.used != null) return Math.min(100, Math.max(0, (w.used / w.limit) * 100));
    return 0;
}

function barColor(usedPct: number): string {
    return usedPct > 95 ? 'bg-red-500' : usedPct > 80 ? 'bg-yellow-500' : 'bg-green-500';
}

function formatReset(resetAt: number | null): string | null {
    if (!resetAt) return null;
    try {
        return new Date(resetAt).toLocaleString('fr-FR', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return null;
    }
}

/**
 * Compact badge for the chat header. Renders nothing unless NanoGPT is the active provider and
 * usage data is available. Shows remaining quota for the most meaningful window (week → month → day).
 */
export function NanoGPTUsageBadge() {
    const activeProvider = useSettingsStore((s) => s.activeProvider);
    const { usage } = useNanoGPTUsage();

    if (activeProvider !== 'nanogpt') return null;
    const w = usage?.primary;
    if (!w || w.remaining == null) return null;

    const usedPct = usedPercent(w);
    return (
        <div
            className="flex items-center gap-1.5 h-8 px-2 rounded-md text-xs font-medium text-muted-foreground shrink-0 border border-border/40 bg-muted/20"
            title={`NanoGPT — ${w.label} : ${formatUsageExact(w.used)} / ${formatUsageExact(w.limit)} ${w.unit} utilisés (${formatUsagePercent(w.used, w.limit, w.percentUsed)})`}
        >
            <Gauge
                className={`w-3.5 h-3.5 shrink-0 ${usedPct > 95 ? 'text-red-500' : usedPct > 80 ? 'text-yellow-500' : 'text-green-500'}`}
            />
            <span className="hidden sm:inline-block whitespace-nowrap">
                {formatUsageCount(w.remaining, w.unit)} {w.unit} · {w.label}
            </span>
            <span className="sm:hidden whitespace-nowrap">{formatUsageCount(w.remaining, w.unit)}</span>
        </div>
    );
}

/** Detailed quota panel for the Settings → API tab: one bar per window + reset dates. */
export function NanoGPTUsagePanel() {
    const { usage, loading, refresh } = useNanoGPTUsage();

    return (
        <div className="space-y-3 rounded-lg border border-border/50 p-4 bg-muted/10">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Gauge className="h-4 w-4" />
                    Quota d&apos;abonnement NanoGPT
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={refresh}
                    disabled={loading}
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    Rafraîchir
                </Button>
            </div>

            {!usage && (
                <p className="text-xs text-muted-foreground">
                    {loading
                        ? 'Chargement du quota…'
                        : 'Quota indisponible. Enregistrez une clé NanoGPT valide (abonnement Pro actif).'}
                </p>
            )}

            {usage && usage.windows.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    L&apos;API n&apos;a renvoyé aucune fenêtre de quota exploitable.
                </p>
            )}

            {usage?.windows.map((w) => {
                const usedPct = usedPercent(w);
                const reset = formatReset(w.resetAt);
                return (
                    <div key={w.key} className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                            <span className="capitalize text-muted-foreground">{w.label}</span>
                            <span className="font-mono">
                                <span className="text-foreground">
                                    {formatUsageExact(w.remaining)}
                                </span>
                                <span className="text-muted-foreground"> {w.unit} restants</span>
                            </span>
                        </div>
                        <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                            <div
                                className={`h-full ${barColor(usedPct)} rounded-full transition-all duration-300`}
                                style={{ width: `${usedPct}%` }}
                            />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                            <span className="font-mono">
                                {formatUsageExact(w.used)}
                                {w.limit != null && ` / ${formatUsageExact(w.limit)}`} {w.unit} ·{' '}
                                {formatUsagePercent(w.used, w.limit, w.percentUsed)} utilisé
                            </span>
                            {reset && <span>réinit. : {reset}</span>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
