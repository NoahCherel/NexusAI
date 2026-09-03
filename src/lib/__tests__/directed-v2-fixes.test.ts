/**
 * Review follow-ups on directed narrative V2: auditor false positives, initiative
 * normalisation, retry semantics, rhythm memory, the writer-owned scene summary, casting
 * failure and provisional-profile reuse.
 */

import { describe, expect, it } from 'vitest';
import type { CharacterCard, Conversation, Message, StoryState } from '@/types';
import {
    applyCommittedNarrativeProgress,
    buildCharacterRegistry,
    createInitialStoryState,
    type ResolvedCharacterProfile,
} from '@/lib/ai/story-state';
import { auditDirectedComposition, needsJudge, stripDialogue } from '@/lib/ai/beat-auditor';
import { parseDirectedDecision } from '@/lib/ai/directed-scene';
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
    id: 'conversation-v2-fixes',
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
    id: 'trigger-v2-fixes',
    conversationId: conversation.id,
    parentId: null,
    role: 'user',
    content: 'J’attends dans le couloir.',
    isActiveBranch: true,
    createdAt: new Date(0),
    messageOrder: 1,
    regenerationIndex: 0,
};

const irisRef = {
    id: 'card:iris',
    source: 'character-card' as const,
    displayName: 'Iris',
    readiness: 'ready' as const,
};
const kaiRef = {
    id: 'card:kai',
    source: 'character-card' as const,
    displayName: 'Kai',
    readiness: 'ready' as const,
};
const irisProfile: ResolvedCharacterProfile = { ref: irisRef, description: 'Une gardienne.' };
const kaiProfile: ResolvedCharacterProfile = { ref: kaiRef, description: 'Un messager.' };

const worldDecision = {
    participants: [],
    observedTransitions: [],
    plannedTransitions: [],
    beatKind: 'initiative' as const,
    initiativeOwner: 'world',
    concreteChange: 'La porte se verrouille.',
};

function auditText(narration: string, turns: Array<{ characterRefId: string; text: string }>) {
    const state = createInitialStoryState({ conversation, profiles: [] });
    return auditDirectedComposition({
        composition: { narration, turns },
        decision: worldDecision,
        intents: [],
        state,
        solo: turns.length === 0,
        userName: 'Noah',
    });
}

function makeDeps(overrides: Partial<DirectedBeatDeps> = {}): DirectedBeatDeps {
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
        direct: async () => ({ ...worldDecision }),
        reflect: async () => {
            throw new Error('no reflection expected');
        },
        compose: async () => ({
            content: JSON.stringify({
                narration: 'Un courant d’air traverse le couloir.',
                turns: [],
            }),
        }),
        persistBeat: async () => undefined,
        commitObservedState: async () => undefined,
        commitBeat: async () => undefined,
        ...overrides,
    };
}

const baseInput = {
    conversation,
    character,
    beatHistory: [trigger],
    userName: 'Noah',
    maxSpeakers: 5,
    reflectionConcurrency: 4,
    composer: { provider: 'openrouter', model: 'test' },
    signal: new AbortController().signal,
};

const failedRecord = {
    conversationId: conversation.id,
    triggerMessageId: trigger.id,
    branchTipId: trigger.id,
    generationId: 'g',
    status: 'failed' as const,
    intents: [],
    outputMessageIds: [],
    errors: [],
    timings: {},
    createdAt: 0,
    updatedAt: 0,
};

describe('beat auditor: player-control precision', () => {
    it('does not flag second-person narration of facing, doing or perceiving', () => {
        expect(auditText('Tu fais face à une porte close.', []).issues).toEqual([]);
        expect(auditText('Everything you do here echoes in the hall.', []).issues).toEqual([]);
        const perception = auditText('Tu ressens un courant d’air glacé.', []);
        expect(perception.status).toBe('warning');
        expect(perception.issues).toContainEqual(
            expect.objectContaining({ code: 'player-control', severity: 'warning' })
        );
    });

    it('lets characters address the player in the second person', () => {
        const dialogue = auditText('', [
            { characterRefId: irisRef.id, text: '« Tu décides, Noah. Moi je reste. »' },
            {
                characterRefId: kaiRef.id,
                text: '"Whatever you say," he mutters.\n— Si Noah avance, je le suis.',
            },
        ]);
        expect(dialogue.issues.filter((issue) => issue.code === 'player-control')).toEqual([]);
        expect(stripDialogue('Elle sourit. « Tu décides. »').trim()).toBe('Elle sourit.');
    });

    it('still blocks narration that decides for the named or addressed player', () => {
        expect(auditText('Noah décide de courir.', []).status).toBe('failed');
        expect(auditText('Tu décides de mentir.', []).status).toBe('failed');
    });

    it('only summons the judge on calibrated signals', () => {
        const state = createInitialStoryState({ conversation, profiles: [] });
        const noisy = auditDirectedComposition({
            composition: { narration: 'La serrure claque.', turns: [] },
            decision: { ...worldDecision, concreteChange: undefined },
            intents: [],
            state: { ...state, scene: { ...state.scene, location: 'Bibliothèque interdite' } },
            solo: true,
            userName: 'Noah',
        });
        expect(noisy.issues.map((issue) => issue.code).sort()).toEqual([
            'missing-initiative',
            'unused-setting',
        ]);
        expect(needsJudge(noisy)).toBe(false);
    });

    it('flags a fourth identical beat kind or initiative owner as repetitive structure', () => {
        const base = createInitialStoryState({ conversation, profiles: [] });
        const state: StoryState = {
            ...base,
            plot: {
                ...base.plot,
                recentBeatKinds: ['reaction', 'reaction', 'reaction'],
                recentInitiativeOwners: [irisRef.id, irisRef.id, irisRef.id],
            },
        };
        const repeated = auditDirectedComposition({
            composition: { narration: 'Iris insiste encore.', turns: [] },
            decision: { ...worldDecision, beatKind: 'reaction', initiativeOwner: irisRef.id },
            intents: [],
            state,
            solo: false,
            userName: 'Noah',
        });
        expect(repeated.issues).toContainEqual(
            expect.objectContaining({ code: 'repetitive-structure', severity: 'warning' })
        );
        expect(needsJudge(repeated)).toBe(true);
    });
});

describe('director decision: initiative owner', () => {
    const raw = (initiativeOwner: string) =>
        JSON.stringify({
            participants: [
                { characterRefId: irisRef.id, mode: 'speak', attention: 'brief', reason: 'x' },
            ],
            observedTransitions: [],
            plannedTransitions: [],
            beatKind: 'initiative',
            initiativeOwner,
        });

    it('accepts world or a known character id and refuses the player or an unknown name', () => {
        const options = { version: 2 as const, solo: false };
        expect(
            parseDirectedDecision(raw(irisRef.id), [irisProfile], 5, options).initiativeOwner
        ).toBe(irisRef.id);
        expect(parseDirectedDecision(raw('Noah'), [irisProfile], 5, options).initiativeOwner).toBe(
            'world'
        );
        expect(parseDirectedDecision(raw('Iris'), [irisProfile], 5, options).initiativeOwner).toBe(
            'world'
        );
        expect(
            parseDirectedDecision(raw(irisRef.id), [irisProfile], 5, { version: 2, solo: true })
                .initiativeOwner
        ).toBe('world');
        expect(
            parseDirectedDecision(raw(irisRef.id), [irisProfile], 5, { version: 1 }).initiativeOwner
        ).toBeUndefined();
    });

    it('falls back to the world when the named owner does not survive the participant filter', async () => {
        let committed: StoryState | undefined;
        let reflections = 0;
        const rostered = { ...conversation, sceneRoster: ['Iris'] };
        const stored = createInitialStoryState({ conversation: rostered, profiles: [irisProfile] });
        const outcome = await executeDirectedBeat(
            { ...baseInput, conversation: rostered },
            makeDeps({
                loadStoredState: async () => stored,
                resolveCharacters: async (roster) => (roster.length ? [irisProfile] : []),
                resolveEntryCandidates: async () => [kaiProfile],
                direct: async () => ({
                    ...worldDecision,
                    // Kai is neither on stage nor entering: the participant filter drops him.
                    participants: [
                        {
                            characterRefId: kaiRef.id,
                            name: 'Kai',
                            mode: 'speak',
                            attention: 'full',
                            reason: 'x',
                        },
                    ],
                    initiativeOwner: kaiRef.id,
                }),
                reflect: async () => {
                    reflections++;
                    throw new Error('unexpected');
                },
                commitBeat: async ({ storyState }) => {
                    committed = storyState;
                },
            })
        );
        expect(outcome.kind).toBe('committed');
        expect(reflections).toBe(0);
        expect(outcome.record.decision?.initiativeOwner).toBe('world');
        expect(outcome.record.audit?.status).not.toBe('failed');
        expect(committed?.plot.recentInitiativeOwners).toEqual(['world']);
        expect(committed?.plot.recentBeatKinds).toEqual(['initiative']);
    });
});

describe('retry replays the original trigger', () => {
    const observedDirect = async () => ({
        ...worldDecision,
        observedTransitions: [
            { origin: 'observed' as const, type: 'location' as const, value: 'la cave' },
        ],
    });

    it('a bare retry on an assistant tip is an advance-scene beat: no observation replay', async () => {
        const assistantTip: Message = {
            ...trigger,
            id: 'assistant-tip',
            role: 'assistant',
            content: 'La porte grince.',
            messageOrder: 2,
        };
        let observedCommits = 0;
        const outcome = await executeDirectedBeat(
            { ...baseInput, beatHistory: [trigger, assistantTip], triggerKind: 'retry' },
            makeDeps({
                direct: observedDirect,
                commitObservedState: async () => {
                    observedCommits++;
                },
            })
        );
        expect(outcome.kind).toBe('committed');
        expect(outcome.record.triggerKind).toBe('advance-scene');
        expect(outcome.record.decision?.observedTransitions).toEqual([]);
        expect(observedCommits).toBe(0);
    });

    it('a bare retry on an unanswered player message stays a player-message beat', async () => {
        let observedCommits = 0;
        const outcome = await executeDirectedBeat(
            { ...baseInput, triggerKind: 'retry' },
            makeDeps({
                direct: observedDirect,
                commitObservedState: async () => {
                    observedCommits++;
                },
            })
        );
        expect(outcome.kind).toBe('committed');
        expect(outcome.record.triggerKind).toBe('player-message');
        expect(outcome.record.inputMessageId).toBe(trigger.id);
        expect(observedCommits).toBe(1);
    });

    it('a retried record keeps its original kind', async () => {
        const outcome = await executeDirectedBeat(
            {
                ...baseInput,
                retrySource: {
                    ...failedRecord,
                    id: 'beat-original',
                    triggerKind: 'advance-scene',
                },
                triggerKind: 'retry',
            },
            makeDeps({ direct: observedDirect })
        );
        expect(outcome.record.triggerKind).toBe('advance-scene');
        expect(outcome.record.decision?.observedTransitions).toEqual([]);
    });
});

describe('committed narrative progress', () => {
    it('remembers the last six beat kinds and takes the writer’s scene summary under lock', () => {
        let state = createInitialStoryState({ conversation, profiles: [] });
        const kinds = [
            'reaction',
            'initiative',
            'complication',
            'reveal',
            'payoff',
            'breather',
            'transition',
        ] as const;
        for (const beatKind of kinds) {
            state = applyCommittedNarrativeProgress(
                state,
                { narration: 'x', turns: [], sceneSummary: `après ${beatKind}` },
                { beatKind, initiativeOwner: 'world' }
            );
        }
        expect(state.plot.recentBeatKinds).toEqual(kinds.slice(1));
        expect(state.plot.recentInitiativeOwners).toHaveLength(6);
        expect(state.scene.summary).toBe('après transition');
        expect(state.plot.committedBeatCount).toBe(7);

        const locked = applyCommittedNarrativeProgress(
            { ...state, locks: { '/scene/summary': true } },
            { narration: 'x', turns: [], sceneSummary: 'ignoré' }
        );
        expect(locked.scene.summary).toBe('après transition');
    });
});

describe('casting', () => {
    it('a failed casting still leaves a playable solo beat', async () => {
        let castingCalls = 0;
        const outcome = await executeDirectedBeat(
            baseInput,
            makeDeps({
                direct: async () => ({
                    ...worldDecision,
                    castingRequest: { role: 'un messager', reason: 'apporter la nouvelle' },
                }),
                resolveCastingProfile: async () => {
                    castingCalls++;
                    throw new Error('Le dossier canonique demandé n’a pas pu être hydraté.');
                },
            })
        );
        expect(castingCalls).toBe(1);
        expect(outcome.kind).toBe('committed');
        expect(outcome.record.provisionalProfiles).toEqual([]);
        expect(outcome.record.decision?.participants).toEqual([]);
    });

    it('a retry reuses a compatible provisional profile without a second casting call', async () => {
        const generated = {
            ref: {
                id: 'generated:g1',
                source: 'generated' as const,
                displayName: 'Léna',
                readiness: 'ready' as const,
            },
            publicProfile: { description: 'Une messagère essoufflée.' },
            commitments: [],
            status: 'cameo' as const,
            meaningfulAppearances: 0,
        };
        const registry = buildCharacterRegistry({ profiles: [], provisional: [generated] });
        let castingCalls = 0;
        const reflected: string[] = [];
        let committed: StoryState | undefined;
        const outcome = await executeDirectedBeat(
            {
                ...baseInput,
                retrySource: {
                    ...failedRecord,
                    id: 'beat-retry',
                    triggerKind: 'player-message',
                    registryFingerprint: registry.fingerprint,
                    provisionalProfiles: [generated],
                },
                triggerKind: 'retry',
            },
            makeDeps({
                direct: async () => ({
                    ...worldDecision,
                    castingRequest: { role: 'messagère', reason: 'nouvelle urgente' },
                }),
                resolveCastingProfile: async () => {
                    castingCalls++;
                    return undefined;
                },
                reflect: async ({ profile }) => {
                    reflected.push(profile.ref.id);
                    return {
                        characterRefId: profile.ref.id,
                        name: profile.ref.displayName,
                        attention: 'full',
                        stance: 'Pressée',
                    };
                },
                compose: async () => ({
                    content: JSON.stringify({
                        narration: 'La porte s’ouvre à la volée.',
                        turns: [
                            {
                                characterRefId: generated.ref.id,
                                text: 'Elle reprend son souffle. « Ils arrivent. »',
                            },
                        ],
                    }),
                }),
                commitBeat: async ({ storyState }) => {
                    committed = storyState;
                },
            })
        );
        expect(outcome.kind).toBe('committed');
        expect(castingCalls).toBe(0);
        expect(reflected).toEqual([generated.ref.id]);
        expect(committed?.characters?.[generated.ref.id]).toMatchObject({
            meaningfulAppearances: 1,
            status: 'cameo',
        });
        expect(outcome.record.provisionalProfiles).toEqual([]);
    });
});
