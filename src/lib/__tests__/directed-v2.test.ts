import { describe, expect, it } from 'vitest';
import type { CharacterCard, Conversation, Message, StoryState } from '@/types';
import {
    applyCharacterIntentDeltas,
    applyCommittedNarrativeProgress,
    applyStoryTransitions,
    createInitialStoryState,
    normalizeStoryState,
} from '@/lib/ai/story-state';
import { auditDirectedComposition } from '@/lib/ai/beat-auditor';
import { executeDirectedBeat, type DirectedBeatDeps } from '@/lib/ai/directed-beat';

const character: CharacterCard = {
    id: 'world',
    name: 'World',
    description: 'A setting card.',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
};

const conversation: Conversation = {
    id: 'conversation-v2',
    characterId: character.id,
    title: 'Solo V2',
    sceneMode: true,
    sceneStyle: 'composed-turns',
    directedNarrativeVersion: 2,
    sceneRoster: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

const trigger: Message = {
    id: 'trigger-v2',
    conversationId: conversation.id,
    parentId: null,
    role: 'user',
    content: 'J’attends dans le couloir.',
    isActiveBranch: true,
    createdAt: new Date(0),
    messageOrder: 1,
    regenerationIndex: 0,
};

describe('directed narrative V2', () => {
    it('lazily normalizes an empty solo state and transitions time', () => {
        const legacy = {
            id: 'legacy',
            conversationId: conversation.id,
            revision: 1,
            source: 'migration',
            scene: { participants: [] },
            plot: { openThreads: [], nextMoves: [] },
            locks: {},
            createdAt: 0,
        } satisfies StoryState;
        const normalized = normalizeStoryState(legacy);
        expect(normalized.scene.rhythm).toBe('adaptive');
        expect(normalized.scene.tone?.humor).toEqual([0, 4]);
        expect(normalized.plot.steps).toEqual([]);
        expect(
            applyStoryTransitions(normalized, [
                { origin: 'planned', type: 'time', value: 'minuit' },
            ]).scene.time
        ).toBe('minuit');
    });

    it('preserves goal inertia, respects locks and promotes a generated cameo', () => {
        const ref = {
            id: 'generated:iris',
            source: 'generated' as const,
            displayName: 'Iris',
            readiness: 'ready' as const,
        };
        let state = createInitialStoryState({ conversation, profiles: [] });
        state = {
            ...state,
            characters: {
                [ref.id]: {
                    ref,
                    commitments: ['Garder la porte'],
                    privateGoal: 'Trouver la clé',
                    status: 'cameo',
                    meaningfulAppearances: 1,
                },
            },
            locks: { [`/characters/${ref.id}/stance`]: true },
        };
        state = applyCharacterIntentDeltas(state, [
            {
                characterRefId: ref.id,
                name: 'Iris',
                attention: 'full',
                stateDelta: {
                    stance: 'Hostile',
                    privateGoal: 'Partir',
                    addCommitments: ['Prévenir la garde'],
                },
            },
        ]);
        expect(state.characters?.[ref.id].stance).toBeUndefined();
        expect(state.characters?.[ref.id].privateGoal).toBe('Trouver la clé');
        expect(state.characters?.[ref.id].commitments).toContain('Prévenir la garde');
        state = applyCommittedNarrativeProgress(state, {
            narration: 'Iris se découpe dans l’embrasure.',
            turns: [],
        });
        expect(state.characters?.[ref.id]).toMatchObject({
            meaningfulAppearances: 2,
            status: 'recurring',
        });
    });

    it('blocks player control but accepts a world-led narration-only beat', () => {
        const state = createInitialStoryState({ conversation, profiles: [] });
        const decision = {
            participants: [],
            observedTransitions: [],
            plannedTransitions: [],
            beatKind: 'initiative' as const,
            initiativeOwner: 'world',
            concreteChange: 'La porte se verrouille.',
        };
        expect(
            auditDirectedComposition({
                composition: { narration: 'La serrure claque derrière Noah.', turns: [] },
                decision,
                intents: [],
                state,
                solo: true,
                userName: 'Noah',
            }).status
        ).toBe('passed');
        expect(
            auditDirectedComposition({
                composition: { narration: 'Noah décide de courir.', turns: [] },
                decision,
                intents: [],
                state,
                solo: true,
                userName: 'Noah',
            }).issues
        ).toContainEqual(expect.objectContaining({ code: 'player-control', severity: 'hard' }));
    });

    it('executes an advance-scene solo beat without reflections or replayed observations', async () => {
        let reflectionCalls = 0;
        let committed: StoryState | undefined;
        const deps: DirectedBeatDeps = {
            resolveRoute: async () => ({
                provider: 'nanogpt',
                model: 'test',
                billingScope: 'subscription',
                routing: 'auto',
                resolvedAt: 0,
            }),
            loadStoredState: async () => undefined,
            loadState: async () => undefined,
            resolveCharacters: async () => [],
            resolveEntryCandidates: async () => [],
            buildAgentPayload: async ({ contract, frozenWindow }) => ({
                messages: [{ role: 'system', content: contract }],
                stablePrefixLength: 0,
                windowStartMessageId: frozenWindow?.startMessageId ?? trigger.id,
                includedMessageCount: 1,
                tokenBreakdown: {
                    system: 10,
                    rag: 0,
                    history: 10,
                    postHistory: 10,
                    total: 30,
                    dynamicReserve: 10,
                    historyBudget: 100,
                    historyTarget: 90,
                    historyHeadroom: 80,
                },
                historyWindow: { action: 'unchanged', reason: 'test', recoverableMessageCount: 0 },
            }),
            sampler: {
                temperature: 0.5,
                maxTokens: 100,
                enableReasoning: false,
                useFlexTier: false,
            },
            direct: async () => ({
                participants: [],
                observedTransitions: [
                    { origin: 'observed', type: 'location', value: 'ancien lieu' },
                ],
                plannedTransitions: [],
                beatKind: 'initiative',
                initiativeOwner: 'world',
                concreteChange: 'La lumière s’éteint.',
                playerFrame: { perceptions: ['un déclic'], externalPressures: [], affordances: [] },
            }),
            reflect: async () => {
                reflectionCalls++;
                throw new Error('solo reflections must not run');
            },
            compose: async () => ({
                content: JSON.stringify({
                    narration: 'La lumière s’éteint. Un déclic résonne dans le couloir.',
                    turns: [],
                    effects: [{ type: 'time', value: 'plus tard' }],
                }),
            }),
            persistBeat: async () => undefined,
            commitObservedState: async () => {
                throw new Error('advance-scene must not commit old observations');
            },
            commitBeat: async ({ storyState }) => {
                committed = storyState;
            },
        };
        const outcome = await executeDirectedBeat(
            {
                conversation,
                character,
                beatHistory: [trigger],
                userName: 'Noah',
                maxSpeakers: 5,
                reflectionConcurrency: 4,
                composer: { provider: 'openrouter', model: 'test' },
                signal: new AbortController().signal,
                triggerKind: 'advance-scene',
            },
            deps
        );
        expect(outcome.kind).toBe('committed');
        expect(reflectionCalls).toBe(0);
        expect(committed?.scene.location).toBeUndefined();
        expect(committed?.scene.time).toBe('plus tard');
    });
});
