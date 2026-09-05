/** Second independent review of the V2 tree: planner cadence, canon compass, redaction, parsing. */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { CharacterCard, Conversation, Message, SceneBeatRecord, StoryState } from '@/types';
import { planningDue } from '@/lib/ai/narrative-maintenance';
import { parseDirectedDecision, parseSceneJson } from '@/lib/ai/directed-scene';
import {
    createInitialStoryState,
    getStoryStateForBranch,
    type ResolvedCharacterProfile,
} from '@/lib/ai/story-state';
import { executeDirectedBeat, type DirectedBeatDeps } from '@/lib/ai/directed-beat';
import { redactSceneBeatForSharing, redactStoryStateForSharing } from '@/lib/conversation-transfer';
import { saveStoryState } from '@/lib/db';

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
    id: 'conversation-review2',
    characterId: character.id,
    title: 'Review 2',
    sceneMode: true,
    sceneStyle: 'composed-turns',
    directedNarrativeVersion: 2,
    sceneRoster: [],
    arc: { currentPosition: 'Chapitre 12' },
    arcRevision: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

const trigger: Message = {
    id: 'trigger-review2',
    conversationId: conversation.id,
    parentId: null,
    role: 'user',
    content: 'J’attends.',
    isActiveBranch: true,
    createdAt: new Date(0),
    messageOrder: 1,
    regenerationIndex: 0,
};

const decision = {
    participants: [],
    observedTransitions: [],
    plannedTransitions: [],
    beatKind: 'initiative' as const,
    initiativeOwner: 'world',
    concreteChange: 'x',
};

function deps(overrides: Partial<DirectedBeatDeps> = {}): DirectedBeatDeps {
    return {
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
        sampler: { temperature: 0.5, maxTokens: 100, enableReasoning: false, useFlexTier: false },
        direct: async () => ({ ...decision }),
        compose: async () => ({
            content: JSON.stringify({ narration: 'La porte grince.', turns: [] }),
        }),
        persistBeat: async () => undefined,
        commitObservedState: async () => undefined,
        commitBeat: async () => undefined,
        ...overrides,
    };
}

const input = {
    conversation,
    character,
    beatHistory: [trigger],
    userName: 'Noah',
    maxSpeakers: 3,
    reflectionConcurrency: 2,
    composer: { provider: 'openrouter', model: 'test' },
    signal: new AbortController().signal,
};

describe('planner cadence', () => {
    const base = { majorTransition: false, stalled: false };
    it('V1 keeps its historical count of committed beats', () => {
        expect(planningDue({ ...base, v2: false, committedBeatCount: 0, committedTotal: 1 })).toBe(
            true
        );
        expect(planningDue({ ...base, v2: false, committedBeatCount: 0, committedTotal: 2 })).toBe(
            false
        );
        expect(planningDue({ ...base, v2: false, committedBeatCount: 0, committedTotal: 8 })).toBe(
            true
        );
    });
    it('V2 counts beats on the branch and never plans on a zero count', () => {
        expect(planningDue({ ...base, v2: true, committedBeatCount: 0, committedTotal: 5 })).toBe(
            false
        );
        expect(planningDue({ ...base, v2: true, committedBeatCount: 1, committedTotal: 0 })).toBe(
            true
        );
        expect(planningDue({ ...base, v2: true, committedBeatCount: 4, committedTotal: 0 })).toBe(
            true
        );
        expect(planningDue({ ...base, v2: true, committedBeatCount: 5, committedTotal: 0 })).toBe(
            false
        );
        expect(
            planningDue({
                ...base,
                v2: true,
                committedBeatCount: 5,
                committedTotal: 0,
                stalled: true,
            })
        ).toBe(true);
    });
});

describe('canon compass', () => {
    it('a user edit of the Arc Compass outranks the state copy at the next beat', async () => {
        const stored = createInitialStoryState({ conversation, profiles: [] });
        stored.plot.canonPosition = 'Chapitre 9';
        let committed: StoryState | undefined;
        const outcome = await executeDirectedBeat(
            input,
            deps({
                loadStoredState: async () => stored,
                commitBeat: async ({ storyState }) => {
                    committed = storyState;
                },
            })
        );
        expect(outcome.kind).toBe('committed');
        expect(committed?.plot.canonPosition).toBe('Chapitre 12');
    });

    it('a lock on the canon position keeps the state copy', async () => {
        const stored = createInitialStoryState({ conversation, profiles: [] });
        stored.plot.canonPosition = 'Chapitre 9';
        stored.locks = { '/plot/canonPosition': true };
        let committed: StoryState | undefined;
        await executeDirectedBeat(
            input,
            deps({
                loadStoredState: async () => stored,
                commitBeat: async ({ storyState }) => {
                    committed = storyState;
                },
            })
        );
        expect(committed?.plot.canonPosition).toBe('Chapitre 9');
    });

    it('a brand-new conversation commits revision 1 with no dangling parent', async () => {
        let committed: StoryState | undefined;
        await executeDirectedBeat(
            input,
            deps({
                commitBeat: async ({ storyState }) => {
                    committed = storyState;
                },
            })
        );
        expect(committed?.revision).toBe(1);
        expect(committed?.parentRevisionId).toBeUndefined();
    });
});

describe('branch state resolution', () => {
    it('ignores a cached active revision anchored outside the supplied branch', async () => {
        const foreign: StoryState = {
            ...createInitialStoryState({ conversation, profiles: [] }),
            id: 'foreign-revision',
            anchorMessageId: 'discarded-beat-bubble',
        };
        await saveStoryState(foreign);
        const branchOnly = await getStoryStateForBranch(
            { ...conversation, activeStoryStateRevisionId: foreign.id },
            [trigger]
        );
        expect(branchOnly).toBeUndefined();
        const legacy: StoryState = {
            ...foreign,
            id: 'legacy-revision',
            anchorMessageId: undefined,
        };
        await saveStoryState(legacy);
        expect(
            (
                await getStoryStateForBranch(
                    { ...conversation, activeStoryStateRevisionId: legacy.id },
                    [trigger]
                )
            )?.id
        ).toBe(legacy.id);
    });
});

describe('sharing redaction', () => {
    it('drops private knowledge, casting drafts and director directions', () => {
        const state: StoryState = {
            ...createInitialStoryState({ conversation, profiles: [] }),
            knowledge: [
                { id: 'k1', text: 'Secret', visibility: 'private', knownBy: ['card:a'] },
                { id: 'k2', text: 'Public', visibility: 'public', knownBy: [] },
            ],
        };
        expect(redactStoryStateForSharing(state).knowledge?.map((fact) => fact.id)).toEqual(['k2']);
        const beat: SceneBeatRecord = {
            id: 'b',
            conversationId: conversation.id,
            triggerMessageId: trigger.id,
            branchTipId: trigger.id,
            generationId: 'g',
            status: 'committed',
            decision: {
                ...decision,
                participants: [
                    {
                        characterRefId: 'card:a',
                        name: 'A',
                        mode: 'speak',
                        attention: 'full',
                        reason: 'addressed',
                        direction: 'Refuse, but hint at the secret.',
                    },
                ],
                castingRequest: { role: 'messenger', reason: 'news' },
            },
            intents: [],
            outputMessageIds: [],
            errors: [],
            timings: {},
            createdAt: 0,
            updatedAt: 0,
        };
        const shared = redactSceneBeatForSharing(beat);
        expect(shared.decision?.castingRequest).toBeUndefined();
        expect(shared.decision?.participants[0].direction).toBeUndefined();
        expect(shared.decision?.participants[0].reason).toBe('addressed');
    });
});

describe('structured parsing', () => {
    const irisProfile: ResolvedCharacterProfile = {
        ref: {
            id: 'card:iris',
            source: 'character-card',
            displayName: 'Iris',
            readiness: 'ready',
        },
        description: 'x',
    };

    it('salvages one JSON object wrapped in chatter and rejects prose', () => {
        expect(parseSceneJson('Here is my decision:\n{"a":1}\nHope this helps.')).toEqual({
            a: 1,
        });
        expect(() => parseSceneJson('I cannot decide this beat.')).toThrow(/hors JSON/);
        expect(() => parseSceneJson('Sure: {"a":')).toThrow(/hors JSON|invalide/);
    });

    it('drops a served step the plan does not contain', () => {
        const raw = JSON.stringify({
            participants: [],
            observedTransitions: [],
            plannedTransitions: [],
            beatKind: 'reveal',
            initiativeOwner: 'world',
            servedStepId: 'invented-step',
        });
        expect(
            parseDirectedDecision(raw, [irisProfile], 3, { version: 2, stepIds: ['real-step'] })
                .servedStepId
        ).toBeUndefined();
        expect(
            parseDirectedDecision(raw.replace('invented-step', 'real-step'), [irisProfile], 3, {
                version: 2,
                stepIds: ['real-step'],
            }).servedStepId
        ).toBe('real-step');
    });
});
