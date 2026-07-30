'use client';

/**
 * Embedded Chub.ai catalogue browser (used as a tab of the CharacterImporter dialog):
 * search + sort + grid of cards, one-click import through the existing /api/import route.
 * JannyAI has no reachable catalogue API (Cloudflare) — its cards go through the URL tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Star, MessageSquare, Download, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CharacterCard } from '@/types';

interface MarketplaceCard {
    name: string;
    fullPath: string;
    tagline: string;
    avatarUrl: string;
    stars: number;
    chats: number;
    tokens: number;
    topics: string[];
    nsfwImage: boolean;
}

function formatCount(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function MarketplaceBrowser({
    onImported,
}: {
    onImported: (character: CharacterCard) => void;
}) {
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('star_count');
    const [nsfw, setNsfw] = useState(false);
    const [results, setResults] = useState<MarketplaceCard[]>([]);
    const [page, setPage] = useState(1);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [importingPath, setImportingPath] = useState<string | null>(null);
    const [importedPaths, setImportedPaths] = useState<Set<string>>(new Set());
    const [brokenAvatars, setBrokenAvatars] = useState<Set<string>>(new Set());
    // Guards against out-of-order responses (fast typing + slow network).
    const searchSeq = useRef(0);

    const search = useCallback(
        async (targetPage: number, append: boolean) => {
            const seq = ++searchSeq.current;
            setIsLoading(true);
            setError(null);
            try {
                const res = await fetch('/api/marketplace', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, page: targetPage, nsfw, sort }),
                });
                const data = await res.json();
                if (seq !== searchSeq.current) return; // stale response
                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                setResults((prev) => (append ? [...prev, ...data.results] : data.results));
                setPage(targetPage);
            } catch (err) {
                if (seq === searchSeq.current) {
                    setError(err instanceof Error ? err.message : 'Recherche échouée');
                }
            } finally {
                if (seq === searchSeq.current) setIsLoading(false);
            }
        },
        [query, nsfw, sort]
    );

    // Initial load + debounced re-search when query/sort/nsfw change.
    useEffect(() => {
        const t = setTimeout(() => void search(1, false), 350);
        return () => clearTimeout(t);
    }, [search]);

    const importCard = async (card: MarketplaceCard) => {
        setImportingPath(card.fullPath);
        setError(null);
        try {
            const res = await fetch('/api/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: `https://chub.ai/characters/${card.fullPath}` }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            const character: CharacterCard = {
                ...data.card,
                id: crypto.randomUUID(),
                avatar: data.avatarDataUrl || data.card.avatar || '',
            };
            onImported(character);
            setImportedPaths((prev) => new Set(prev).add(card.fullPath));
        } catch (err) {
            setError(
                `Import de « ${card.name} » échoué : ${err instanceof Error ? err.message : 'erreur inconnue'}`
            );
        } finally {
            setImportingPath(null);
        }
    };

    return (
        <div className="flex flex-col gap-3 min-h-0 flex-1">
            {/* Search / sort / NSFW row */}
            <div className="flex gap-2 items-center">
                <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Rechercher un personnage sur Chub…"
                    className="h-9"
                />
                <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm shrink-0"
                >
                    <option value="star_count">Populaires</option>
                    <option value="trending_downloads">Tendance</option>
                    <option value="created_at">Récents</option>
                    <option value="rating">Mieux notés</option>
                </select>
                <Button
                    variant={nsfw ? 'default' : 'secondary'}
                    size="sm"
                    onClick={() => setNsfw(!nsfw)}
                    className="h-9 shrink-0"
                    title="Inclure les cartes NSFW dans les résultats"
                >
                    NSFW
                </Button>
            </div>

            {error && <p className="text-xs text-destructive shrink-0">{error}</p>}

            {/* Results grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 overflow-y-auto min-h-0 flex-1 pr-1 content-start">
                {results.map((card) => (
                    <div
                        key={card.fullPath}
                        className="border border-border/50 rounded-xl overflow-hidden bg-card/50 flex flex-col"
                    >
                        <div className="aspect-[3/4] bg-muted relative overflow-hidden">
                            {!brokenAvatars.has(card.fullPath) ? (
                                // eslint-disable-next-line @next/next/no-img-element -- external CDN, next/image needs domain config
                                <img
                                    src={card.avatarUrl}
                                    alt={card.name}
                                    loading="lazy"
                                    className="w-full h-full object-cover"
                                    onError={() =>
                                        setBrokenAvatars((prev) =>
                                            new Set(prev).add(card.fullPath)
                                        )
                                    }
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center text-3xl font-bold text-muted-foreground/40">
                                    {card.name.charAt(0)}
                                </div>
                            )}
                        </div>
                        <div className="p-2 flex flex-col gap-1 flex-1">
                            <p className="text-sm font-medium truncate" title={card.fullPath}>
                                {card.name}
                            </p>
                            <p className="text-[11px] text-muted-foreground line-clamp-2 flex-1">
                                {card.tagline}
                            </p>
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                                <span className="flex items-center gap-0.5">
                                    <Star className="w-3 h-3" />
                                    {formatCount(card.stars)}
                                </span>
                                <span className="flex items-center gap-0.5">
                                    <MessageSquare className="w-3 h-3" />
                                    {formatCount(card.chats)}
                                </span>
                                <span>{formatCount(card.tokens)} tok</span>
                            </div>
                            <Button
                                size="sm"
                                className="h-8 mt-1 gap-1.5"
                                variant={importedPaths.has(card.fullPath) ? 'secondary' : 'default'}
                                disabled={
                                    importingPath === card.fullPath ||
                                    importedPaths.has(card.fullPath)
                                }
                                onClick={() => void importCard(card)}
                            >
                                {importedPaths.has(card.fullPath) ? (
                                    <>
                                        <Check className="w-3.5 h-3.5" /> Importé
                                    </>
                                ) : importingPath === card.fullPath ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <>
                                        <Download className="w-3.5 h-3.5" /> Importer
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>
                ))}
                {results.length === 0 && !isLoading && (
                    <p className="col-span-full text-center text-sm text-muted-foreground py-8">
                        Aucun résultat.
                    </p>
                )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-3 shrink-0">
                <p className="text-[10px] text-muted-foreground">
                    Catalogue Chub.ai / CharacterHub. JannyAI n&apos;expose pas de catalogue
                    (Cloudflare) — collez l&apos;URL d&apos;une carte dans l&apos;onglet Importer.
                </p>
                <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 gap-1.5"
                    disabled={isLoading}
                    onClick={() => void search(page + 1, true)}
                >
                    {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Charger plus
                </Button>
            </div>
        </div>
    );
}
