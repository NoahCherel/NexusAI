/**
 * Directed-beat orchestrator: Director → parallel reflections → Composer → validation →
 * atomic commit.
 *
 * Pure with respect to the app: every side effect (model calls, IndexedDB, store, UI
 * progress) comes in through `DirectedBeatDeps`, so the exact state machine that runs in
 * the chat hook can be replayed under Vitest with scripted models and injected faults —
 * a failed worker, a Stop press mid-composition, a branch switch, an exhausted quota, a
 * reload. The hook (`useChatGeneration`) only wires the real dependencies and reacts to
 * the returned outcome.
 *
 * Invariant enforced here: nothing visible is produced unless the outcome is
 * `committed`, and `committed` is reached only through `deps.commitBeat` (one IndexedDB
 * transaction). Observed user facts are the deliberate exception: they are committed to
 * the trigger message before any character work, so they survive a later failure.
 */

import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type {
    BackgroundRouteSnapshot,
    CharacterRef,
    SceneBeatRecord,
    SceneGenerationProgress,
    SceneProfileAmbiguity,
    SceneTransition,
    StoryState,
} from '@/types/scene';
import {
    assertNoPrivateIntentLeak,
    compositionContract,
    DirectedSceneError,
    directSceneBeat,
    filterVisiblePlannedTransitions,
    parseCompositionResult,
    reflectCharacter,
    runCharacterReflections,
    selectReflectionTargets,
} from '@/lib/ai/directed-scene';
import {
    AmbiguousCharacterError,
    applyStoryTransitions,
    createInitialStoryState,
    createStoryStateRevision,
    reconcileStoryStateRoster,
    storyRoster,
    type ResolvedCharacterProfile,
} from '@/lib/ai/story-state';
import { nameMatchesText } from '@/lib/ai/canon-context';

export interface ComposerReply {
    content: string;
    usage?: { promptTokens?: number; completionTokens?: number };
}

export interface DirectedBeatDeps {
    /** Frozen provider/model for every invisible agent of this beat. */
    resolveRoute: () => Promise<BackgroundRouteSnapshot | null>;
    loadStoredState: (
        conversation: Conversation,
        beatHistory: Message[]
    ) => Promise<StoryState | undefined>;
    loadState: (revisionId: string) => Promise<StoryState | undefined>;
    resolveCharacters: (
        roster: Array<string | CharacterRef>,
        character: CharacterCard,
        overrides?: Record<string, CharacterRef>
    ) => Promise<ResolvedCharacterProfile[]>;
    resolveEntryCandidates: (character: CharacterCard) => Promise<ResolvedCharacterProfile[]>;
    direct: typeof directSceneBeat;
    reflect?: typeof reflectCharacter;
    /** The visible RP model. Must buffer: nothing reaches the transcript from here. */
    compose: (params: {
        contract: string;
        history: Message[];
        signal: AbortSignal;
    }) => Promise<ComposerReply | null>;
    /** Remaining NanoGPT subscription tokens, or null when unknown / not token-metered. */
    fetchRemainingTokens?: () => Promise<number | null>;
    persistBeat: (record: SceneBeatRecord) => Promise<void>;
    /** Attach an observed revision to the trigger message (DB + store). */
    commitObservedState: (state: StoryState, anchorMessageId: string) => Promise<void>;
    /** The single all-or-nothing transaction. */
    commitBeat: (params: {
        beat: SceneBeatRecord;
        storyState: StoryState;
        messages: Message[];
    }) => Promise<void>;
    /** Throws an AbortError when the beat no longer belongs to the visible branch. */
    assertCurrent?: () => void;
    onProgress?: (progress: SceneGenerationProgress) => void;
    now?: () => number;
    newId?: () => string;
}

export interface DirectedBeatInput {
    conversation: Conversation;
    character: CharacterCard;
    /** Active-branch messages up to and including the trigger. */
    beatHistory: Message[];
    userName: string;
    retrySource?: SceneBeatRecord;
    preferStoredRoster?: boolean;
    maxSpeakers: number;
    reflectionConcurrency: number;
    /** Visible RP route, recorded for the Coulisses and the quota estimate. */
    composer: { provider: string; model: string };
    signal: AbortSignal;
}

export type DirectedBeatOutcome =
    | {
          kind: 'committed';
          record: SceneBeatRecord;
          state: StoryState;
          messages: Message[];
          speakerNames: string[];
          beatContent: string;
      }
    | { kind: 'awaiting-profile'; record: SceneBeatRecord; ambiguity: SceneProfileAmbiguity }
    | { kind: 'cancelled'; record: SceneBeatRecord; error: unknown }
    | { kind: 'failed'; record: SceneBeatRecord; error: unknown };

export const MAX_DIRECTOR_PROFILES = 40;

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

function mentionsName(profile: ResolvedCharacterProfile, lowerText: string): boolean {
    return [profile.ref.displayName, ...(profile.ref.aliases ?? [])].some((name) =>
        nameMatchesText(name, lowerText)
    );
}

/**
 * Offstage cards/dossiers the Director may admit this beat. Whole-word matching on the
 * latest message and the plot fields; a bare "A" or "Al" never matches half of "Alice".
 */
export function selectEntryCandidates(
    candidates: ResolvedCharacterProfile[],
    latestUserMessage: Message,
    storedState: StoryState | undefined
): ResolvedCharacterProfile[] {
    const entryCue = [
        latestUserMessage.content,
        storedState?.plot.objective,
        storedState?.plot.currentBeat,
        ...(storedState?.plot.openThreads ?? []),
        ...(storedState?.plot.nextMoves ?? []),
    ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
    const currentBeat = (storedState?.plot.currentBeat ?? '').toLocaleLowerCase();
    return candidates.filter(
        (profile) =>
            mentionsName(profile, entryCue) ||
            (!!currentBeat &&
                !!profile.canon?.appearsInArcs?.some(
                    (arc) => arc.trim() && currentBeat.includes(arc.toLocaleLowerCase())
                ))
    );
}

export async function executeDirectedBeat(
    input: DirectedBeatInput,
    deps: DirectedBeatDeps
): Promise<DirectedBeatOutcome> {
    const now = deps.now ?? (() => Date.now());
    const newId = deps.newId ?? (() => crypto.randomUUID());
    const { conversation, character, beatHistory, userName, retrySource, signal } = input;
    const triggerMessage = beatHistory[beatHistory.length - 1];
    const latestUserMessage =
        [...beatHistory].reverse().find((message) => message.role === 'user') ?? triggerMessage;
    const beatId = retrySource?.id ?? newId();
    const startedAt = now();

    let record: SceneBeatRecord = {
        ...retrySource,
        id: beatId,
        conversationId: conversation.id,
        triggerMessageId: triggerMessage.id,
        branchTipId: triggerMessage.id,
        generationId: newId(),
        status: 'directing',
        intents: retrySource?.intents ?? [],
        outputMessageIds: [],
        errors: [],
        profileAmbiguity: undefined,
        timings: {},
        createdAt: startedAt,
        updatedAt: startedAt,
    };
    let progress: SceneGenerationProgress = {
        beatId,
        status: 'directing',
        completedReflections: 0,
        totalReflections: 0,
    };

    const report = (patch: Partial<SceneGenerationProgress>) => {
        progress = { ...progress, ...patch, status: patch.status ?? record.status };
        deps.onProgress?.(progress);
    };
    const persist = async (patch: Partial<SceneBeatRecord>, error?: string) => {
        record = { ...record, ...patch, updatedAt: now() };
        await deps.persistBeat(record);
        report({ status: record.status, error });
    };
    const assertCurrent = () => {
        if (signal.aborted) throw new DOMException('Beat annulé.', 'AbortError');
        deps.assertCurrent?.();
    };

    try {
        await persist({ status: 'directing' });
        const route = retrySource?.backgroundRoute ?? (await deps.resolveRoute());
        if (!route) {
            throw new DirectedSceneError(
                'Aucune route background utilisable. Vérifiez la clé et le modèle sélectionnés.',
                'route',
                false
            );
        }
        record.backgroundRoute = route;

        const storedState = await deps.loadStoredState(conversation, beatHistory);
        const effectiveRoster: Array<string | CharacterRef> =
            input.preferStoredRoster && storedState
                ? storedState.scene.participants
                      .filter((participant) => participant.presence !== 'offstage')
                      .map((participant) => participant.character)
                : (conversation.sceneRoster ?? []);
        const overrides = conversation.sceneCharacterOverrides;
        const activeProfiles = await deps.resolveCharacters(effectiveRoster, character, overrides);
        const entryCandidates = selectEntryCandidates(
            await deps.resolveEntryCandidates(character),
            latestUserMessage,
            storedState
        );
        const resolvedProfiles = await deps.resolveCharacters(
            [
                ...effectiveRoster,
                ...(storedState?.scene.participants.map((participant) => participant.character) ??
                    []),
            ],
            character,
            overrides
        );
        const latestLower = latestUserMessage.content.toLocaleLowerCase();
        const profiles = Array.from(
            new Map(
                [...resolvedProfiles, ...entryCandidates]
                    .sort(
                        (left, right) =>
                            Number(mentionsName(right, latestLower)) -
                            Number(mentionsName(left, latestLower))
                    )
                    .slice(0, MAX_DIRECTOR_PROFILES)
                    .map((profile) => [profile.ref.id, profile] as const)
            ).values()
        );
        const knownRefs = profiles.map((profile) => profile.ref);
        const baseState = reconcileStoryStateRoster(
            storedState ??
                createInitialStoryState({
                    conversation,
                    profiles: activeProfiles,
                    anchorMessageId: triggerMessage.id,
                }),
            activeProfiles
        );
        record.baseStoryStateRevisionId = storedState?.id;

        const directorStartedAt = now();
        const decision =
            retrySource?.decision ??
            (await deps.direct({
                state: baseState,
                profiles,
                recentMessages: beatHistory,
                userName,
                relationships: conversation.relationships,
                maxSpeakers: input.maxSpeakers,
                route,
                signal,
            }));
        assertCurrent();
        record.timings.director = now() - directorStartedAt;

        // User-authored facts commit before any character/composer work. A brand-new state
        // keeps revision 1; otherwise an immutable child revision is created.
        const cachedObservedState = retrySource?.observedStoryStateRevisionId
            ? await deps.loadState(retrySource.observedStoryStateRevisionId)
            : undefined;
        const observedNext = applyStoryTransitions(
            baseState,
            decision.observedTransitions,
            knownRefs
        );
        const observedState: StoryState =
            cachedObservedState ??
            (storedState
                ? createStoryStateRevision({
                      previous: storedState,
                      next: observedNext,
                      source: 'observed',
                      anchorMessageId: triggerMessage.id,
                      sourceBeatId: beatId,
                  })
                : {
                      ...observedNext,
                      source: 'observed',
                      anchorMessageId: triggerMessage.id,
                      sourceBeatId: beatId,
                  });
        if (!cachedObservedState) {
            await deps.commitObservedState(observedState, triggerMessage.id);
        }
        record.observedStoryStateRevisionId = observedState.id;

        const plannedEntranceIds = new Set(
            decision.plannedTransitions
                .filter((transition) => transition.type === 'enter')
                .map((transition) => transition.characterRefId)
                .filter((id): id is string => !!id)
        );
        const allowedParticipants = decision.participants.filter((participant) => {
            const stateParticipant = observedState.scene.participants.find(
                (candidate) => candidate.character.id === participant.characterRefId
            );
            if (!stateParticipant) {
                return (
                    plannedEntranceIds.has(participant.characterRefId) &&
                    profiles.find((profile) => profile.ref.id === participant.characterRefId)?.ref
                        .readiness === 'ready'
                );
            }
            return (
                stateParticipant.agency !== 'none' &&
                (stateParticipant.presence !== 'offstage' ||
                    plannedEntranceIds.has(participant.characterRefId))
            );
        });
        decision.participants = allowedParticipants;
        await persist({ decision, status: 'reflecting' });

        // Characters reflect against the scene as it will look once planned entrances happen.
        const reflectionState = applyStoryTransitions(
            observedState,
            decision.plannedTransitions.filter((transition) => transition.type === 'enter'),
            knownRefs
        );

        const reflectionTargets = selectReflectionTargets(allowedParticipants, record.intents);
        const estimatedInputTokens =
            2_500 +
            reflectionTargets.reduce(
                (total, participant) => total + (participant.attention === 'full' ? 3_000 : 1_600),
                0
            ) +
            (input.composer.provider === 'nanogpt' ? 4_000 : 0);
        record.usage = { ...record.usage, estimatedInputTokens };
        if (
            (route.provider === 'nanogpt' || input.composer.provider === 'nanogpt') &&
            deps.fetchRemainingTokens
        ) {
            const remaining = await deps.fetchRemainingTokens();
            if (remaining != null && remaining < estimatedInputTokens) {
                throw new DirectedSceneError(
                    `Quota NanoGPT insuffisant : environ ${estimatedInputTokens.toLocaleString('fr-FR')} tokens d’entrée requis, ${remaining.toLocaleString('fr-FR')} restants.`,
                    'director',
                    false
                );
            }
        }
        report({
            status: 'reflecting',
            completedReflections: 0,
            totalReflections: reflectionTargets.length,
        });
        const reflectionStartedAt = now();
        const reflectionBatch = await runCharacterReflections({
            participants: allowedParticipants,
            profiles,
            existingIntents: record.intents,
            state: reflectionState,
            latestUserMessage,
            recentMessages: beatHistory,
            relationships: conversation.relationships,
            route,
            concurrency: input.reflectionConcurrency,
            signal,
            reflect: deps.reflect,
            onSettled: (completedReflections, totalReflections) =>
                report({ status: 'reflecting', completedReflections, totalReflections }),
        });
        assertCurrent();
        record.timings.reflections = now() - reflectionStartedAt;
        const intents = reflectionBatch.intents;
        record.intents = intents;
        if (reflectionBatch.failures.length > 0) {
            // Successful intents are kept on the record: "Réessayer" only re-runs the missing
            // workers. No composer call, no bubble.
            await persist({
                intents,
                status: 'failed',
                errors: [
                    ...record.errors,
                    ...reflectionBatch.failures.map((failure) => ({
                        stage: 'reflection' as const,
                        message:
                            failure.reason instanceof Error
                                ? failure.reason.message
                                : 'Réflexion interrompue.',
                        characterRefId: failure.participant.characterRefId,
                        retryable: true,
                    })),
                ],
            });
            throw new DirectedSceneError(
                'Au moins une réflexion a échoué. Les réflexions réussies ont été conservées.',
                'reflection'
            );
        }

        await persist({ intents, status: 'composing' });
        const contract = compositionContract({
            decision,
            intents,
            userName,
            knowledge: observedState.knowledge,
        });
        const composerStartedAt = now();
        let composerResult = await deps.compose({ contract, history: beatHistory, signal });
        if (!composerResult) {
            throw new DirectedSceneError('Le compositeur n’a pas répondu.', 'composer');
        }
        assertCurrent();
        record.composerRoute = {
            provider: input.composer.provider,
            model: input.composer.model,
            billingScope: input.composer.provider === 'nanogpt' ? 'subscription' : 'default',
        };
        record.timings.composer = now() - composerStartedAt;
        await persist({ status: 'validating' });

        let composition;
        try {
            composition = parseCompositionResult(composerResult.content, allowedParticipants);
            assertNoPrivateIntentLeak(composition, intents, observedState.knowledge);
        } catch (firstError) {
            // Exactly one correction, same model. A second failure leaves the beat failed.
            const correction = `${contract}\n\n[CORRECTION] Your previous output was invalid: ${
                firstError instanceof Error ? firstError.message : 'invalid JSON'
            }. Return the corrected JSON object only. Previous output:\n${composerResult.content.slice(0, 3_000)}`;
            composerResult = await deps.compose({
                contract: correction,
                history: beatHistory,
                signal,
            });
            if (!composerResult) {
                throw new DirectedSceneError('La correction du compositeur a échoué.', 'composer');
            }
            composition = parseCompositionResult(composerResult.content, allowedParticipants);
            assertNoPrivateIntentLeak(composition, intents, observedState.knowledge);
        }
        assertCurrent();
        record.usage = {
            ...record.usage,
            promptTokens: composerResult.usage?.promptTokens,
            completionTokens: composerResult.usage?.completionTokens,
        };

        const outputMessages: Message[] = [];
        let parentId: string | null = triggerMessage.id;
        let messageOrder = triggerMessage.messageOrder + 1;
        let turnIndex = 0;
        if (composition.narration) {
            const message: Message = {
                id: newId(),
                conversationId: conversation.id,
                parentId,
                role: 'assistant',
                content: composition.narration,
                isActiveBranch: true,
                createdAt: new Date(now()),
                messageOrder: messageOrder++,
                regenerationIndex: 0,
                speaker: { kind: 'narrator', name: 'Narrateur' },
                sceneBeatId: beatId,
                sceneTurnIndex: turnIndex++,
            };
            outputMessages.push(message);
            parentId = message.id;
        }
        for (const turn of composition.turns) {
            const profile = profiles.find((candidate) => candidate.ref.id === turn.characterRefId);
            if (!profile) continue;
            const message: Message = {
                id: newId(),
                conversationId: conversation.id,
                parentId,
                role: 'assistant',
                content: turn.text,
                isActiveBranch: true,
                createdAt: new Date(now()),
                messageOrder: messageOrder++,
                regenerationIndex: 0,
                speaker: { kind: 'character', name: profile.ref.displayName },
                characterRef: profile.ref,
                sceneBeatId: beatId,
                sceneTurnIndex: turnIndex++,
            };
            outputMessages.push(message);
            parentId = message.id;
        }
        if (outputMessages.length === 0) {
            throw new DirectedSceneError('Aucune bulle valide à enregistrer.', 'validation');
        }

        // Director-planned effects need visible evidence; the composer's own effects describe
        // what it just wrote, whether that happened in narration or inside a character's turn.
        const generatedEffects: SceneTransition[] = [
            ...filterVisiblePlannedTransitions(decision.plannedTransitions, composition, profiles),
            ...(composition.effects ?? []),
            ...composition.turns.flatMap((turn) => turn.effects ?? []),
        ];
        const generatedNext = applyStoryTransitions(observedState, generatedEffects, knownRefs);
        const finalMessage = outputMessages[outputMessages.length - 1];
        const committedState = createStoryStateRevision({
            previous: observedState,
            next: generatedNext,
            source: 'generated',
            anchorMessageId: finalMessage.id,
            sourceBeatId: beatId,
        });
        finalMessage.storyStateRevisionId = committedState.id;

        const committedAt = now();
        record = {
            ...record,
            status: 'committed',
            branchTipId: finalMessage.id,
            composition,
            outputMessageIds: outputMessages.map((message) => message.id),
            committedStoryStateRevisionId: committedState.id,
            timings: {
                ...record.timings,
                validation: committedAt - composerStartedAt - (record.timings.composer ?? 0),
                total: committedAt - startedAt,
            },
            updatedAt: committedAt,
        };
        await deps.commitBeat({
            beat: record,
            storyState: committedState,
            messages: outputMessages,
        });
        report({
            status: 'committed',
            completedReflections: reflectionTargets.length,
            totalReflections: reflectionTargets.length,
        });

        const speakerNames = composition.turns
            .map(
                (turn) =>
                    profiles.find((profile) => profile.ref.id === turn.characterRefId)?.ref
                        .displayName
            )
            .filter((name): name is string => !!name);
        return {
            kind: 'committed',
            record,
            state: committedState,
            messages: outputMessages,
            speakerNames,
            beatContent: outputMessages
                .map((message) => `${message.speaker?.name ?? 'Narrateur'}: ${message.content}`)
                .join('\n'),
        };
    } catch (error) {
        if (error instanceof AmbiguousCharacterError) {
            const ambiguity = { name: error.characterName, candidates: error.candidates };
            await persist(
                {
                    status: 'awaiting-profile',
                    profileAmbiguity: ambiguity,
                    errors: [
                        ...record.errors,
                        { stage: 'director', message: error.message, retryable: true },
                    ],
                    timings: { ...record.timings, total: now() - startedAt },
                },
                'Choisissez le profil à utiliser pour reprendre ce beat.'
            );
            return { kind: 'awaiting-profile', record, ambiguity };
        }
        const aborted = isAbort(error);
        if (record.status !== 'failed' && record.status !== 'committed') {
            const stage =
                error instanceof DirectedSceneError
                    ? error.stage
                    : record.status === 'composing'
                      ? 'composer'
                      : record.status === 'validating'
                        ? 'validation'
                        : 'director';
            await persist(
                {
                    status: aborted ? 'cancelled' : 'failed',
                    errors: [
                        ...record.errors,
                        {
                            stage,
                            message:
                                error instanceof Error
                                    ? error.message
                                    : 'Erreur de scène inconnue.',
                            retryable:
                                error instanceof DirectedSceneError ? error.retryable : !aborted,
                        },
                    ],
                    timings: { ...record.timings, total: now() - startedAt },
                },
                error instanceof Error ? error.message : 'Erreur inconnue'
            );
        }
        return aborted ? { kind: 'cancelled', record, error } : { kind: 'failed', record, error };
    }
}

/** Roster projection shared by the hook and the tests. */
export { storyRoster };
