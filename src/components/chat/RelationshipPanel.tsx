'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Plus, Trash2, ChevronDown, History, Heart, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chat-store';
import { useCharacterStore } from '@/stores/character-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useKnownCastNames } from '@/hooks/useKnownCastNames';
import { getCanonDossiersByWork } from '@/lib/db';
import { resolveWork } from '@/lib/ai/canon-context';
import { seedAxesFromNature } from '@/lib/ai/relationship-context';
import {
    RELATIONSHIP_AXES,
    axisLabel,
    makeRelationship,
    relKey,
    clampAxis,
} from '@/lib/ai/relationship-engine';
import {
    USER_REL_KEY,
    type DirectedRelationship,
    type RelationshipAxis,
    type RelationshipAxes,
} from '@/types/chat';
import type { CanonDossier } from '@/types/canon';

const AXIS_FR: Record<RelationshipAxis, string> = {
    trust: 'Confiance',
    affection: 'Affection',
    respect: 'Respect',
    attraction: 'Attirance',
};

/**
 * French rendering of `axisLabel`. The engine function is NOT translated: it also feeds the
 * prompt block, and localising it would corrupt the model's input. This table only covers the
 * display side.
 */
const AXIS_LABEL_FR: Record<string, string> = {
    // trust
    'betrayed/hostile': 'trahi / hostile',
    distrustful: 'méfiant',
    wary: 'sur ses gardes',
    'cautiously trusting': 'confiance prudente',
    trusting: 'confiant',
    'fully relies on them': 'confiance totale',
    // affection
    hateful: 'haineux',
    dislikes: 'antipathie',
    indifferent: 'indifférent',
    friendly: 'amical',
    fond: 'attaché',
    devoted: 'dévoué',
    // respect
    contemptuous: 'méprisant',
    dismissive: 'dédaigneux',
    unproven: 'à faire ses preuves',
    respects: 'respecte',
    admires: 'admire',
    reveres: 'vénère',
    // attraction
    repulsed: 'repoussé',
    'put off': 'rebuté',
    neutral: 'neutre',
    intrigued: 'intrigué',
    'drawn to them': 'attiré',
    infatuated: 'épris',
};

const frAxisLabel = (axis: RelationshipAxis, v: number): string => {
    const en = axisLabel(axis, v);
    return AXIS_LABEL_FR[en] ?? en;
};

export function RelationshipPanel() {
    const { conversations, activeConversationId, setRelationships } = useChatStore();
    const { getActiveCharacter } = useCharacterStore();
    const { personas, activePersonaId } = useSettingsStore();
    const conversation = conversations.find((c) => c.id === activeConversationId);
    const character = getActiveCharacter();
    const userName = personas.find((p) => p.id === activePersonaId)?.name || 'You';

    const rels = useMemo(() => conversation?.relationships || [], [conversation?.relationships]);
    const [adding, setAdding] = useState(false);
    const [newFrom, setNewFrom] = useState('');
    const [newTo, setNewTo] = useState('');
    const [reciprocal, setReciprocal] = useState(false);
    const [addError, setAddError] = useState('');
    const [search, setSearch] = useState('');
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);

    // Suggestions only — free text is always accepted. An OC card has no canonCast and no
    // dossiers, so a closed list would make manual creation impossible.
    const castPool = useKnownCastNames(character, conversation);

    // Canon natures, so a hand-added bond the source material already describes starts at
    // sensible values instead of flat neutral. Tagged with its work so a card switch discards
    // the stale list without a reset setState in the effect body.
    const work = character ? resolveWork(character) : '';
    const [loaded, setLoaded] = useState<{ work: string; list: CanonDossier[] }>({
        work: '',
        list: [],
    });
    useEffect(() => {
        if (!work) return;
        let cancelled = false;
        getCanonDossiersByWork(work)
            .then((d) => {
                if (!cancelled) setLoaded({ work, list: d });
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [work]);
    const dossiers = loaded.work === work ? loaded.list : [];

    const display = (n: string) => (n === USER_REL_KEY ? userName : n);

    /** Resolve what the user typed: their persona name means the player sentinel. */
    const toKey = (raw: string) => {
        const v = raw.trim();
        if (!v) return '';
        return v.toLowerCase() === userName.toLowerCase() ? USER_REL_KEY : v;
    };

    /** Canon-seeded starting axes for `from → to`, when the dossier describes that bond. */
    const canonAxesFor = (
        from: string,
        to: string
    ): { axes: Partial<RelationshipAxes>; fromCanon: boolean } => {
        if (from === USER_REL_KEY || to === USER_REL_KEY) return { axes: {}, fromCanon: false };
        const dossier = dossiers.find((d) => d.character.toLowerCase() === from.toLowerCase());
        const canonRel = dossier?.relationships?.find(
            (r) => r.name.toLowerCase() === to.toLowerCase()
        );
        return canonRel
            ? { axes: seedAxesFromNature(canonRel.nature), fromCanon: true }
            : { axes: {}, fromCanon: false };
    };

    const persist = (next: DirectedRelationship[]) => {
        if (activeConversationId) setRelationships(activeConversationId, next);
    };

    const setAxis = (key: string, axis: RelationshipAxis, value: number) => {
        persist(
            rels.map((r) =>
                relKey(r.from, r.to) === key
                    ? { ...r, axes: { ...r.axes, [axis]: clampAxis(value) }, updatedAt: Date.now() }
                    : r
            )
        );
    };

    const setNote = (key: string, note: string) => {
        persist(
            rels.map((r) =>
                relKey(r.from, r.to) === key ? { ...r, note, updatedAt: Date.now() } : r
            )
        );
    };

    const remove = (key: string) => persist(rels.filter((r) => relKey(r.from, r.to) !== key));

    const add = () => {
        const from = toKey(newFrom);
        const to = toKey(newTo);
        if (!from || !to) {
            setAddError('Renseigne les deux personnages.');
            return;
        }
        if (from.toLowerCase() === to.toLowerCase()) {
            setAddError('Un personnage ne peut pas être en relation avec lui-même.');
            return;
        }
        if (from === USER_REL_KEY && to === USER_REL_KEY) {
            setAddError('Un personnage ne peut pas être en relation avec lui-même.');
            return;
        }

        const next = [...rels];
        const addOne = (a: string, b: string): boolean => {
            if (next.some((r) => relKey(r.from, r.to) === relKey(a, b))) return false;
            const { axes, fromCanon } = canonAxesFor(a, b);
            next.push(makeRelationship(a, b, axes, fromCanon));
            return true;
        };

        const added = addOne(from, to);
        const addedBack = reciprocal ? addOne(to, from) : false;
        if (!added && !addedBack) {
            setAddError('Cette relation existe déjà.');
            return;
        }

        persist(next);
        setAdding(false);
        setAddError('');
        setNewFrom('');
        setNewTo('');
        setReciprocal(false);
    };

    // Search: match either endpoint's (display) name or the note text.
    const q = search.trim().toLowerCase();
    const filtered = q
        ? rels.filter((r) => {
              const hay = `${display(r.from)} ${display(r.to)} ${r.note || ''}`.toLowerCase();
              return hay.includes(q);
          })
        : rels;

    // Sort: NPC→player first (most relevant), then NPC→NPC, then player→NPC.
    const sorted = [...filtered].sort((a, b) => {
        const rank = (r: DirectedRelationship) =>
            r.to === USER_REL_KEY && r.from !== USER_REL_KEY ? 0 : r.from === USER_REL_KEY ? 2 : 1;
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`);
    });

    return (
        <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
                Relations dirigées (A → B ≠ B → A). Tu les crées ici : l&apos;IA ne fait que les
                faire évoluer au fil des beats, elle n&apos;en invente jamais.
            </p>

            <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                        placeholder="Rechercher (nom, note)…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="pl-8 h-9 text-xs"
                    />
                    {search && (
                        <button
                            onClick={() => setSearch('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
                <Button
                    onClick={() => {
                        setAdding((v) => !v);
                        setAddError('');
                    }}
                    size="sm"
                    variant="outline"
                    className="gap-1.5 shrink-0 h-9"
                >
                    <Plus className="w-3.5 h-3.5" /> Ajouter
                </Button>
            </div>

            {adding && (
                <div className="p-2 rounded-lg border bg-muted/30 space-y-2">
                    <div className="flex items-center gap-2">
                        <NameField
                            value={newFrom}
                            onChange={(v) => {
                                setNewFrom(v);
                                setAddError('');
                            }}
                            onSubmit={add}
                            pool={castPool}
                            userName={userName}
                            placeholder="De… (qui ressent)"
                            autoFocus
                        />
                        <span className="text-muted-foreground shrink-0">→</span>
                        <NameField
                            value={newTo}
                            onChange={(v) => {
                                setNewTo(v);
                                setAddError('');
                            }}
                            onSubmit={add}
                            pool={castPool}
                            userName={userName}
                            placeholder="Vers…"
                        />
                        <Button onClick={add} size="sm" className="h-8 shrink-0">
                            OK
                        </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                            <input
                                type="checkbox"
                                checked={reciprocal}
                                onChange={(e) => setReciprocal(e.target.checked)}
                                className="accent-primary"
                            />
                            Créer aussi la réciproque (B → A)
                        </label>
                        <button
                            type="button"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                setNewTo(userName);
                                setAddError('');
                            }}
                            className="text-[11px] text-muted-foreground hover:text-primary underline underline-offset-2"
                        >
                            Vers {userName} (joueur)
                        </button>
                    </div>
                    {addError && <p className="text-[11px] text-destructive">{addError}</p>}
                </div>
            )}

            {sorted.length === 0 ? (
                <div className="text-center py-10 px-4 text-xs text-muted-foreground border border-dashed rounded-lg">
                    <Heart className="w-8 h-8 mx-auto opacity-20 mb-2" />
                    {q
                        ? 'Aucune relation ne correspond à la recherche.'
                        : 'Aucune relation suivie. Ajoute celles qui comptent avec « Ajouter » — seules celles-ci seront envoyées au modèle.'}
                </div>
            ) : (
                <div className="space-y-2">
                    {sorted.map((r) => (
                        <RelationshipCard
                            key={relKey(r.from, r.to)}
                            rel={r}
                            fromLabel={display(r.from)}
                            toLabel={display(r.to)}
                            isUserOrigin={r.from === USER_REL_KEY}
                            onSetAxis={(axis, v) => setAxis(relKey(r.from, r.to), axis, v)}
                            onSetNote={(note) => setNote(relKey(r.from, r.to), note)}
                            onRemove={() => setPendingDelete(relKey(r.from, r.to))}
                        />
                    ))}
                </div>
            )}

            <ConfirmDialog
                open={!!pendingDelete}
                onOpenChange={(open) => !open && setPendingDelete(null)}
                title="Supprimer cette relation ?"
                description="Les axes, la note et tout l'historique seront perdus. Les relations sont créées à la main : il faudra la recréer."
                confirmLabel="Supprimer"
                destructive
                onConfirm={() => {
                    if (pendingDelete) remove(pendingDelete);
                    setPendingDelete(null);
                }}
            />
        </div>
    );
}

/**
 * Free-text character name with typo-proof suggestions. Mirrors the roster-add field in
 * SceneBar: Enter takes the top suggestion when one matches, else the raw text.
 */
function NameField({
    value,
    onChange,
    onSubmit,
    pool,
    userName,
    placeholder,
    autoFocus,
}: {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    pool: string[];
    userName: string;
    placeholder: string;
    autoFocus?: boolean;
}) {
    const [open, setOpen] = useState(false);

    const suggestions = useMemo(() => {
        const q = value.trim().toLowerCase();
        // The player is a valid endpoint too, offered under the persona's own name.
        const all = [userName, ...pool.filter((n) => n.toLowerCase() !== userName.toLowerCase())];
        return (q ? all.filter((n) => n.toLowerCase().includes(q)) : all).slice(0, 6);
    }, [value, pool, userName]);

    return (
        <div className="relative flex-1 min-w-0">
            <Input
                autoFocus={autoFocus}
                value={value}
                onChange={(e) => {
                    onChange(e.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        // Enter picks the top suggestion (typo-proof) when one matches,
                        // else keeps the raw text.
                        if (suggestions[0] && value.trim()) onChange(suggestions[0]);
                        setOpen(false);
                        onSubmit();
                    }
                    if (e.key === 'Escape') setOpen(false);
                }}
                // Delay so a suggestion mousedown can win over blur.
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                placeholder={placeholder}
                className="h-8 pointer-coarse:h-9 text-xs"
            />
            {open && suggestions.length > 0 && (
                <div className="absolute top-full left-0 mt-1 z-50 min-w-full rounded-lg border border-border/60 bg-popover shadow-xl overflow-hidden">
                    {suggestions.map((name) => (
                        <button
                            key={name}
                            // mousedown (not click) so it fires before the input's blur.
                            onMouseDown={(e) => {
                                e.preventDefault();
                                onChange(name);
                                setOpen(false);
                            }}
                            className="block w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-primary/10 hover:text-primary truncate"
                        >
                            {name}
                            {name === userName && (
                                <span className="ml-1.5 text-muted-foreground">(joueur)</span>
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function axisColor(v: number): string {
    if (v >= 60) return 'bg-emerald-500';
    if (v >= 20) return 'bg-green-500';
    if (v > -20) return 'bg-gray-500';
    if (v > -60) return 'bg-orange-500';
    return 'bg-red-600';
}

function RelationshipCard({
    rel,
    fromLabel,
    toLabel,
    isUserOrigin,
    onSetAxis,
    onSetNote,
    onRemove,
}: {
    rel: DirectedRelationship;
    fromLabel: string;
    toLabel: string;
    isUserOrigin: boolean;
    onSetAxis: (axis: RelationshipAxis, v: number) => void;
    onSetNote: (note: string) => void;
    onRemove: () => void;
}) {
    const [showLedger, setShowLedger] = useState(false);

    return (
        <div className="rounded-lg border border-border/40 bg-muted/20 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold truncate">
                    {fromLabel} <span className="text-muted-foreground">→</span> {toLabel}
                    {isUserOrigin && (
                        <span className="ml-2 text-[10px] text-muted-foreground">
                            (toi — manuel)
                        </span>
                    )}
                    {rel.seededFromCanon && (
                        <span className="ml-2 text-[10px] text-amber-500/80">canon</span>
                    )}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={() => setShowLedger((v) => !v)}
                        className="p-1 pointer-coarse:p-2.5 text-muted-foreground hover:text-foreground"
                        title="Historique"
                    >
                        <History className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={onRemove}
                        className="p-1 pointer-coarse:p-2.5 text-muted-foreground hover:text-destructive"
                        title="Supprimer"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {RELATIONSHIP_AXES.map((axis) => {
                const v = rel.axes[axis];
                const percent = (v + 100) / 2; // 0..100
                return (
                    <div key={axis} className="space-y-1">
                        <div className="flex items-center gap-2 text-[11px]">
                            <span className="font-medium shrink-0">{AXIS_FR[axis]}</span>
                            <span className="text-muted-foreground truncate min-w-0 flex-1">
                                {frAxisLabel(axis, v)}
                            </span>
                            <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                    onClick={() => onSetAxis(axis, v - 5)}
                                    className="w-6 h-6 pointer-coarse:w-9 pointer-coarse:h-9 flex items-center justify-center bg-muted/40 hover:bg-muted rounded text-sm"
                                >
                                    −
                                </button>
                                <Input
                                    type="number"
                                    value={v}
                                    onChange={(e) => onSetAxis(axis, parseInt(e.target.value) || 0)}
                                    className="w-12 h-6 pointer-coarse:h-9 text-center text-[11px] px-1"
                                    min={-100}
                                    max={100}
                                />
                                <button
                                    onClick={() => onSetAxis(axis, v + 5)}
                                    className="w-6 h-6 pointer-coarse:w-9 pointer-coarse:h-9 flex items-center justify-center bg-muted/40 hover:bg-muted rounded text-sm"
                                >
                                    +
                                </button>
                            </div>
                        </div>
                        <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden relative">
                            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-foreground/10 z-10" />
                            <div
                                className={cn('h-full rounded-full transition-all', axisColor(v))}
                                style={{ width: `${percent}%` }}
                            />
                        </div>
                    </div>
                );
            })}

            <Textarea
                value={rel.note || ''}
                onChange={(e) => onSetNote(e.target.value)}
                placeholder="Ce que ce perso sait/pense de l'autre (optionnel)…"
                className="min-h-[36px] text-xs"
            />

            {showLedger && (
                <div className="border-t pt-2 space-y-1">
                    <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                        <ChevronDown className="w-3 h-3" /> Historique
                    </div>
                    {rel.ledger.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground/70">
                            Aucun changement enregistré.
                        </p>
                    ) : (
                        [...rel.ledger].reverse().map((e, i) => (
                            <div key={i} className="text-[11px] flex items-start gap-1.5">
                                <span
                                    className={cn(
                                        'font-mono font-semibold shrink-0',
                                        e.delta > 0 ? 'text-green-500' : 'text-red-400'
                                    )}
                                >
                                    {e.delta > 0 ? '+' : ''}
                                    {e.delta}
                                </span>
                                <span className="text-muted-foreground shrink-0">
                                    {AXIS_FR[e.axis]}
                                </span>
                                <span className="text-foreground/80">{e.reason}</span>
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
