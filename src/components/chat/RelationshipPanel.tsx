'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Trash2, ChevronDown, History, Heart, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chat-store';
import { useCharacterStore } from '@/stores/character-store';
import { useSettingsStore } from '@/stores/settings-store';
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
} from '@/types/chat';

const AXIS_FR: Record<RelationshipAxis, string> = {
    trust: 'Confiance',
    affection: 'Affection',
    respect: 'Respect',
    attraction: 'Attirance',
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
    const [newTo, setNewTo] = useState(USER_REL_KEY);
    const [search, setSearch] = useState('');

    const names = useMemo(() => {
        const set = new Set<string>(character?.canonCast || []);
        for (const r of rels) {
            if (r.from !== USER_REL_KEY) set.add(r.from);
            if (r.to !== USER_REL_KEY) set.add(r.to);
        }
        return [...set].sort();
    }, [character?.canonCast, rels]);

    const display = (n: string) => (n === USER_REL_KEY ? userName : n);

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
            rels.map((r) => (relKey(r.from, r.to) === key ? { ...r, note } : r))
        );
    };

    const remove = (key: string) => persist(rels.filter((r) => relKey(r.from, r.to) !== key));

    const add = () => {
        const from = newFrom.trim();
        const to = newTo.trim();
        if (!from || !to || from.toLowerCase() === to.toLowerCase()) return;
        if (rels.some((r) => relKey(r.from, r.to) === relKey(from, to))) return;
        persist([...rels, makeRelationship(from, to)]);
        setAdding(false);
        setNewFrom('');
        setNewTo(USER_REL_KEY);
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
                Relations dirigées (A → B ≠ B → A). Mises à jour automatiquement par les beats, et
                éditables ici.
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
                    onClick={() => setAdding((v) => !v)}
                    size="sm"
                    variant="outline"
                    className="gap-1.5 shrink-0 h-9"
                >
                    <Plus className="w-3.5 h-3.5" /> Ajouter
                </Button>
            </div>

            {adding && (
                <div className="flex items-center gap-2 p-2 rounded-lg border bg-muted/30">
                    <select
                        value={newFrom}
                        onChange={(e) => setNewFrom(e.target.value)}
                        className="h-8 text-xs bg-background border rounded px-2 flex-1"
                    >
                        <option value="">De… (qui ressent)</option>
                        {names.map((n) => (
                            <option key={n} value={n}>
                                {n}
                            </option>
                        ))}
                    </select>
                    <span className="text-muted-foreground">→</span>
                    <select
                        value={newTo}
                        onChange={(e) => setNewTo(e.target.value)}
                        className="h-8 text-xs bg-background border rounded px-2 flex-1"
                    >
                        <option value={USER_REL_KEY}>{userName} (joueur)</option>
                        {names.map((n) => (
                            <option key={n} value={n}>
                                {n}
                            </option>
                        ))}
                    </select>
                    <Button onClick={add} size="sm" className="h-8">
                        OK
                    </Button>
                </div>
            )}

            {sorted.length === 0 ? (
                <div className="text-center py-10 px-4 text-xs text-muted-foreground border border-dashed rounded-lg">
                    <Heart className="w-8 h-8 mx-auto opacity-20 mb-2" />
                    {q
                        ? 'Aucune relation ne correspond à la recherche.'
                        : 'Aucune relation suivie. Elles apparaissent quand un perso du casting entre en scène, ou ajoute-en une à la main.'}
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
                            onRemove={() => remove(relKey(r.from, r.to))}
                        />
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
                        <span className="ml-2 text-[10px] text-muted-foreground">(toi — manuel)</span>
                    )}
                    {rel.seededFromCanon && (
                        <span className="ml-2 text-[10px] text-amber-500/80">canon</span>
                    )}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={() => setShowLedger((v) => !v)}
                        className="p-1 text-muted-foreground hover:text-foreground"
                        title="Historique"
                    >
                        <History className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={onRemove}
                        className="p-1 text-muted-foreground hover:text-destructive"
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
                                {axisLabel(axis, v)}
                            </span>
                            <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                    onClick={() => onSetAxis(axis, v - 5)}
                                    className="w-6 h-6 flex items-center justify-center bg-muted/40 hover:bg-muted rounded text-sm"
                                >
                                    −
                                </button>
                                <Input
                                    type="number"
                                    value={v}
                                    onChange={(e) => onSetAxis(axis, parseInt(e.target.value) || 0)}
                                    className="w-12 h-6 text-center text-[11px] px-1"
                                    min={-100}
                                    max={100}
                                />
                                <button
                                    onClick={() => onSetAxis(axis, v + 5)}
                                    className="w-6 h-6 flex items-center justify-center bg-muted/40 hover:bg-muted rounded text-sm"
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
                        <p className="text-[11px] text-muted-foreground/70">Aucun changement enregistré.</p>
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
                                <span className="text-muted-foreground shrink-0">{AXIS_FR[e.axis]}</span>
                                <span className="text-foreground/80">{e.reason}</span>
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
