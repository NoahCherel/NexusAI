'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Lock, Unlock, Save, Loader2 } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { CharacterCard, Conversation, Message, StoryState } from '@/types';
import {
    createInitialStoryState,
    createStoryStateRevision,
    getStoryStateForBranch,
    resolveSceneCharacters,
    storyRoster,
} from '@/lib/ai/story-state';
import { commitStoryStateRevision } from '@/lib/db';
import { useChatStore } from '@/stores/chat-store';

const FIELDS = [
    ['/scene/location', 'Lieu'],
    ['/scene/time', 'Temps'],
    ['/plot/objective', 'Objectif'],
    ['/plot/pressure', 'Pression'],
] as const;

export function StoryStatePanel({
    conversation,
    character,
    messages,
    trigger,
}: {
    conversation: Conversation;
    character: CharacterCard;
    messages: Message[];
    trigger: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [state, setState] = useState<StoryState | null>(null);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        void (async () => {
            const stored = await getStoryStateForBranch(conversation, messages);
            const profiles = await resolveSceneCharacters(
                conversation.sceneRoster ?? [],
                character,
                conversation.sceneCharacterOverrides,
                stored?.characters
            );
            if (cancelled) return;
            setState(
                stored ??
                    createInitialStoryState({
                        conversation,
                        profiles,
                        anchorMessageId: messages[messages.length - 1]?.id,
                    })
            );
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
        // Reload only when the panel opens or the conversation changes. `conversation` and
        // `messages` get a new identity on every store tick (a planner pass, a streamed
        // token) and would wipe the user's in-progress edits of twenty fields.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, conversation.id, character.id]);

    const toggleLock = (path: string) => {
        setState((current) => {
            if (!current) return current;
            const locks = { ...current.locks };
            if (locks[path]) delete locks[path];
            else locks[path] = true;
            return { ...current, locks };
        });
    };

    const save = async () => {
        if (!state) return;
        const anchor = messages[messages.length - 1];
        if (!anchor) return;
        setSaving(true);
        try {
            const stored = await getStoryStateForBranch(conversation, messages);
            const revision = stored
                ? createStoryStateRevision({
                      previous: stored,
                      next: state,
                      source: 'user',
                      anchorMessageId: anchor.id,
                  })
                : { ...state, source: 'user' as const, anchorMessageId: anchor.id };
            await commitStoryStateRevision(revision, anchor.id);
            useChatStore.getState().applyStoryStateRevision({
                conversationId: conversation.id,
                messageId: anchor.id,
                storyStateRevisionId: revision.id,
                roster: storyRoster(revision),
            });
            if (
                conversation.arc &&
                revision.plot.canonPosition &&
                revision.plot.canonPosition !== conversation.arc.currentPosition
            ) {
                useChatStore.getState().updateArc(conversation.id, {
                    ...conversation.arc,
                    currentPosition: revision.plot.canonPosition,
                });
            }
            setState(revision);
            setOpen(false);
        } finally {
            setSaving(false);
        }
    };

    const renderLock = (path: string) => (
        <button
            type="button"
            className="p-1 text-muted-foreground hover:text-foreground"
            onClick={() => toggleLock(path)}
            title={state?.locks[path] ? 'Déverrouiller pour l’IA' : 'Verrouiller pour l’IA'}
        >
            {state?.locks[path] ? (
                <Lock className="h-3.5 w-3.5" />
            ) : (
                <Unlock className="h-3.5 w-3.5" />
            )}
        </button>
    );

    const updateTone = (
        key: 'humor' | 'darkness' | 'intimacy' | 'intensity',
        edge: 0 | 1,
        value: number
    ) => {
        setState((current) => {
            if (!current?.scene.tone) return current;
            const range = [...current.scene.tone[key]] as [number, number];
            range[edge] = Math.max(0, Math.min(4, value));
            if (range[0] > range[1]) range[edge === 0 ? 1 : 0] = range[edge];
            return {
                ...current,
                scene: {
                    ...current.scene,
                    tone: { ...current.scene.tone, [key]: range },
                },
            };
        });
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
            {/* A centred, fixed dialog rather than an anchored popover: the panel opens on a
                "Chargement…" stub and grows once the revision loads, and an anchored panel
                positioned for the stub could end up hanging below a phone's viewport. A
                dialog is sized by the viewport alone and scrolls inside itself. */}
            <DialogContent className="block max-h-[85vh] w-[min(34rem,calc(100%-1rem))] max-w-none overflow-y-auto p-4 sm:max-w-[34rem] space-y-3">
                <DialogHeader className="text-left">
                    <DialogTitle className="text-base">État de l’intrigue</DialogTitle>
                    <DialogDescription className="text-[11px]">
                        Révision liée à cette branche. Les cadenas bloquent les modifications
                        produites par l’IA.
                    </DialogDescription>
                </DialogHeader>
                {loading || !state ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
                    </div>
                ) : (
                    <>
                        {FIELDS.map(([path, label]) => {
                            const value =
                                path === '/scene/location'
                                    ? state.scene.location
                                    : path === '/scene/time'
                                      ? state.scene.time
                                      : path === '/plot/objective'
                                        ? state.plot.objective
                                        : state.plot.pressure;
                            return (
                                <label key={path} className="block space-y-1">
                                    <span className="flex items-center justify-between text-xs">
                                        {label}
                                        {renderLock(path)}
                                    </span>
                                    <Input
                                        value={value ?? ''}
                                        onChange={(event) => {
                                            const next = event.target.value;
                                            setState((current) => {
                                                if (!current) return current;
                                                if (path === '/scene/location')
                                                    return {
                                                        ...current,
                                                        scene: { ...current.scene, location: next },
                                                    };
                                                if (path === '/scene/time')
                                                    return {
                                                        ...current,
                                                        scene: { ...current.scene, time: next },
                                                    };
                                                if (path === '/plot/objective')
                                                    return {
                                                        ...current,
                                                        plot: { ...current.plot, objective: next },
                                                    };
                                                return {
                                                    ...current,
                                                    plot: { ...current.plot, pressure: next },
                                                };
                                            });
                                        }}
                                        className="h-8 text-xs"
                                    />
                                </label>
                            );
                        })}
                        {conversation.directedNarrativeVersion === 2 && (
                            <div className="space-y-3 rounded-md border border-border/50 p-3">
                                <div className="text-xs font-medium">Direction V2</div>
                                <label className="block space-y-1">
                                    <span className="flex items-center justify-between text-xs">
                                        Position canonique{renderLock('/plot/canonPosition')}
                                    </span>
                                    <Input
                                        value={state.plot.canonPosition ?? ''}
                                        onChange={(event) =>
                                            setState({
                                                ...state,
                                                plot: {
                                                    ...state.plot,
                                                    canonPosition: event.target.value,
                                                },
                                            })
                                        }
                                        className="h-8 text-xs"
                                    />
                                </label>
                                <label className="block space-y-1">
                                    <span className="flex items-center justify-between text-xs">
                                        Question dramatique
                                        {renderLock('/plot/dramaticQuestion')}
                                    </span>
                                    <Input
                                        value={state.plot.dramaticQuestion ?? ''}
                                        onChange={(event) =>
                                            setState({
                                                ...state,
                                                plot: {
                                                    ...state.plot,
                                                    dramaticQuestion: event.target.value,
                                                },
                                            })
                                        }
                                        className="h-8 text-xs"
                                    />
                                </label>
                                <label className="flex items-center justify-between gap-3 text-xs">
                                    Rythme
                                    <select
                                        className="rounded border border-border bg-background px-2 py-1"
                                        value={state.scene.rhythm ?? 'adaptive'}
                                        onChange={(event) =>
                                            setState({
                                                ...state,
                                                scene: {
                                                    ...state.scene,
                                                    rhythm: event.target.value as NonNullable<
                                                        StoryState['scene']['rhythm']
                                                    >,
                                                },
                                            })
                                        }
                                    >
                                        <option value="slow">lent</option>
                                        <option value="balanced">équilibré</option>
                                        <option value="fast">rapide</option>
                                        <option value="adaptive">adaptatif</option>
                                    </select>
                                </label>
                                {state.scene.tone && (
                                    <div className="space-y-1">
                                        <span className="flex items-center justify-between text-xs">
                                            Bornes de tonalité
                                        </span>
                                        {(
                                            [
                                                ['humor', 'Humour'],
                                                ['darkness', 'Obscurité'],
                                                ['intimacy', 'Intimité'],
                                                ['intensity', 'Intensité'],
                                            ] as const
                                        ).map(([key, label]) => (
                                            <div
                                                key={key}
                                                className="grid grid-cols-[1fr_3rem_3rem] items-center gap-2 text-[11px]"
                                            >
                                                <span>{label}</span>
                                                <Input
                                                    type="number"
                                                    min={0}
                                                    max={4}
                                                    value={state.scene.tone![key][0]}
                                                    onChange={(event) =>
                                                        updateTone(
                                                            key,
                                                            0,
                                                            Number(event.target.value)
                                                        )
                                                    }
                                                    className="h-7 px-1 text-xs"
                                                />
                                                <Input
                                                    type="number"
                                                    min={0}
                                                    max={4}
                                                    value={state.scene.tone![key][1]}
                                                    onChange={(event) =>
                                                        updateTone(
                                                            key,
                                                            1,
                                                            Number(event.target.value)
                                                        )
                                                    }
                                                    className="h-7 px-1 text-xs"
                                                />
                                            </div>
                                        ))}
                                        <label className="block space-y-1">
                                            <span className="text-[10px] text-muted-foreground">
                                                Termes et thèmes interdits (un par ligne)
                                            </span>
                                            <Textarea
                                                value={(state.scene.tone.forbidden ?? []).join(
                                                    '\n'
                                                )}
                                                onChange={(event) =>
                                                    setState({
                                                        ...state,
                                                        scene: {
                                                            ...state.scene,
                                                            tone: {
                                                                ...state.scene.tone!,
                                                                forbidden: event.target.value
                                                                    .split('\n')
                                                                    .map((line) => line.trim())
                                                                    .filter(Boolean),
                                                            },
                                                        },
                                                    })
                                                }
                                                className="min-h-14 text-xs"
                                            />
                                        </label>
                                    </div>
                                )}
                            </div>
                        )}
                        <label className="block space-y-1">
                            <span className="flex items-center justify-between text-xs">
                                Fils ouverts{renderLock('/plot/openThreads')}
                            </span>
                            <Textarea
                                value={state.plot.openThreads.join('\n')}
                                onChange={(event) =>
                                    setState({
                                        ...state,
                                        plot: {
                                            ...state.plot,
                                            openThreads: event.target.value
                                                .split('\n')
                                                .map((line) => line.trim())
                                                .filter(Boolean),
                                        },
                                    })
                                }
                                className="min-h-20 text-xs"
                                placeholder="Un fil narratif par ligne"
                            />
                        </label>
                        <label className="block space-y-1">
                            <span className="text-xs">Connaissances et secrets</span>
                            <Textarea
                                value={(state.knowledge ?? [])
                                    .map((fact) => {
                                        const audience =
                                            fact.visibility === 'public'
                                                ? 'public'
                                                : fact.knownBy
                                                      .map(
                                                          (id) =>
                                                              state.scene.participants.find(
                                                                  (participant) =>
                                                                      participant.character.id ===
                                                                      id
                                                              )?.character.displayName
                                                      )
                                                      .filter(Boolean)
                                                      .join(', ');
                                        return `${fact.text} :: ${audience}`;
                                    })
                                    .join('\n')}
                                onChange={(event) => {
                                    const previous = state.knowledge ?? [];
                                    const knowledge = event.target.value
                                        .split('\n')
                                        .map((line, index) => {
                                            const [rawText, rawAudience = ''] = line.split('::');
                                            const factText = rawText.trim();
                                            if (!factText) return null;
                                            const audience = rawAudience.trim();
                                            const isPublic =
                                                audience.toLocaleLowerCase() === 'public';
                                            const names = audience
                                                .split(',')
                                                .map((name) => name.trim().toLocaleLowerCase())
                                                .filter(Boolean);
                                            return {
                                                id: previous[index]?.id ?? crypto.randomUUID(),
                                                text: factText,
                                                aliases: previous[index]?.aliases,
                                                visibility: isPublic
                                                    ? ('public' as const)
                                                    : ('private' as const),
                                                knownBy: isPublic
                                                    ? []
                                                    : state.scene.participants
                                                          .filter((participant) =>
                                                              names.includes(
                                                                  participant.character.displayName.toLocaleLowerCase()
                                                              )
                                                          )
                                                          .map(
                                                              (participant) =>
                                                                  participant.character.id
                                                          ),
                                            };
                                        })
                                        .filter((fact): fact is NonNullable<typeof fact> => !!fact);
                                    setState({ ...state, knowledge });
                                }}
                                className="min-h-20 text-xs"
                                placeholder="Bob a caché la clé :: Bob&#10;La porte est verrouillée :: public"
                            />
                            <span className="text-[10px] text-muted-foreground">
                                Une ligne par fait, suivie de « :: public » ou des personnages qui
                                le connaissent.
                            </span>
                        </label>
                        <div className="space-y-1">
                            <div className="text-xs font-medium">Participants</div>
                            {state.scene.participants.map((participant, index) => {
                                const presencePath = `/scene/participants/${participant.character.id}/presence`;
                                const agencyPath = `/scene/participants/${participant.character.id}/agency`;
                                return (
                                    <div
                                        key={participant.character.id}
                                        className="grid grid-cols-[1fr_auto_auto] gap-2 items-center rounded-md bg-muted/30 p-2 text-xs"
                                    >
                                        <span>
                                            {participant.character.displayName}
                                            {participant.character.readiness === 'stub'
                                                ? ' · profil incomplet'
                                                : ''}
                                        </span>
                                        <select
                                            className="rounded border border-border bg-background px-1 py-1 pointer-coarse:py-2"
                                            value={participant.presence}
                                            onChange={(event) => {
                                                const participants = [...state.scene.participants];
                                                participants[index] = {
                                                    ...participant,
                                                    presence: event.target
                                                        .value as typeof participant.presence,
                                                };
                                                setState({
                                                    ...state,
                                                    scene: { ...state.scene, participants },
                                                });
                                            }}
                                        >
                                            <option value="onstage">présent</option>
                                            <option value="remote">à distance</option>
                                            <option value="offstage">hors-scène</option>
                                        </select>
                                        <span className="flex">{renderLock(presencePath)}</span>
                                        <span />
                                        <select
                                            className="rounded border border-border bg-background px-1 py-1 pointer-coarse:py-2"
                                            value={participant.agency}
                                            onChange={(event) => {
                                                const participants = [...state.scene.participants];
                                                participants[index] = {
                                                    ...participant,
                                                    agency: event.target
                                                        .value as typeof participant.agency,
                                                };
                                                setState({
                                                    ...state,
                                                    scene: { ...state.scene, participants },
                                                });
                                            }}
                                        >
                                            <option value="active">actif</option>
                                            <option value="limited">limité</option>
                                            <option value="none">sans action</option>
                                        </select>
                                        <span className="flex">{renderLock(agencyPath)}</span>
                                    </div>
                                );
                            })}
                        </div>
                        {conversation.directedNarrativeVersion === 2 && (
                            <>
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between text-xs font-medium">
                                        Étapes de l’arc{renderLock('/plot/steps')}
                                    </div>
                                    {(state.plot.steps ?? []).length === 0 ? (
                                        <p className="text-[10px] text-muted-foreground">
                                            Le Directeur d’intrigue préparera les prochaines étapes.
                                        </p>
                                    ) : (
                                        (state.plot.steps ?? []).map((step, index) => (
                                            <div
                                                key={step.id}
                                                className="space-y-1 rounded-md bg-muted/30 p-2"
                                            >
                                                <div className="flex gap-2">
                                                    <Input
                                                        value={step.premise}
                                                        onChange={(event) => {
                                                            const steps = [
                                                                ...(state.plot.steps ?? []),
                                                            ];
                                                            steps[index] = {
                                                                ...step,
                                                                premise: event.target.value,
                                                            };
                                                            setState({
                                                                ...state,
                                                                plot: { ...state.plot, steps },
                                                            });
                                                        }}
                                                        className="h-7 text-xs"
                                                    />
                                                    <select
                                                        value={step.status}
                                                        onChange={(event) => {
                                                            const steps = [
                                                                ...(state.plot.steps ?? []),
                                                            ];
                                                            steps[index] = {
                                                                ...step,
                                                                status: event.target
                                                                    .value as typeof step.status,
                                                            };
                                                            setState({
                                                                ...state,
                                                                plot: { ...state.plot, steps },
                                                            });
                                                        }}
                                                        className="rounded border border-border bg-background px-1 text-[10px]"
                                                    >
                                                        <option value="planned">prévue</option>
                                                        <option value="active">active</option>
                                                        <option value="resolved">résolue</option>
                                                        <option value="detoured">détour</option>
                                                        <option value="abandoned">
                                                            abandonnée
                                                        </option>
                                                    </select>
                                                </div>
                                                <p className="text-[10px] text-muted-foreground">
                                                    Payoff : {step.intendedPayoff}
                                                </p>
                                            </div>
                                        ))
                                    )}
                                    {(state.plot.castingNeeds ?? []).length > 0 && (
                                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                            Besoins de casting{renderLock('/plot/castingNeeds')}
                                        </div>
                                    )}
                                    {(state.plot.castingNeeds ?? []).map((need) => (
                                        <div
                                            key={need.id}
                                            className="flex items-center gap-2 rounded border border-dashed border-border px-2 py-1 text-[10px]"
                                        >
                                            <select
                                                value={need.status}
                                                onChange={(event) =>
                                                    setState({
                                                        ...state,
                                                        plot: {
                                                            ...state.plot,
                                                            castingNeeds: (
                                                                state.plot.castingNeeds ?? []
                                                            ).map((candidate) =>
                                                                candidate.id === need.id
                                                                    ? {
                                                                          ...candidate,
                                                                          status: event.target
                                                                              .value as typeof need.status,
                                                                      }
                                                                    : candidate
                                                            ),
                                                        },
                                                    })
                                                }
                                                className="rounded border border-border bg-background px-1"
                                            >
                                                <option value="open">ouvert</option>
                                                <option value="filled">pourvu</option>
                                                <option value="dismissed">écarté</option>
                                            </select>
                                            <span className="min-w-0 flex-1 truncate">
                                                {need.role} — {need.reason}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                <div className="space-y-2">
                                    <div className="text-xs font-medium">Motivations privées</div>
                                    {Object.values(state.characters ?? {}).map((entry) => {
                                        const base = `/characters/${entry.ref.id}`;
                                        return (
                                            <div
                                                key={entry.ref.id}
                                                className="space-y-2 rounded-md border border-border/50 p-2"
                                            >
                                                <div className="flex items-center justify-between text-xs font-medium">
                                                    <span>
                                                        {entry.ref.displayName}
                                                        {entry.ref.source === 'generated'
                                                            ? ` · ${entry.status ?? 'cameo'}`
                                                            : ''}
                                                    </span>
                                                    {entry.ref.source === 'generated' && (
                                                        <label className="flex items-center gap-1 text-[10px] font-normal">
                                                            <input
                                                                type="checkbox"
                                                                checked={entry.pinned ?? false}
                                                                onChange={(event) =>
                                                                    setState({
                                                                        ...state,
                                                                        characters: {
                                                                            ...(state.characters ??
                                                                                {}),
                                                                            [entry.ref.id]: {
                                                                                ...entry,
                                                                                pinned: event.target
                                                                                    .checked,
                                                                                status: event.target
                                                                                    .checked
                                                                                    ? 'recurring'
                                                                                    : (entry.meaningfulAppearances ??
                                                                                            0) >= 2
                                                                                      ? 'recurring'
                                                                                      : 'cameo',
                                                                            },
                                                                        },
                                                                    })
                                                                }
                                                            />
                                                            récurrent
                                                        </label>
                                                    )}
                                                </div>
                                                <label className="block">
                                                    <span className="flex items-center justify-between text-[10px] text-muted-foreground">
                                                        Position{renderLock(`${base}/stance`)}
                                                    </span>
                                                    <Input
                                                        value={entry.stance ?? ''}
                                                        onChange={(event) =>
                                                            setState({
                                                                ...state,
                                                                characters: {
                                                                    ...(state.characters ?? {}),
                                                                    [entry.ref.id]: {
                                                                        ...entry,
                                                                        stance: event.target.value,
                                                                    },
                                                                },
                                                            })
                                                        }
                                                        className="h-7 text-xs"
                                                    />
                                                </label>
                                                <label className="block">
                                                    <span className="flex items-center justify-between text-[10px] text-muted-foreground">
                                                        Objectif privé
                                                        {renderLock(`${base}/privateGoal`)}
                                                    </span>
                                                    <Input
                                                        value={entry.privateGoal ?? ''}
                                                        onChange={(event) =>
                                                            setState({
                                                                ...state,
                                                                characters: {
                                                                    ...(state.characters ?? {}),
                                                                    [entry.ref.id]: {
                                                                        ...entry,
                                                                        privateGoal:
                                                                            event.target.value,
                                                                    },
                                                                },
                                                            })
                                                        }
                                                        className="h-7 text-xs"
                                                    />
                                                </label>
                                                <label className="block">
                                                    <span className="flex items-center justify-between text-[10px] text-muted-foreground">
                                                        Engagements
                                                        {renderLock(`${base}/commitments`)}
                                                    </span>
                                                    <Textarea
                                                        value={entry.commitments.join('\n')}
                                                        onChange={(event) =>
                                                            setState({
                                                                ...state,
                                                                characters: {
                                                                    ...(state.characters ?? {}),
                                                                    [entry.ref.id]: {
                                                                        ...entry,
                                                                        commitments:
                                                                            event.target.value
                                                                                .split('\n')
                                                                                .map((line) =>
                                                                                    line.trim()
                                                                                )
                                                                                .filter(Boolean),
                                                                    },
                                                                },
                                                            })
                                                        }
                                                        className="min-h-14 text-xs"
                                                    />
                                                </label>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                        <Button
                            size="sm"
                            className="w-full gap-2"
                            onClick={() => void save()}
                            disabled={saving || messages.length === 0}
                        >
                            {saving ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Save className="h-4 w-4" />
                            )}
                            Enregistrer cette révision
                        </Button>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
