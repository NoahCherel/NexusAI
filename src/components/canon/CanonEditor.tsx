'use client';

import { useState, useEffect, useCallback } from 'react';
import { useCharacterStore } from '@/stores/character-store';
import { useChatStore } from '@/stores/chat-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
    BookOpen,
    Compass,
    Users,
    Clapperboard,
    Plus,
    Trash2,
    Save,
    X,
    Search,
    ChevronLeft,
    Loader2,
    Globe,
    RefreshCw,
    Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
    getCanonDossiersByWork,
    getArcOutline,
    saveCanonDossier,
    deleteCanonDossier,
} from '@/lib/db';
import {
    fetchCharacterDossier,
    fetchArcOutline,
} from '@/lib/ai/canon-retrieval';
import {
    populateCanonRoster,
    createCanonCharacter,
    proposeScenes,
} from '@/lib/ai/director';
import { resolveWork } from '@/lib/ai/canon-context';
import type { CanonDossier } from '@/types/canon';
import type { ArcCompass } from '@/types/chat';

type ViewMode = 'arc' | 'cast' | 'director';

export function CanonEditor({ onClose }: { onClose: () => void }) {
    const { getActiveCharacter, updateCharacter } = useCharacterStore();
    const { conversations, activeConversationId, updateArc, setRpJournalForCharacter } =
        useChatStore();
    const character = getActiveCharacter();
    const conversation = conversations.find((c) => c.id === activeConversationId);

    const [view, setView] = useState<ViewMode>('arc');
    const [dossiers, setDossiers] = useState<CanonDossier[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [isMobile, setIsMobile] = useState(false);
    const [arcOutlineText, setArcOutlineText] = useState('');

    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth < 1024);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, []);

    const work = (conversation?.arc?.work?.trim() || (character ? resolveWork(character) : '')) || '';
    const cap = conversation?.arc?.currentPosition?.trim() || 'Start';

    const reload = useCallback(async () => {
        if (!work) {
            setDossiers([]);
            setArcOutlineText('');
            return;
        }
        try {
            const [list, outline] = await Promise.all([
                getCanonDossiersByWork(work),
                getArcOutline(work),
            ]);
            list.sort((a, b) => {
                if (!!a.stub !== !!b.stub) return a.stub ? 1 : -1;
                if (!!a.enabled === false && b.enabled !== false) return 1;
                if (a.enabled !== false && b.enabled === false) return -1;
                return a.character.localeCompare(b.character);
            });
            setDossiers(list);
            setArcOutlineText(outline?.outline || '');
        } catch (e) {
            console.error('[Canon] reload failed', e);
        }
    }, [work]);

    useEffect(() => {
        reload();
    }, [reload]);

    const current = dossiers.find((d) => d.character === selected) || null;
    const filtered = dossiers.filter(
        (d) =>
            !search.trim() ||
            d.character.toLowerCase().includes(search.toLowerCase()) ||
            (d.appearsInArcs || []).some((a) => a.toLowerCase().includes(search.toLowerCase()))
    );

    const showEditorOnMobile = isMobile && (view !== 'cast' || selected !== null);

    if (!character) {
        return (
            <div className="flex items-center justify-center h-full p-6">
                <p className="text-sm text-muted-foreground">
                    Sélectionne une carte de personnage d&apos;abord.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-background border rounded-lg overflow-hidden shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between p-3 sm:p-4 border-b bg-muted/30 backdrop-blur-md">
                <div className="flex items-center gap-2 overflow-hidden">
                    {isMobile && view === 'cast' && selected && (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSelected(null)}
                            className="mr-1 h-8 w-8 shrink-0"
                        >
                            <ChevronLeft className="w-5 h-5" />
                        </Button>
                    )}
                    <BookOpen className="w-5 h-5 text-primary shrink-0" />
                    <h2 className="font-bold text-sm sm:text-base truncate">
                        Canon Codex
                        {work && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                                · {work} @ {cap}
                            </span>
                        )}
                    </h2>
                </div>
                <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
                    <X className="w-4 h-4" />
                </Button>
            </div>

            <div className="flex flex-1 min-h-0 relative">
                {/* Sidebar */}
                <div
                    className={cn(
                        'w-full lg:w-72 border-r flex flex-col bg-muted/10',
                        showEditorOnMobile ? 'hidden lg:flex' : 'flex'
                    )}
                >
                    {/* View tabs */}
                    <div className="grid grid-cols-3 border-b border-border/50">
                        <SideTab
                            label="Arc"
                            icon={Compass}
                            active={view === 'arc'}
                            onClick={() => {
                                setView('arc');
                                setSelected(null);
                            }}
                        />
                        <SideTab
                            label={`Casting (${dossiers.length})`}
                            icon={Users}
                            active={view === 'cast'}
                            onClick={() => setView('cast')}
                        />
                        <SideTab
                            label="Directeur"
                            icon={Clapperboard}
                            active={view === 'director'}
                            onClick={() => {
                                setView('director');
                                setSelected(null);
                            }}
                        />
                    </div>

                    {view === 'cast' && (
                        <CastSidebar
                            dossiers={filtered}
                            selected={selected}
                            search={search}
                            onSearch={setSearch}
                            onSelect={setSelected}
                            onDelete={async (name) => {
                                await deleteCanonDossier(work, name);
                                // Keep the card's `canonCast` in sync — otherwise the deleted
                                // name lingers there and re-leaks into "more persos" exclusion
                                // lists, prompt injection, and other code paths that read it.
                                if (character.canonCast?.length) {
                                    const next = character.canonCast.filter(
                                        (n) => n.toLowerCase() !== name.toLowerCase()
                                    );
                                    if (next.length !== character.canonCast.length) {
                                        await updateCharacter(character.id, { canonCast: next });
                                    }
                                }
                                if (selected === name) setSelected(null);
                                await reload();
                            }}
                            onAdd={() => setSelected('__new__')}
                        />
                    )}

                    {view !== 'cast' && (
                        <div className="p-3 text-xs text-muted-foreground">
                            {view === 'arc'
                                ? 'Réglages d’arc, position dans la timeline, et carte des arcs canoniques.'
                                : 'Outils du Directeur : peupler le casting, proposer des scènes vers le prochain beat canon.'}
                        </div>
                    )}
                </div>

                {/* Main pane */}
                <div
                    className={cn(
                        'flex-1 min-h-0 overflow-y-auto',
                        !showEditorOnMobile && isMobile && 'hidden lg:flex'
                    )}
                >
                    {view === 'arc' && (
                        <ArcPane
                            arc={conversation?.arc}
                            work={work}
                            character={character}
                            arcOutlineText={arcOutlineText}
                            onUpdateArc={(patch) => {
                                if (!activeConversationId) return;
                                updateArc(activeConversationId, {
                                    ...(conversation?.arc || {}),
                                    ...patch,
                                });
                            }}
                            onReload={reload}
                        />
                    )}
                    {view === 'cast' &&
                        (current || selected === '__new__' ? (
                            <CastPane
                                key={selected}
                                dossier={current}
                                isNew={selected === '__new__'}
                                work={work}
                                cap={cap}
                                rpNotes={
                                    (current && conversation?.rpJournal?.[current.character]) || []
                                }
                                onSaveCanon={async (next) => {
                                    await saveCanonDossier(next);
                                    setSelected(next.character);
                                    await reload();
                                }}
                                onSaveJournal={(notes) => {
                                    if (activeConversationId && current)
                                        setRpJournalForCharacter(
                                            activeConversationId,
                                            current.character,
                                            notes
                                        );
                                }}
                                onFetchFull={async (force, name) => {
                                    const target = current?.character || name;
                                    if (!target) return;
                                    await fetchCharacterDossier(work, target, cap, { force });
                                    await reload();
                                    setSelected(target);
                                }}
                                onToggleEnabled={async () => {
                                    if (!current) return;
                                    await saveCanonDossier({
                                        ...current,
                                        enabled: current.enabled === false,
                                    });
                                    await reload();
                                }}
                            />
                        ) : (
                            <EmptyCastPane work={work} />
                        ))}
                    {view === 'director' && (
                        <DirectorPane
                            work={work}
                            arc={conversation?.arc}
                            character={character}
                            onPopulated={reload}
                            onApplyNextBeat={(beat) => {
                                if (!activeConversationId) return;
                                updateArc(activeConversationId, {
                                    ...(conversation?.arc || {}),
                                    enabled: true,
                                    nextBeat: beat,
                                });
                            }}
                            onCreateCharacter={async (name) => {
                                const d = await createCanonCharacter(character, conversation, name);
                                if (d) {
                                    setView('cast');
                                    setSelected(d.character);
                                    await reload();
                                }
                                return !!d;
                            }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// Sidebar pieces
// ============================================================================

function SideTab({
    label,
    icon: Icon,
    active,
    onClick,
}: {
    label: string;
    icon: typeof Compass;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'py-2.5 text-xs font-medium border-b-2 transition-colors flex items-center justify-center gap-1.5',
                active
                    ? 'border-primary text-primary bg-primary/5'
                    : 'border-transparent text-muted-foreground hover:bg-muted/50'
            )}
        >
            <Icon className="w-3.5 h-3.5" />
            <span className="truncate">{label}</span>
        </button>
    );
}

function CastSidebar({
    dossiers,
    selected,
    search,
    onSearch,
    onSelect,
    onDelete,
    onAdd,
}: {
    dossiers: CanonDossier[];
    selected: string | null;
    search: string;
    onSearch: (s: string) => void;
    onSelect: (name: string) => void;
    onDelete: (name: string) => void;
    onAdd: () => void;
}) {
    return (
        <>
            <div className="p-3 border-b space-y-2 bg-muted/5">
                <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                        placeholder="Rechercher (nom, arc)…"
                        className="pl-9 h-9 text-xs bg-background/50"
                        value={search}
                        onChange={(e) => onSearch(e.target.value)}
                    />
                </div>
                <Button onClick={onAdd} size="sm" className="w-full text-xs gap-2 font-semibold h-9">
                    <Plus className="w-3.5 h-3.5" /> Nouveau perso
                </Button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
                <div className="flex flex-col p-2 gap-1.5">
                    {dossiers.length === 0 && (
                        <div className="text-center py-10 px-4">
                            <Users className="w-8 h-8 opacity-20 mx-auto mb-2" />
                            <p className="text-xs text-muted-foreground">Casting vide</p>
                            <p className="text-[10px] text-muted-foreground/70 mt-1">
                                Utilise l&apos;onglet Directeur pour peupler le casting.
                            </p>
                        </div>
                    )}
                    {dossiers.map((d) => (
                        <div
                            key={d.character}
                            role="button"
                            tabIndex={0}
                            onClick={() => onSelect(d.character)}
                            onKeyDown={(e) =>
                                (e.key === 'Enter' || e.key === ' ') && onSelect(d.character)
                            }
                            className={cn(
                                'group p-2.5 rounded-lg text-xs transition-all cursor-pointer flex items-center justify-between',
                                selected === d.character
                                    ? 'bg-primary text-primary-foreground shadow-md translate-x-1'
                                    : 'hover:bg-muted/80 text-muted-foreground hover:text-foreground',
                                d.enabled === false && 'opacity-50'
                            )}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="font-semibold truncate">{d.character}</div>
                                <div className="text-[10px] opacity-70 truncate">
                                    {d.stub ? 'à récupérer' : `canon @ ${d.timelineCap || '?'}`}
                                    {d.userEdited ? ' · édité' : ''}
                                </div>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 opacity-60 hover:opacity-100 hover:bg-destructive/10 hover:text-destructive shrink-0"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(d.character);
                                }}
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}

// ============================================================================
// Arc pane
// ============================================================================

function ArcPane({
    arc,
    work,
    character,
    arcOutlineText,
    onUpdateArc,
    onReload,
}: {
    arc: ArcCompass | undefined;
    work: string;
    character: ReturnType<typeof useCharacterStore.getState>['getActiveCharacter'] extends () => infer T ? T : never;
    arcOutlineText: string;
    onUpdateArc: (patch: Partial<ArcCompass>) => void;
    onReload: () => void | Promise<void>;
}) {
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');

    const handleFetch = async () => {
        const w = arc?.work?.trim() || (character ? resolveWork(character) : '');
        if (!w) {
            setStatus('Renseigne d’abord l’œuvre.');
            return;
        }
        setBusy(true);
        setStatus('Récupération de la carte des arcs (web)…');
        try {
            const out = await fetchArcOutline(w, { force: true });
            setStatus(out ? 'Carte des arcs récupérée ✓' : 'Échec.');
            await onReload();
        } catch {
            setStatus('Échec de la récupération.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="p-5 space-y-5 max-w-3xl">
            <div>
                <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Compass className="w-4 h-4 text-primary" /> Arc Compass
                </h3>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Active la boussole pour que le GM amène subtilement l&apos;histoire vers le
                    prochain beat canonique. Les personnages restent plafonnés à la position actuelle
                    (pas de spoiler).
                </p>
            </div>

            <label className="flex items-center gap-2 text-sm">
                <input
                    type="checkbox"
                    checked={!!arc?.enabled}
                    onChange={(e) => onUpdateArc({ enabled: e.target.checked })}
                />
                Activer l&apos;Arc Compass
            </label>

            <FormField label="Œuvre">
                <Input
                    placeholder={character ? resolveWork(character) || 'ex. Naruto' : 'ex. Naruto'}
                    value={arc?.work || ''}
                    onChange={(e) => onUpdateArc({ work: e.target.value })}
                />
            </FormField>

            <FormField label="Prochain beat à amener (subtilement)">
                <Textarea
                    placeholder="ex. La rencontre avec l’examen Chūnin approche…"
                    value={arc?.nextBeat || ''}
                    onChange={(e) => onUpdateArc({ nextBeat: e.target.value })}
                    className="min-h-[70px]"
                />
            </FormField>

            <FormField label="Position actuelle (auto-capturée depuis le [timeline] du GM)">
                <Input
                    value={arc?.currentPosition || ''}
                    onChange={(e) => onUpdateArc({ currentPosition: e.target.value })}
                    placeholder="ex. S1E5 — auto-rempli"
                />
            </FormField>

            <div className="border-t pt-4 space-y-2">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">Carte des arcs (canon)</span>
                    <Button
                        onClick={handleFetch}
                        disabled={busy}
                        variant="outline"
                        size="sm"
                        className="gap-2"
                    >
                        {busy ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Globe className="w-3.5 h-3.5" />
                        )}
                        {arcOutlineText ? 'Rafraîchir' : 'Récupérer'}
                    </Button>
                </div>
                {status && <p className="text-xs text-muted-foreground">{status}</p>}
                {arcOutlineText ? (
                    <pre className="text-xs whitespace-pre-wrap font-sans bg-muted/30 rounded-lg p-3 max-h-80 overflow-y-auto">
                        {arcOutlineText}
                    </pre>
                ) : (
                    <p className="text-xs text-muted-foreground/70">
                        Aucune carte récupérée pour le moment. Renseigne l&apos;œuvre puis clique
                        Récupérer.
                    </p>
                )}
                {work && !arc?.work && (
                    <p className="text-[10px] text-muted-foreground/70">
                        (œuvre auto-déduite : <span className="font-mono">{work}</span>)
                    </p>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// Cast pane — per-character canon + RP journal
// ============================================================================

function CastPane({
    dossier,
    isNew,
    work,
    cap,
    rpNotes,
    onSaveCanon,
    onSaveJournal,
    onFetchFull,
    onToggleEnabled,
}: {
    dossier: CanonDossier | null;
    isNew: boolean;
    work: string;
    cap: string;
    rpNotes: string[];
    onSaveCanon: (next: CanonDossier) => Promise<void>;
    onSaveJournal: (notes: string[]) => void;
    onFetchFull: (force: boolean, name?: string) => Promise<void>;
    onToggleEnabled: () => void;
}) {
    const [name, setName] = useState(dossier?.character || '');
    const [identity, setIdentity] = useState(dossier?.identity || '');
    const [backstory, setBackstory] = useState(dossier?.backstory || '');
    const [abilities, setAbilities] = useState(dossier?.abilities || '');
    const [arcs, setArcs] = useState((dossier?.appearsInArcs || []).join(', '));
    const [journalText, setJournalText] = useState(rpNotes.join('\n'));
    const [fetching, setFetching] = useState(false);

    useEffect(() => {
        setName(dossier?.character || '');
        setIdentity(dossier?.identity || '');
        setBackstory(dossier?.backstory || '');
        setAbilities(dossier?.abilities || '');
        setArcs((dossier?.appearsInArcs || []).join(', '));
    }, [dossier]);
    useEffect(() => setJournalText(rpNotes.join('\n')), [rpNotes]);

    const handleSave = async () => {
        const targetName = (dossier?.character || name).trim();
        if (!targetName) return;
        const next: CanonDossier = {
            work,
            character: targetName,
            timelineCap: dossier?.timelineCap || cap,
            identity,
            backstory,
            abilities,
            relationships: dossier?.relationships || [],
            appearsInArcs: arcs
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            sources: dossier?.sources,
            fetchedAt: dossier?.fetchedAt || Date.now(),
            stub: false,
            userEdited: true,
            enabled: dossier?.enabled !== false,
        };
        await onSaveCanon(next);
    };

    const handleFetch = async (force: boolean) => {
        setFetching(true);
        try {
            await onFetchFull(force, name.trim() || undefined);
        } finally {
            setFetching(false);
        }
    };

    const disabled = dossier?.enabled === false;

    return (
        <div className="p-5 space-y-5 max-w-3xl">
            <div className="flex items-center justify-between">
                <div className="min-w-0">
                    <h3 className="text-base font-semibold truncate">
                        {isNew ? 'Nouveau personnage' : dossier?.character}
                    </h3>
                    {!isNew && dossier && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {dossier.stub ? 'fiche non récupérée' : `canon @ ${dossier.timelineCap || '?'}`}
                            {dossier.userEdited ? ' · édité' : ''}
                        </p>
                    )}
                </div>
                {!isNew && dossier && (
                    <Button
                        onClick={onToggleEnabled}
                        variant="outline"
                        size="sm"
                        className={cn('h-7 text-xs', disabled && 'text-muted-foreground')}
                    >
                        {disabled ? 'Activer' : 'Désactiver'}
                    </Button>
                )}
            </div>

            {(isNew || !dossier) && (
                <FormField label="Nom canonique">
                    <Input
                        placeholder="ex. Rukia Kuchiki"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </FormField>
            )}

            {dossier?.stub ? (
                <div className="bg-muted/30 rounded-lg p-4 space-y-3">
                    <p className="text-sm">
                        Fiche non récupérée. Apparaît dans :{' '}
                        <span className="text-muted-foreground">
                            {(dossier.appearsInArcs || []).join(', ') || '—'}
                        </span>
                    </p>
                    <Button
                        onClick={() => handleFetch(false)}
                        disabled={fetching}
                        size="sm"
                        className="gap-2"
                    >
                        {fetching ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Globe className="w-3.5 h-3.5" />
                        )}
                        Récupérer la fiche complète (web)
                    </Button>
                </div>
            ) : (
                <>
                    <FormField label="Identité (canon)">
                        <Textarea
                            value={identity}
                            onChange={(e) => setIdentity(e.target.value)}
                            className="min-h-[100px]"
                            placeholder="Personnalité, voix, apparence…"
                        />
                    </FormField>
                    <FormField label="Background (canon)">
                        <Textarea
                            value={backstory}
                            onChange={(e) => setBackstory(e.target.value)}
                            className="min-h-[80px]"
                            placeholder="Background jusqu’au cap de timeline…"
                        />
                    </FormField>
                    <FormField label="Capacités (canon)">
                        <Textarea
                            value={abilities}
                            onChange={(e) => setAbilities(e.target.value)}
                            className="min-h-[60px]"
                        />
                    </FormField>
                </>
            )}

            <FormField label="Apparaît dans les arcs (séparés par des virgules)">
                <Input
                    value={arcs}
                    onChange={(e) => setArcs(e.target.value)}
                    placeholder="ex. Kazekage Rescue, Pain's Assault"
                />
            </FormField>

            <FormField label="Dans ce RP (une note par ligne) — empilé sur le canon, ne l’écrase jamais">
                <Textarea
                    value={journalText}
                    onChange={(e) => setJournalText(e.target.value)}
                    onBlur={() => onSaveJournal(journalText.split('\n'))}
                    className="min-h-[80px]"
                    placeholder="Développements propres à cette partie…"
                />
            </FormField>

            <div className="flex gap-2 pt-2 border-t">
                <Button onClick={handleSave} size="sm" className="gap-2 flex-1">
                    <Save className="w-3.5 h-3.5" />
                    Enregistrer
                </Button>
                {!isNew && (
                    <Button
                        onClick={() => handleFetch(true)}
                        disabled={fetching}
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        title="Re-récupère depuis le web (écrase tes éditions)"
                    >
                        {fetching ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        Rafraîchir
                    </Button>
                )}
            </div>
        </div>
    );
}

function EmptyCastPane({ work }: { work: string }) {
    return (
        <div className="flex flex-col items-center justify-center h-full p-10 text-center">
            <Users className="w-12 h-12 opacity-20 mb-3" />
            <p className="text-sm text-muted-foreground">Sélectionne un personnage à gauche</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
                {work
                    ? 'ou crée-en un nouveau, ou peuple le casting depuis l’onglet Directeur.'
                    : 'Renseigne d’abord l’œuvre dans l’onglet Arc.'}
            </p>
        </div>
    );
}

// ============================================================================
// Director pane
// ============================================================================

function DirectorPane({
    work,
    arc,
    character,
    onPopulated,
    onApplyNextBeat,
    onCreateCharacter,
}: {
    work: string;
    arc: ArcCompass | undefined;
    character: NonNullable<ReturnType<typeof useCharacterStore.getState>['getActiveCharacter'] extends () => infer T ? T : never>;
    onPopulated: () => void | Promise<void>;
    onApplyNextBeat: (beat: string) => void;
    onCreateCharacter: (name: string) => Promise<boolean>;
}) {
    const [populating, setPopulating] = useState(false);
    const [popStatus, setPopStatus] = useState('');
    const [name, setName] = useState('');
    const [creating, setCreating] = useState(false);
    const [createStatus, setCreateStatus] = useState('');
    const [proposing, setProposing] = useState(false);
    const [scenes, setScenes] = useState<string[]>([]);

    const handlePopulate = async (mode: 'initial' | 'more') => {
        setPopulating(true);
        setPopStatus(
            mode === 'more'
                ? 'Recherche de nouveaux personnages…'
                : 'Récupération du casting (connaissances du modèle)…'
        );
        try {
            const n = await populateCanonRoster(character, mode);
            setPopStatus(
                n > 0
                    ? `${n} nouveau${n > 1 ? 'x' : ''} personnage${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} ✓`
                    : mode === 'more'
                      ? 'Plus de personnages canoniques notables trouvés.'
                      : 'Aucun personnage trouvé.'
            );
            await onPopulated();
        } catch {
            setPopStatus('Échec de la récupération.');
        } finally {
            setPopulating(false);
        }
    };

    const handleCreate = async () => {
        if (!name.trim()) return;
        setCreating(true);
        setCreateStatus('Récupération du canon (web)…');
        try {
            const ok = await onCreateCharacter(name.trim());
            setCreateStatus(
                ok ? `${name.trim()} ajouté ✓` : 'Échec — vérifie l’œuvre et ta clé.'
            );
            if (ok) setName('');
        } finally {
            setCreating(false);
        }
    };

    const handlePropose = async () => {
        setProposing(true);
        setScenes([]);
        try {
            setScenes(await proposeScenes(character, undefined));
        } finally {
            setProposing(false);
        }
    };

    return (
        <div className="p-5 space-y-6 max-w-3xl">
            {/* Populate cast */}
            <section>
                <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Users className="w-4 h-4 text-primary" /> Peupler le casting
                </h3>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Récupère les personnages majeurs de l&apos;œuvre + leurs arcs d&apos;apparition.
                    Les fiches complètes se récupèrent à la demande (1 appel web par perso).
                </p>
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                    <Button
                        onClick={() => handlePopulate('initial')}
                        disabled={populating || !work}
                        size="sm"
                        className="gap-2"
                    >
                        {populating ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Sparkles className="w-3.5 h-3.5" />
                        )}
                        Peupler le casting
                    </Button>
                    <Button
                        onClick={() => handlePopulate('more')}
                        disabled={populating || !work || (character.canonCast?.length || 0) === 0}
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        title="Demande au modèle une nouvelle volée de persos, en excluant ceux déjà présents"
                    >
                        {populating ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Plus className="w-3.5 h-3.5" />
                        )}
                        Plus de persos
                    </Button>
                    {popStatus && <span className="text-xs text-muted-foreground">{popStatus}</span>}
                </div>
            </section>

            {/* Add a specific character */}
            <section className="border-t pt-5">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Plus className="w-4 h-4 text-primary" /> Ajouter un personnage spécifique
                </h3>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Filet de sécurité si le peuplement a oublié quelqu&apos;un d&apos;important.
                    Récupère sa fiche canon plafonnée à la position actuelle.
                </p>
                <div className="mt-3 flex items-center gap-2">
                    <Input
                        placeholder="Nom canonique (ex. Rukia Kuchiki)"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                        className="text-sm h-9"
                    />
                    <Button
                        onClick={handleCreate}
                        disabled={creating || !name.trim() || !work}
                        size="sm"
                        className="gap-2 shrink-0"
                    >
                        {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Ajouter'}
                    </Button>
                </div>
                {createStatus && (
                    <p className="text-xs text-muted-foreground mt-2">{createStatus}</p>
                )}
            </section>

            {/* Propose next scenes */}
            <section className="border-t pt-5">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                        <Clapperboard className="w-4 h-4 text-primary" /> Proposer la suite
                    </h3>
                    <Button
                        onClick={handlePropose}
                        disabled={proposing}
                        variant="outline"
                        size="sm"
                        className="gap-2"
                    >
                        {proposing ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            'Proposer 3 scènes'
                        )}
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    3 scènes arc-aware orientées vers le prochain beat canon
                    {arc?.nextBeat ? ` (« ${arc.nextBeat} »)` : ''}.
                </p>
                <div className="mt-3 space-y-2">
                    {scenes.map((s, i) => (
                        <button
                            key={i}
                            onClick={() => onApplyNextBeat(s)}
                            className="w-full text-left text-sm bg-muted/30 hover:bg-muted/60 rounded-lg p-3 transition-colors"
                            title="Définir comme prochain beat"
                        >
                            {s}
                        </button>
                    ))}
                </div>
            </section>
        </div>
    );
}

// ============================================================================
// Shared form field
// ============================================================================

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{label}</label>
            {children}
        </div>
    );
}
