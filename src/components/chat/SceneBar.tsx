'use client';

/**
 * Scene Mode (Troupe) control bar: per-conversation 🎬 toggle, on-stage roster chips
 * (click removes), and "advance the scene" (a Director beat with no player input —
 * narration / NPC initiative / time passing).
 */

import { useEffect, useMemo, useState } from 'react';
import {
    Clapperboard,
    Play,
    X,
    Loader2,
    Brain,
    AlertTriangle,
    Check,
    BookOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useChatStore } from '@/stores/chat-store';
import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import { getActiveCanonNames } from '@/lib/ai/canon-context';
import { useKnownCastNames } from '@/hooks/useKnownCastNames';
import { useSettingsStore } from '@/stores/settings-store';
import type { SceneBeatRecord, SceneGenerationProgress, StoryState } from '@/types/scene';
import { StoryStatePanel } from '@/components/chat/StoryStatePanel';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
    createInitialStoryState,
    createStoryStateRevision,
    getStoryStateForBranch,
    reconcileStoryStateRoster,
    resolveSceneCharacters,
    storyRoster,
} from '@/lib/ai/story-state';
import { commitStoryStateRevision } from '@/lib/db';
import { useNotificationStore } from '@/components/ui/api-notification';

const AGENT_LABELS: Record<string, string> = {
    director: 'Directeur de beat',
    reflection: 'Réflexion',
    composer: 'Compositeur',
    casting: 'Casting',
    auditor: 'Auditeur',
    planner: 'Directeur d’intrigue',
};

export function SceneBar({
    conversation,
    character,
    messages,
    isSceneRunning,
    sceneProgress,
    lastSceneBeat,
    onRetrySceneBeat,
    onAdvanceScene,
}: {
    conversation: Conversation | undefined;
    character: CharacterCard;
    messages: Message[];
    isSceneRunning: boolean;
    sceneProgress?: SceneGenerationProgress | null;
    lastSceneBeat?: SceneBeatRecord | null;
    onRetrySceneBeat?: () => void;
    onAdvanceScene: () => void;
}) {
    const {
        setSceneMode,
        setSceneRoster,
        setSceneStyle,
        setDirectedNarrativeVersion,
        setDirectedSceneSuggestionDismissed,
        setSceneCharacterOverride,
    } = useChatStore();
    const enableDirectedSceneMode = useSettingsStore((state) => state.enableDirectedSceneMode);
    const [newName, setNewName] = useState('');
    const [showAdd, setShowAdd] = useState(false);
    // Typo-proof roster additions, from the shared cast pool (canonCast + canon dossiers of
    // the work + names seen in the relationship system).
    const castPool = useKnownCastNames(character, conversation);

    const rosterSource = conversation?.sceneRoster;
    const roster = useMemo(() => rosterSource ?? [], [rosterSource]);
    const knownNames = useMemo(() => {
        const inRoster = new Set(roster.map((n) => n.toLowerCase()));
        return castPool.filter((n) => !inRoster.has(n.toLowerCase()));
    }, [castPool, roster]);

    const suggestions = useMemo(() => {
        const q = newName.trim().toLowerCase();
        const pool = q ? knownNames.filter((n) => n.toLowerCase().includes(q)) : knownNames;
        return pool.slice(0, 6);
    }, [newName, knownNames]);

    // "Solo" is the ENGINE's definition — no non-player character on stage or remote with
    // agency — read from the branch state, not from the roster length: a roster member the
    // Director sent offstage still leaves the world alone with the player.
    const [stateSolo, setStateSolo] = useState<boolean | null>(null);
    const conversationId = conversation?.id;
    const isV2Scene = !!conversation?.sceneMode && conversation.directedNarrativeVersion === 2;
    const lastMessageId = messages[messages.length - 1]?.id;
    const activeRevisionId = conversation?.activeStoryStateRevisionId;
    useEffect(() => {
        if (!conversation || !isV2Scene) {
            setStateSolo(null);
            return;
        }
        let cancelled = false;
        getStoryStateForBranch(conversation, messages)
            .then((stored) => {
                if (cancelled) return;
                setStateSolo(
                    stored
                        ? stored.scene.participants.every(
                              (participant) =>
                                  participant.presence === 'offstage' ||
                                  participant.agency === 'none'
                          )
                        : null
                );
            })
            .catch(() => !cancelled && setStateSolo(null));
        return () => {
            cancelled = true;
        };
        // The branch tip and the active revision are the only inputs that move the answer.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversationId, isV2Scene, lastMessageId, activeRevisionId, rosterSource]);

    if (!conversation) return null;
    const sceneOn = !!conversation.sceneMode;
    const soloScene = stateSolo ?? roster.length === 0;
    const suggestedCast = getActiveCanonNames(character, conversation, messages, 6);
    const showSuggestion =
        !sceneOn &&
        !conversation.directedSceneSuggestionDismissed &&
        suggestedCast.length >= 2 &&
        enableDirectedSceneMode;

    const persistRoster = async (nextRoster: string[]) => {
        const anchor = messages[messages.length - 1];
        if (!anchor) {
            setSceneRoster(conversation.id, nextRoster);
            return;
        }
        try {
            const stored = await getStoryStateForBranch(conversation, messages);
            const profiles = await resolveSceneCharacters(
                nextRoster,
                character,
                conversation.sceneCharacterOverrides,
                stored?.characters
            );
            const next = stored
                ? reconcileStoryStateRoster(stored, profiles)
                : createInitialStoryState({
                      conversation,
                      profiles,
                      anchorMessageId: anchor.id,
                  });
            const revision = stored
                ? createStoryStateRevision({
                      previous: stored,
                      next,
                      source: 'user',
                      anchorMessageId: anchor.id,
                  })
                : { ...next, source: 'user' as const };
            await commitStoryStateRevision(revision, anchor.id);
            useChatStore.getState().applyStoryStateRevision({
                conversationId: conversation.id,
                messageId: anchor.id,
                storyStateRevisionId: revision.id,
                roster: storyRoster(revision),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Roster invalide.';
            const { addNotification, updateNotification } = useNotificationStore.getState();
            const id = addNotification('Impossible de modifier la scène', 'world');
            updateNotification(id, 'error', message);
        }
    };

    /**
     * `style` is only honoured when the conversation has never chosen one: the suggestion
     * chip promises "Tours dirigés", the plain toggle keeps the historical default.
     */
    const toggleScene = (style?: 'turns' | 'composed-turns') => {
        if (!sceneOn) {
            // Seed the roster: canon names active in the recent scene, else the whole
            // canonCast (capped), else the card's main character.
            if (roster.length === 0 && conversation.directedNarrativeVersion !== 2) {
                const active = getActiveCanonNames(character, conversation, messages, 20);
                const seed =
                    active.length > 0
                        ? active
                        : (character.canonCast ?? []).slice(0, 4).length > 0
                          ? (character.canonCast ?? []).slice(0, 4)
                          : [character.name];
                void persistRoster(seed);
            }
            if (!conversation.sceneStyle) {
                setSceneStyle(
                    conversation.id,
                    style === 'composed-turns' && enableDirectedSceneMode
                        ? 'composed-turns'
                        : 'turns'
                );
            }
            setSceneMode(conversation.id, true);
        } else {
            setSceneMode(conversation.id, false);
        }
    };

    const switchDirectedVersion = async (version: 1 | 2) => {
        try {
            const stored = await getStoryStateForBranch(conversation, messages);
            const anchor = messages[messages.length - 1];
            // The switch is a user revision of the branch state, like a roster edit: the
            // generated NPCs leave the stage for V1 (a V1 beat can no longer resurrect them)
            // and come back on stage for V2. Their private state is untouched either way.
            const commitPresence = async (next: StoryState) => {
                if (!stored || !anchor) return;
                const revision = createStoryStateRevision({
                    previous: stored,
                    next,
                    source: 'user',
                    anchorMessageId: anchor.id,
                });
                await commitStoryStateRevision(revision, anchor.id);
                useChatStore.getState().applyStoryStateRevision({
                    conversationId: conversation.id,
                    messageId: anchor.id,
                    storyStateRevisionId: revision.id,
                    roster: storyRoster(revision),
                });
            };
            const isGenerated = (id: string) =>
                stored?.characters?.[id]?.ref.source === 'generated';
            if (version === 1 && stored?.characters) {
                const generated = Object.values(stored.characters)
                    .filter((entry) => entry.ref.source === 'generated')
                    .map((entry) => entry.ref.displayName);
                const generatedNames = new Set(generated.map((name) => name.toLocaleLowerCase()));
                const kept = roster.filter((name) => !generatedNames.has(name.toLocaleLowerCase()));
                if (kept.length !== roster.length) {
                    const { addNotification, updateNotification } = useNotificationStore.getState();
                    const id = addNotification('Directeur V1', 'world');
                    updateNotification(
                        id,
                        'success',
                        `${roster.length - kept.length} PNJ généré(s) retiré(s) de la scène (${generated.join(', ')}). Leur état est conservé et revient avec la V2.`
                    );
                }
                if (anchor) {
                    await commitPresence({
                        ...stored,
                        scene: {
                            ...stored.scene,
                            participants: stored.scene.participants.map((participant) =>
                                isGenerated(participant.character.id)
                                    ? { ...participant, presence: 'offstage' as const }
                                    : participant
                            ),
                        },
                    });
                } else {
                    setSceneRoster(conversation.id, kept);
                }
            } else if (version === 2 && stored) {
                if (anchor) {
                    await commitPresence({
                        ...stored,
                        scene: {
                            ...stored.scene,
                            participants: stored.scene.participants.map((participant) =>
                                isGenerated(participant.character.id) &&
                                stored.characters?.[participant.character.id]?.status !== 'retired'
                                    ? { ...participant, presence: 'onstage' as const }
                                    : participant
                            ),
                        },
                    });
                } else {
                    setSceneRoster(conversation.id, storyRoster(stored));
                }
            }
            setDirectedNarrativeVersion(conversation.id, version);
            setSceneStyle(conversation.id, 'composed-turns');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Bascule impossible.';
            const { addNotification, updateNotification } = useNotificationStore.getState();
            const id = addNotification('Impossible de changer de directeur', 'world');
            updateNotification(id, 'error', message);
        }
    };

    const enableV2 = () => {
        // Scene mode first so the version switch persists onto an active scene; the switch
        // itself sets the version, the style and restores the branch roster.
        setSceneMode(conversation.id, true);
        void switchDirectedVersion(2);
    };

    const removeFromRoster = (name: string) => {
        void persistRoster(roster.filter((n) => n !== name));
    };

    const addToRoster = (name: string) => {
        const clean = name.trim();
        if (clean && !roster.some((n) => n.toLowerCase() === clean.toLowerCase())) {
            void persistRoster([...roster, clean]);
        }
        setNewName('');
        setShowAdd(false);
    };

    return (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/40 bg-card/30 flex-wrap">
            <Button
                variant={sceneOn ? 'default' : 'ghost'}
                size="sm"
                className="h-7 gap-1.5 text-xs shrink-0"
                onClick={() => toggleScene()}
                title="Mode Troupe : narrateur IA + une réponse par personnage en scène"
            >
                <Clapperboard className="w-3.5 h-3.5" />
                Troupe
            </Button>

            {!sceneOn && enableDirectedSceneMode && (
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={enableV2}
                    title="Activer le Directeur narratif V2 expérimental, y compris sans PNJ"
                >
                    Directeur V2
                </Button>
            )}

            {showSuggestion && (
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-[11px]">
                    <span className="truncate">
                        Scène multi détectée : {suggestedCast.slice(0, 3).join(', ')}
                    </span>
                    <button
                        className="font-medium text-primary hover:underline"
                        onClick={() => toggleScene('composed-turns')}
                    >
                        Activer Tours dirigés
                    </button>
                    <button
                        className="text-muted-foreground hover:text-foreground"
                        title="Ne plus proposer pour cette conversation"
                        onClick={() => setDirectedSceneSuggestionDismissed(conversation.id, true)}
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            )}

            {sceneOn && (
                <>
                    {conversation.sceneStyle === 'composed-turns' && enableDirectedSceneMode && (
                        <span className="rounded border border-border/50 px-2 py-0.5 text-[10px] text-muted-foreground">
                            {conversation.directedNarrativeVersion === 2
                                ? soloScene
                                    ? 'Solo · monde actif'
                                    : 'Ensemble · V2'
                                : 'Dirigé V1'}
                        </span>
                    )}
                    {/* Rendering style: historical, directed atomic, or unified passage. */}
                    <div className="inline-flex rounded-md border border-border/50 overflow-hidden shrink-0">
                        {enableDirectedSceneMode && (
                            <>
                                <button
                                    onClick={() => {
                                        void switchDirectedVersion(1);
                                    }}
                                    className={`px-2 h-6 pointer-coarse:h-9 pointer-coarse:px-3 text-[10px] font-medium transition-colors ${
                                        conversation.sceneStyle === 'composed-turns' &&
                                        conversation.directedNarrativeVersion !== 2
                                            ? 'bg-primary/15 text-primary'
                                            : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                    title="Pipeline dirigé existant"
                                >
                                    Dirigé V1
                                </button>
                                <button
                                    onClick={() => {
                                        void switchDirectedVersion(2);
                                    }}
                                    className={`px-2 h-6 pointer-coarse:h-9 pointer-coarse:px-3 text-[10px] font-medium transition-colors ${
                                        conversation.sceneStyle === 'composed-turns' &&
                                        conversation.directedNarrativeVersion === 2
                                            ? 'bg-primary/15 text-primary'
                                            : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                    title="Scènes solo, autonomie persistante et arc multi-tours"
                                >
                                    Directeur V2
                                </button>
                            </>
                        )}
                        <button
                            onClick={() => setSceneStyle(conversation.id, 'turns')}
                            className={`px-2 h-6 pointer-coarse:h-9 pointer-coarse:px-3 text-[10px] font-medium transition-colors ${
                                (conversation.sceneStyle ?? 'turns') === 'turns'
                                    ? 'bg-primary/15 text-primary'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                            title="Mode historique : une génération séquentielle par personnage"
                        >
                            Tours classiques
                        </button>
                        <button
                            onClick={() => setSceneStyle(conversation.id, 'unified')}
                            className={`px-2 h-6 pointer-coarse:h-9 pointer-coarse:px-3 text-[10px] font-medium transition-colors ${
                                conversation.sceneStyle === 'unified'
                                    ? 'bg-primary/15 text-primary'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                            title="Un seul message fluide qui entrelace narration et répliques (moins cher)"
                        >
                            Unifiée
                        </button>
                    </div>

                    <StoryStatePanel
                        conversation={conversation}
                        character={character}
                        messages={messages}
                        trigger={
                            <button
                                className="inline-flex h-6 pointer-coarse:h-9 items-center gap-1 px-2 pointer-coarse:px-3 text-[10px] text-muted-foreground hover:text-foreground"
                                title="État de la scène et direction de l’intrigue"
                            >
                                <BookOpen className="h-3 w-3" /> Intrigue
                            </button>
                        }
                    />

                    {roster.map((name) => (
                        <span
                            key={name}
                            className="inline-flex items-center gap-1 px-2 h-6 pointer-coarse:h-9 rounded-full bg-primary/10 text-primary text-[11px]"
                        >
                            {name}
                            <button
                                onClick={() => removeFromRoster(name)}
                                className="hover:text-destructive pointer-coarse:p-2 pointer-coarse:-m-1"
                                title={`Retirer ${name} de la scène`}
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}

                    {showAdd ? (
                        <span className="relative inline-block">
                            <Input
                                autoFocus
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        // Enter picks the top suggestion (typo-proof) when
                                        // one matches, else the raw text.
                                        addToRoster(suggestions[0] ?? newName);
                                    }
                                    if (e.key === 'Escape') setShowAdd(false);
                                }}
                                onBlur={() => {
                                    // Delay so a suggestion mousedown can win over blur.
                                    setTimeout(() => setShowAdd(false), 150);
                                }}
                                placeholder="Nom…"
                                className="h-6 pointer-coarse:h-9 w-32 text-[11px] px-2"
                            />
                            {suggestions.length > 0 && (
                                <div className="absolute bottom-full left-0 mb-1 z-50 min-w-40 rounded-lg border border-border/60 bg-popover shadow-xl overflow-hidden">
                                    {suggestions.map((name) => (
                                        <button
                                            key={name}
                                            // mousedown (not click) so it fires before the
                                            // input's blur closes the list.
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                addToRoster(name);
                                            }}
                                            className="block w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-primary/10 hover:text-primary"
                                        >
                                            {name}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </span>
                    ) : (
                        <button
                            onClick={() => setShowAdd(true)}
                            className="text-[11px] text-muted-foreground hover:text-foreground px-1 pointer-coarse:h-9 pointer-coarse:px-3"
                        >
                            + ajouter
                        </button>
                    )}

                    <div className="flex-1" />
                    {sceneProgress && sceneProgress.status !== 'committed' && (
                        <span
                            className={`inline-flex items-center gap-1.5 text-[10px] ${
                                sceneProgress.status === 'failed' ||
                                sceneProgress.status === 'awaiting-profile'
                                    ? 'text-destructive'
                                    : 'text-muted-foreground'
                            }`}
                            title={sceneProgress.error}
                        >
                            {sceneProgress.status === 'failed' ||
                            sceneProgress.status === 'awaiting-profile' ? (
                                <AlertTriangle className="h-3 w-3" />
                            ) : (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            {sceneProgress.status === 'directing' && 'Directeur'}
                            {sceneProgress.status === 'reflecting' &&
                                `Réflexions ${sceneProgress.completedReflections}/${sceneProgress.totalReflections}`}
                            {sceneProgress.status === 'composing' && 'Composition'}
                            {sceneProgress.status === 'validating' && 'Validation'}
                            {sceneProgress.status === 'failed' && 'Beat interrompu'}
                            {sceneProgress.status === 'awaiting-profile' &&
                                'Choix de profil requis'}
                            {sceneProgress.status === 'cancelled' && 'Annulé'}
                        </span>
                    )}
                    {lastSceneBeat && (
                        <Dialog>
                            <DialogTrigger asChild>
                                <button
                                    type="button"
                                    className="inline-flex h-7 pointer-coarse:h-9 items-center gap-1 px-2 pointer-coarse:px-3 text-[10px] text-muted-foreground hover:text-foreground"
                                >
                                    <Brain className="h-3.5 w-3.5" /> Coulisses
                                    {lastSceneBeat.status === 'committed' &&
                                        (lastSceneBeat.audit?.status === 'warning' ||
                                        (lastSceneBeat.audit?.status === 'skipped' &&
                                            lastSceneBeat.audit.issues.length > 0) ? (
                                            <AlertTriangle className="h-3 w-3 text-amber-500" />
                                        ) : (
                                            <Check className="h-3 w-3 text-emerald-500" />
                                        ))}
                                </button>
                            </DialogTrigger>
                            {/* A centred, fixed dialog, not an absolutely-placed panel: on a phone
                                the trigger wraps to the left edge and a right-anchored panel used
                                to extend 200 px off-screen. The dialog is sized by the viewport
                                alone and scrolls inside itself. */}
                            <DialogContent className="block max-h-[85vh] w-[min(32rem,calc(100%-1rem))] max-w-none overflow-y-auto p-3 text-xs sm:max-w-[32rem] space-y-3">
                                <DialogTitle className="sr-only">Coulisses du beat</DialogTitle>
                                <div className="flex items-center justify-between gap-2 pr-8">
                                    <strong>Beat {lastSceneBeat.status}</strong>
                                    <span className="text-muted-foreground">
                                        {lastSceneBeat.backgroundRoute?.provider} /{' '}
                                        {lastSceneBeat.backgroundRoute?.model}
                                    </span>
                                </div>
                                {lastSceneBeat.decision?.sceneGoal && (
                                    <p>
                                        <span className="text-muted-foreground">Objectif :</span>{' '}
                                        {lastSceneBeat.decision.sceneGoal}
                                    </p>
                                )}
                                {lastSceneBeat.audit && (
                                    <div className="rounded-md border border-border/50 p-2">
                                        <div className="font-medium">
                                            Audit · {lastSceneBeat.audit.status}
                                            {lastSceneBeat.audit.rewritten ? ' · réécrit' : ''}
                                        </div>
                                        {lastSceneBeat.audit.issues.map((issue) => (
                                            <p
                                                key={`${issue.code}:${issue.message}`}
                                                className={
                                                    issue.severity === 'hard'
                                                        ? 'text-destructive'
                                                        : 'text-muted-foreground'
                                                }
                                            >
                                                {issue.code} — {issue.message}
                                            </p>
                                        ))}
                                    </div>
                                )}
                                {lastSceneBeat.decision?.participants.map((participant) => (
                                    <div
                                        key={participant.characterRefId}
                                        className="rounded-md bg-muted/30 p-2"
                                    >
                                        <div className="font-medium">
                                            {participant.name} · {participant.mode} ·{' '}
                                            {participant.attention}
                                        </div>
                                        <div className="text-muted-foreground">
                                            {participant.reason}
                                        </div>
                                        {participant.direction && (
                                            <div>{participant.direction}</div>
                                        )}
                                        {lastSceneBeat.intents.find(
                                            (intent) =>
                                                intent.characterRefId === participant.characterRefId
                                        ) && (
                                            <div className="mt-1 border-t border-border/40 pt-1 text-muted-foreground">
                                                <div>
                                                    Émotion :{' '}
                                                    {
                                                        lastSceneBeat.intents.find(
                                                            (intent) =>
                                                                intent.characterRefId ===
                                                                participant.characterRefId
                                                        )?.emotion
                                                    }
                                                </div>
                                                <div>
                                                    But privé :{' '}
                                                    {
                                                        lastSceneBeat.intents.find(
                                                            (intent) =>
                                                                intent.characterRefId ===
                                                                participant.characterRefId
                                                        )?.privateGoal
                                                    }
                                                </div>
                                                <div>
                                                    Action/parole :{' '}
                                                    {
                                                        lastSceneBeat.intents.find(
                                                            (intent) =>
                                                                intent.characterRefId ===
                                                                participant.characterRefId
                                                        )?.observableAction
                                                    }{' '}
                                                    —{' '}
                                                    {
                                                        lastSceneBeat.intents.find(
                                                            (intent) =>
                                                                intent.characterRefId ===
                                                                participant.characterRefId
                                                        )?.speechIntent
                                                    }
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {lastSceneBeat.profileAmbiguity && (
                                    <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
                                        <div className="font-medium text-amber-700 dark:text-amber-300">
                                            Quel profil représente «{' '}
                                            {lastSceneBeat.profileAmbiguity.name} » ?
                                        </div>
                                        <div className="grid gap-1.5">
                                            {lastSceneBeat.profileAmbiguity.candidates.map(
                                                (candidate) => (
                                                    <Button
                                                        key={candidate.id}
                                                        size="sm"
                                                        variant="secondary"
                                                        className="h-auto justify-start py-1.5 text-left"
                                                        onClick={() => {
                                                            setSceneCharacterOverride(
                                                                conversation.id,
                                                                lastSceneBeat.profileAmbiguity!
                                                                    .name,
                                                                candidate
                                                            );
                                                            onRetrySceneBeat?.();
                                                        }}
                                                    >
                                                        <span>
                                                            {candidate.displayName}
                                                            <span className="ml-1 text-[10px] text-muted-foreground">
                                                                {candidate.source} ·{' '}
                                                                {candidate.sourceId}
                                                            </span>
                                                        </span>
                                                    </Button>
                                                )
                                            )}
                                        </div>
                                    </div>
                                )}
                                {lastSceneBeat.errors.map((error, index) => (
                                    <div
                                        key={`${error.stage}-${index}`}
                                        className="text-destructive"
                                    >
                                        {error.stage} : {error.message}
                                    </div>
                                ))}
                                {(lastSceneBeat.status === 'failed' ||
                                    lastSceneBeat.status === 'interrupted') &&
                                    onRetrySceneBeat && (
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            className="w-full"
                                            onClick={onRetrySceneBeat}
                                        >
                                            Réessayer le beat
                                        </Button>
                                    )}
                                {!!lastSceneBeat.usage?.agents?.length && (
                                    <div className="space-y-0.5 border-t border-border/40 pt-1 text-[10px] text-muted-foreground">
                                        <div className="font-medium text-foreground/80">
                                            Consommation par agent
                                        </div>
                                        {lastSceneBeat.usage.agents.map((entry, index) => (
                                            <div
                                                key={`${entry.agent}-${entry.name ?? index}`}
                                                className="flex justify-between gap-2"
                                            >
                                                <span className="truncate">
                                                    {AGENT_LABELS[entry.agent] ?? entry.agent}
                                                    {entry.name ? ` · ${entry.name}` : ''}
                                                    {entry.estimated ? ' (estimé)' : ''}
                                                </span>
                                                <span className="shrink-0 font-mono">
                                                    {(entry.promptTokens ?? 0).toLocaleString(
                                                        'fr-FR'
                                                    )}
                                                    {' + '}
                                                    {(entry.completionTokens ?? 0).toLocaleString(
                                                        'fr-FR'
                                                    )}
                                                </span>
                                            </div>
                                        ))}
                                        <div className="flex justify-between gap-2 font-medium text-foreground/80">
                                            <span>Total</span>
                                            <span className="shrink-0 font-mono">
                                                {lastSceneBeat.usage.agents
                                                    .reduce(
                                                        (sum, entry) =>
                                                            sum +
                                                            (entry.promptTokens ?? 0) +
                                                            (entry.completionTokens ?? 0),
                                                        0
                                                    )
                                                    .toLocaleString('fr-FR')}{' '}
                                                tokens
                                            </span>
                                        </div>
                                    </div>
                                )}
                                {!!lastSceneBeat.contextDivergence?.length && (
                                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] text-amber-700 dark:text-amber-300">
                                        Contexte non identique entre agents :{' '}
                                        {lastSceneBeat.contextDivergence[0]}
                                    </div>
                                )}
                                <div className="text-[10px] text-muted-foreground">
                                    Directeur {lastSceneBeat.timings.director ?? 0} ms · réflexions{' '}
                                    {lastSceneBeat.timings.reflections ?? 0} ms · compositeur{' '}
                                    {lastSceneBeat.timings.composer ?? 0} ms
                                    {lastSceneBeat.usage?.estimatedInputTokens
                                        ? ` · ~${lastSceneBeat.usage.estimatedInputTokens.toLocaleString('fr-FR')} tokens d’entrée estimés`
                                        : ''}
                                </div>
                            </DialogContent>
                        </Dialog>
                    )}
                    <Button
                        variant="secondary"
                        size="sm"
                        className="h-7 gap-1.5 text-xs shrink-0 max-sm:w-full max-sm:h-9"
                        disabled={
                            isSceneRunning ||
                            (roster.length === 0 &&
                                !(
                                    conversation.directedNarrativeVersion === 2 &&
                                    conversation.sceneStyle === 'composed-turns' &&
                                    enableDirectedSceneMode
                                ))
                        }
                        onClick={onAdvanceScene}
                        title={
                            conversation.directedNarrativeVersion === 2 && roster.length === 0
                                ? 'Le monde prend l’initiative sans décider pour votre personnage'
                                : 'Le narrateur fait avancer la scène sans message du joueur'
                        }
                    >
                        {isSceneRunning ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Play className="w-3.5 h-3.5" />
                        )}
                        Faire avancer la scène
                    </Button>
                </>
            )}
        </div>
    );
}
