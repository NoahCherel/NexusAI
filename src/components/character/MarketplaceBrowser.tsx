'use client';

/**
 * Embedded Chub.ai catalogue browser (a tab of the CharacterImporter dialog), laid out
 * like Chub itself: rich LIST rows (cover, full blurb, tags, author, stats) and a full
 * DETAIL preview on click (description, personality, scenario, first message) so the user
 * knows exactly what they're importing. One-click import from both the row and the detail.
 *
 * Every network path has a browser-side fallback (real Chrome TLS fingerprint) because
 * Chub's WAF intermittently 403s the Next server — see src/lib/import/chub.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Loader2,
    Star,
    MessageSquare,
    Download,
    Check,
    ArrowLeft,
    BookOpen,
    Shuffle,
    Cpu,
    ExternalLink,
    X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CharacterCard } from '@/types';
import { htmlToPlainText } from '@/lib/html-text';
import {
    CHUB_SEARCH_URL,
    buildChubSearchParams,
    normalizeChubNodes,
    downloadChubCardInBrowser,
    fetchChubDetailInBrowser,
    type ChubNode,
    type MarketplaceCard,
    type ChubCardDetail,
} from '@/lib/import/chub';

function formatCount(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "2 ans" / "8 mois" / "12 j" — rough age from an ISO date. */
function formatAge(iso?: string): string {
    if (!iso) return '';
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days < 1) return "aujourd'hui";
    if (days < 60) return `${days} j`;
    if (days < 730) return `${Math.floor(days / 30)} mois`;
    return `${Math.floor(days / 365)} ans`;
}

/**
 * Readable preview text (display only): strip the HTML that Chub descriptions often are
 * (styled pages), decode entities (accents/apostrophes), resolve card placeholders.
 */
function humanize(text: string, charName: string): string {
    return htmlToPlainText(text)
        .replace(/\{\{char\}\}/gi, charName)
        .replace(/\{\{user\}\}/gi, 'Vous');
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                {label}
            </p>
            <div className="text-xs leading-relaxed whitespace-pre-wrap break-words">
                {children}
            </div>
        </div>
    );
}

export function MarketplaceBrowser({
    onImported,
}: {
    onImported: (character: CharacterCard) => void;
}) {
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('star_count');
    const [nsfw, setNsfw] = useState(false);
    // Tag filter (AND semantics on Chub's side). Row/detail tag chips add to it.
    const [tags, setTags] = useState<string[]>([]);
    const [tagInput, setTagInput] = useState('');
    const [results, setResults] = useState<MarketplaceCard[]>([]);
    const [page, setPage] = useState(1);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [importingPath, setImportingPath] = useState<string | null>(null);
    const [importedPaths, setImportedPaths] = useState<Set<string>>(new Set());
    const [brokenAvatars, setBrokenAvatars] = useState<Set<string>>(new Set());
    // Detail preview state
    const [selected, setSelected] = useState<MarketplaceCard | null>(null);
    const [detail, setDetail] = useState<ChubCardDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const detailCache = useRef(new Map<string, ChubCardDetail>());
    // Guards against out-of-order responses (fast typing + slow network).
    const searchSeq = useRef(0);

    const search = useCallback(
        async (targetPage: number, append: boolean) => {
            const seq = ++searchSeq.current;
            setIsLoading(true);
            setError(null);
            try {
                let cards: MarketplaceCard[] | null = null;

                // 1. Local server proxy (no CORS worries, richer headers).
                try {
                    const res = await fetch('/api/marketplace', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query, page: targetPage, nsfw, sort, topics: tags }),
                    });
                    const data = await res.json();
                    if (res.ok) {
                        cards = data.results as MarketplaceCard[];
                    } else if (data.kind !== 'blocked') {
                        throw new Error(data.error || `HTTP ${res.status}`);
                    }
                    // kind === 'blocked' → fall through to the browser fallback below.
                } catch (proxyErr) {
                    console.warn('[Marketplace] Server proxy failed:', proxyErr);
                }

                // 2. Browser fallback: this fetch carries a REAL Chrome TLS fingerprint,
                // which is what Chub's WAF actually checks; their API serves permissive
                // CORS (their own frontend calls it cross-origin).
                if (!cards) {
                    const params = buildChubSearchParams({
                        query,
                        page: targetPage,
                        nsfw,
                        sort,
                        topics: tags,
                    });
                    const res = await fetch(`${CHUB_SEARCH_URL}?${params}`, {
                        headers: { Accept: 'application/json' },
                    });
                    if (!res.ok) throw new Error(`Chub: HTTP ${res.status}`);
                    const json = (await res.json()) as { data?: { nodes?: ChubNode[] } };
                    cards = normalizeChubNodes(json.data?.nodes ?? []);
                }

                if (seq !== searchSeq.current) return; // stale response
                const finalCards = cards;
                setResults((prev) => (append ? [...prev, ...finalCards] : finalCards));
                setPage(targetPage);
            } catch (err) {
                if (seq === searchSeq.current) {
                    setError(err instanceof Error ? err.message : 'Recherche échouée');
                }
            } finally {
                if (seq === searchSeq.current) setIsLoading(false);
            }
        },
        [query, nsfw, sort, tags]
    );

    const addTag = (t: string) => {
        const clean = t.trim();
        if (clean && !tags.some((x) => x.toLowerCase() === clean.toLowerCase())) {
            setTags((prev) => [...prev, clean]);
        }
        setTagInput('');
    };
    const removeTag = (t: string) => setTags((prev) => prev.filter((x) => x !== t));

    // Initial load + debounced re-search when query/sort/nsfw change.
    useEffect(() => {
        const t = setTimeout(() => void search(1, false), 350);
        return () => clearTimeout(t);
    }, [search]);

    const openDetail = async (card: MarketplaceCard) => {
        setSelected(card);
        const cached = detailCache.current.get(card.fullPath);
        if (cached) {
            setDetail(cached);
            return;
        }
        setDetail(null);
        setDetailLoading(true);
        try {
            let d: ChubCardDetail | null = null;
            // 1. Server proxy.
            try {
                const res = await fetch('/api/marketplace', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ detail: card.fullPath }),
                });
                const data = await res.json();
                if (res.ok) d = data.detail as ChubCardDetail;
            } catch {
                /* fall through */
            }
            // 2. Browser fallback (WAF).
            if (!d) d = await fetchChubDetailInBrowser(card.fullPath);
            if (d) detailCache.current.set(card.fullPath, d);
            setDetail(d);
        } finally {
            setDetailLoading(false);
        }
    };

    const importCard = async (card: MarketplaceCard) => {
        setImportingPath(card.fullPath);
        setError(null);
        try {
            let imported: { card: CharacterCard; avatarDataUrl?: string } | null = null;

            // 1. Server proxy.
            try {
                const res = await fetch('/api/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: `https://chub.ai/characters/${card.fullPath}`,
                    }),
                });
                const data = await res.json();
                if (res.ok) imported = data;
            } catch {
                /* fall through to the browser fallback */
            }

            // 2. Browser fallback (real Chrome fingerprint beats the WAF).
            if (!imported) imported = await downloadChubCardInBrowser(card.fullPath);
            if (!imported) throw new Error('Chub inaccessible (serveur et navigateur).');

            const character: CharacterCard = {
                ...imported.card,
                id: crypto.randomUUID(),
                avatar: imported.avatarDataUrl || imported.card.avatar || '',
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

    const importButton = (card: MarketplaceCard, size: 'sm' | 'default' = 'sm') => (
        <Button
            size={size}
            className={size === 'sm' ? 'h-8 gap-1.5 shrink-0' : 'h-9 gap-1.5 shrink-0'}
            variant={importedPaths.has(card.fullPath) ? 'secondary' : 'default'}
            disabled={importingPath === card.fullPath || importedPaths.has(card.fullPath)}
            onClick={(e) => {
                e.stopPropagation();
                void importCard(card);
            }}
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
    );

    const avatar = (card: MarketplaceCard, className: string) =>
        !brokenAvatars.has(card.fullPath) ? (
            // eslint-disable-next-line @next/next/no-img-element -- external CDN, next/image needs domain config
            <img
                src={card.avatarUrl}
                alt={card.name}
                loading="lazy"
                className={`${className} object-cover rounded-lg bg-muted shrink-0`}
                onError={() =>
                    setBrokenAvatars((prev) => new Set(prev).add(card.fullPath))
                }
            />
        ) : (
            <div
                className={`${className} rounded-lg bg-muted shrink-0 flex items-center justify-center text-2xl font-bold text-muted-foreground/40`}
            >
                {card.name.charAt(0)}
            </div>
        );

    const statChips = (c: { stars: number; chats: number; tokens: number }) => (
        <span className="flex items-center gap-2.5 text-[10px] text-muted-foreground font-mono shrink-0">
            <span className="flex items-center gap-0.5" title="Favoris">
                <Star className="w-3 h-3" />
                {formatCount(c.stars)}
            </span>
            <span className="flex items-center gap-0.5" title="Chats publics">
                <MessageSquare className="w-3 h-3" />
                {formatCount(c.chats)}
            </span>
            <span className="flex items-center gap-0.5" title="Taille de la carte (tokens)">
                <Cpu className="w-3 h-3" />
                {formatCount(c.tokens)}
            </span>
        </span>
    );

    const detailView = selected && (
        <div className="absolute inset-0 z-10 bg-background flex flex-col rounded-lg border border-border/60 overflow-hidden">
            {/* Detail header */}
            <div className="flex items-center gap-2 p-2 border-b border-border/50 shrink-0">
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 shrink-0"
                    onClick={() => setSelected(null)}
                >
                    <ArrowLeft className="w-4 h-4" />
                    Retour
                </Button>
                <span className="font-semibold text-sm truncate flex-1">{selected.name}</span>
                <a
                    href={`https://chub.ai/characters/${selected.fullPath}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 shrink-0 max-sm:hidden"
                >
                    <ExternalLink className="w-3 h-3" />
                    Voir sur Chub
                </a>
                {importButton(selected, 'default')}
            </div>

            {/* Detail body */}
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
                <div className="flex gap-3">
                    {avatar(selected, 'w-24 h-32 sm:w-32 sm:h-44')}
                    <div className="min-w-0 flex-1 space-y-2">
                        <p className="text-xs text-muted-foreground">
                            @{selected.author}
                            {selected.createdAt ? ` · ${formatAge(selected.createdAt)}` : ''}
                        </p>
                        {statChips(detail ?? selected)}
                        {detail && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                                {detail.hasLorebook && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-400/10 text-orange-400 text-[10px]">
                                        <BookOpen className="w-3 h-3" /> Lorebook embarqué
                                    </span>
                                )}
                                {detail.altGreetingCount > 0 && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px]">
                                        <Shuffle className="w-3 h-3" /> {detail.altGreetingCount}{' '}
                                        intro{detail.altGreetingCount > 1 ? 's' : ''} alternative
                                        {detail.altGreetingCount > 1 ? 's' : ''}
                                    </span>
                                )}
                            </div>
                        )}
                        <div className="flex items-center gap-1 flex-wrap">
                            {(detail?.topics ?? selected.topics).map((t) => (
                                <button
                                    key={t}
                                    onClick={() => {
                                        addTag(t);
                                        setSelected(null);
                                    }}
                                    className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground hover:text-primary hover:bg-primary/10"
                                    title={`Filtrer par ${t}`}
                                >
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {detailLoading && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Chargement de la fiche…
                    </div>
                )}

                {!detailLoading && !detail && (
                    <p className="text-xs text-muted-foreground py-2">
                        Fiche complète indisponible (Chub bloque) — l&apos;import reste possible.
                    </p>
                )}

                {(detail?.tagline || selected.tagline) && (
                    <Section label="Accroche">
                        {humanize(detail?.tagline || selected.tagline, selected.name)}
                    </Section>
                )}
                {(detail?.description || selected.description) && (
                    <Section label="Description">
                        {humanize(detail?.description || selected.description, selected.name)}
                    </Section>
                )}
                {detail?.personality && (
                    <Section label="Personnalité">
                        {humanize(detail.personality, selected.name)}
                    </Section>
                )}
                {detail?.scenario && (
                    <Section label="Scénario">{humanize(detail.scenario, selected.name)}</Section>
                )}
                {detail?.firstMessage && (
                    <Section label="Premier message — aperçu du style d'écriture">
                        <div className="border border-border/50 rounded-lg p-2.5 bg-card/40 max-h-64 overflow-y-auto">
                            {humanize(detail.firstMessage, selected.name)}
                        </div>
                    </Section>
                )}
            </div>
        </div>
    );

    return (
        // min-w-0: direct child of a CSS-grid DialogContent — without it the grid track
        // sizes to our min-content and the row overflows the dialog instead of wrapping.
        <div className="flex flex-col gap-3 min-h-0 min-w-0 flex-1">
            {/* Search / sort / NSFW — wraps on mobile (input takes its own full row) */}
            <div className="flex flex-wrap gap-2 items-center shrink-0">
                <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Rechercher un personnage sur Chub…"
                    className="h-9 flex-1 max-sm:basis-full"
                />
                <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm min-w-0 max-sm:flex-1"
                >
                    <option value="star_count">Favoris ★</option>
                    <option value="download_count">Téléchargements</option>
                    <option value="trending_downloads">Tendance</option>
                    <option value="created_at">Récents</option>
                    <option value="last_activity_at">Activité récente</option>
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

            {/* Tag filter: active chips (removable), free input, quick presets. Clicking a
                tag on any card also adds it here. */}
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {tags.map((t) => (
                    <span
                        key={t}
                        className="inline-flex items-center gap-1 px-2 h-6 rounded-full bg-primary/15 text-primary text-[11px] font-medium"
                    >
                        {t}
                        <button onClick={() => removeTag(t)} title={`Retirer le filtre ${t}`}>
                            <X className="w-3 h-3 hover:text-destructive" />
                        </button>
                    </span>
                ))}
                <Input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') addTag(tagInput);
                        if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                            removeTag(tags[tags.length - 1]);
                        }
                    }}
                    placeholder="+ filtrer par tag…"
                    className="h-6 w-32 text-[11px] px-2"
                />
                {tags.length === 0 &&
                    ['RPG', 'Anime', 'Fantasy', 'Game', 'Female', 'Male'].map((t) => (
                        <button
                            key={t}
                            onClick={() => addTag(t)}
                            className="px-2 h-6 rounded-full border border-border/50 text-[11px] text-muted-foreground hover:text-primary hover:border-primary/40"
                        >
                            {t}
                        </button>
                    ))}
            </div>

            {error && <p className="text-xs text-destructive shrink-0">{error}</p>}

            {/* Results list + detail overlay */}
            <div className="flex-1 min-h-0 relative">
                <div className="h-full overflow-y-auto pr-1 space-y-2">
                    {results.map((card) => (
                        <div
                            key={card.fullPath}
                            role="button"
                            tabIndex={0}
                            onClick={() => void openDetail(card)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') void openDetail(card);
                            }}
                            className="flex gap-3 p-2.5 border border-border/50 rounded-xl bg-card/40 hover:bg-card/80 hover:border-primary/30 transition-colors cursor-pointer"
                        >
                            {avatar(card, 'w-16 h-20 sm:w-20 sm:h-24')}
                            <div className="flex-1 min-w-0 flex flex-col gap-1">
                                <div className="flex items-baseline gap-2 min-w-0">
                                    <span className="text-sm font-semibold truncate shrink-0 max-w-[60%]">
                                        {card.name}
                                    </span>
                                    {/* truncate needs the element to SHRINK — shrink-0 let a
                                        long @author push the row under the stats column */}
                                    <span className="text-[10px] text-muted-foreground truncate min-w-0">
                                        @{card.author}
                                        {card.createdAt ? ` · ${formatAge(card.createdAt)}` : ''}
                                    </span>
                                </div>
                                <p className="text-[11px] text-muted-foreground line-clamp-2 sm:line-clamp-3">
                                    {humanize(
                                        card.tagline || card.description || '(pas de description)',
                                        card.name
                                    )}
                                </p>
                                <div className="flex items-center gap-1 flex-wrap mt-auto">
                                    {card.topics.slice(0, 5).map((t) => (
                                        <button
                                            key={t}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                addTag(t);
                                            }}
                                            className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground hover:text-primary hover:bg-primary/10"
                                            title={`Filtrer par ${t}`}
                                        >
                                            {t}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="flex flex-col items-end justify-between gap-1.5 shrink-0">
                                {statChips(card)}
                                {importButton(card)}
                            </div>
                        </div>
                    ))}
                    {results.length === 0 && !isLoading && (
                        <p className="text-center text-sm text-muted-foreground py-8">
                            Aucun résultat.
                        </p>
                    )}
                    {results.length > 0 && (
                        <div className="pt-1 pb-2 flex justify-center">
                            <Button
                                variant="secondary"
                                size="sm"
                                className="gap-1.5"
                                disabled={isLoading}
                                onClick={() => void search(page + 1, true)}
                            >
                                {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                Charger plus
                            </Button>
                        </div>
                    )}
                </div>

                {detailView}
            </div>

            {/* Footer — hint hidden on mobile (it lives in the Import tab too) */}
            <p className="text-[10px] text-muted-foreground shrink-0 max-sm:hidden">
                Catalogue Chub.ai / CharacterHub — cliquez une carte pour la fiche complète.
                JannyAI n&apos;expose pas de catalogue (Cloudflare) : collez l&apos;URL dans
                l&apos;onglet Importer.
            </p>
        </div>
    );
}
