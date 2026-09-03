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
        Promise.all([
            getStoryStateForBranch(conversation, messages),
            resolveSceneCharacters(
                conversation.sceneRoster ?? [],
                character,
                conversation.sceneCharacterOverrides
            ),
        ])
            .then(([stored, profiles]) => {
                if (cancelled) return;
                setState(
                    stored ??
                        createInitialStoryState({
                            conversation,
                            profiles,
                            anchorMessageId: messages[messages.length - 1]?.id,
                        })
                );
            })
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [open, conversation, character, messages]);

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
