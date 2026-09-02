import { describe, expect, it, vi } from 'vitest';
import type { Message, StoryState } from '@/types';
import {
    applyStoryTransitions,
    reconcileStoryStateRoster,
    storyRoster,
    type ResolvedCharacterProfile,
} from '@/lib/ai/story-state';
import {
    assertNoPrivateIntentLeak,
    filterVisiblePlannedTransitions,
    mapWithConcurrency,
    parseCompositionResult,
    parseDirectedDecision,
    parseSceneJson,
    runCharacterReflections,
} from '@/lib/ai/directed-scene';
import { projectSceneBeatsForContext } from '@/lib/ai/payload-builder';
import { nanogptBaseURL } from '@/app/api/chat/route';
import { DIRECTED_SCENE_EVAL_CORPUS } from '@/lib/ai/evals/directed-scene-corpus';

const alice: ResolvedCharacterProfile = {
    ref: {
        id: 'card:alice',
        source: 'character-card',
        sourceId: 'alice',
        displayName: 'Alice',
        readiness: 'ready',
    },
    description: 'Directe et prudente.',
};
const bob: ResolvedCharacterProfile = {
    ref: {
        id: 'adhoc:bob',
        source: 'ad-hoc',
        displayName: 'Bob',
        readiness: 'stub',
    },
    description: '',
};

const state: StoryState = {
    id: 'state-1',
    conversationId: 'conversation',
    revision: 1,
    source: 'migration',
    scene: {
        location: 'Quai',
        participants: [
            { character: alice.ref, presence: 'onstage', agency: 'active' },
            { character: bob.ref, presence: 'onstage', agency: 'limited' },
        ],
    },
    plot: { openThreads: [], nextMoves: [] },
    locks: {
        '/scene/location': true,
        '/scene/participants/card:alice/presence': true,
    },
    createdAt: 1,
};

describe('directed scene state', () => {
    it('lets observed user facts outrank locks but blocks planned AI changes', () => {
        const planned = applyStoryTransitions(state, [
            { origin: 'planned', type: 'exit', characterRefId: alice.ref.id },
            { origin: 'planned', type: 'location', value: 'Gare' },
        ]);
        expect(planned.scene.location).toBe('Quai');
        expect(storyRoster(planned)).toContain('Alice');

        const observed = applyStoryTransitions(state, [
            { origin: 'observed', type: 'exit', characterRefId: alice.ref.id },
            { origin: 'observed', type: 'location', value: 'Gare' },
        ]);
        expect(observed.scene.location).toBe('Gare');
        expect(storyRoster(observed)).not.toContain('Alice');
    });

    it('treats the explicit SceneBar roster as an authoritative user edit', () => {
        const reconciled = reconcileStoryStateRoster(state, [alice]);
        expect(storyRoster(reconciled)).toEqual(['Alice']);
        expect(
            reconciled.scene.participants.find((p) => p.character.id === bob.ref.id)?.presence
        ).toBe('offstage');
    });
});

describe('directed scene structured outputs', () => {
    it('accepts raw JSON or one JSON fence and rejects chatter', () => {
        expect(parseSceneJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
        expect(() => parseSceneJson('Here: {"ok":true}')).toThrow(/hors JSON/);
    });

    it('caps speakers, resolves stable ids and denies reflection to stubs', () => {
        const decision = parseDirectedDecision(
            JSON.stringify({
                participants: [
                    {
                        characterRefId: alice.ref.id,
                        mode: 'speak',
                        attention: 'full',
                        reason: 'addressed',
                    },
                    {
                        characterRefId: bob.ref.id,
                        mode: 'act',
                        attention: 'full',
                        reason: 'nearby',
                    },
                ],
                observedTransitions: [{ type: 'exit', characterRefId: alice.ref.id }],
            }),
            [alice, bob],
            2
        );
        expect(decision.participants[0].attention).toBe('full');
        expect(decision.participants[1].attention).toBe('none');
        expect(decision.observedTransitions[0].origin).toBe('observed');
    });

    it('admits a ready candidate that enters from outside the current state', () => {
        const withoutBob = {
            ...state,
            scene: { ...state.scene, participants: state.scene.participants.slice(0, 1) },
        };
        const decision = parseDirectedDecision(
            JSON.stringify({
                observedTransitions: [{ type: 'enter', characterRefId: bob.ref.id }],
                participants: [
                    {
                        characterRefId: bob.ref.id,
                        mode: 'act',
                        attention: 'none',
                    },
                ],
            }),
            [alice, { ...bob, ref: { ...bob.ref, readiness: 'ready' } }],
            2
        );
        const entered = applyStoryTransitions(withoutBob, decision.observedTransitions, [
            { ...bob.ref, readiness: 'ready' },
        ]);
        expect(storyRoster(entered)).toContain('Bob');
    });

    it('accepts allowed turns and rejects duplicates or unknown ids', () => {
        const participant = {
            characterRefId: alice.ref.id,
            name: 'Alice',
            mode: 'speak' as const,
            attention: 'full' as const,
            reason: 'addressed',
        };
        expect(
            parseCompositionResult(
                JSON.stringify({
                    narration: 'La pluie cesse.',
                    turns: [{ characterRefId: alice.ref.id, text: 'Elle relève la tête.' }],
                }),
                [participant]
            ).turns[0].text
        ).toContain('relève');
        expect(() =>
            parseCompositionResult(
                JSON.stringify({
                    turns: [{ characterRefId: 'unknown', text: 'Leak' }],
                }),
                [participant]
            )
        ).toThrow(/non autorisé/);
        expect(() =>
            parseCompositionResult(
                JSON.stringify({
                    turns: [
                        { characterRefId: alice.ref.id, text: 'Première bulle.' },
                        { characterRefId: alice.ref.id, text: 'Deuxième bulle.' },
                    ],
                }),
                [participant]
            )
        ).toThrow(/dupliqué/);
    });

    it('commits planned entrances only when the character is visible in the composition', () => {
        const entrance = {
            origin: 'planned' as const,
            type: 'enter' as const,
            characterRefId: alice.ref.id,
        };
        expect(
            filterVisiblePlannedTransitions(
                [entrance],
                { narration: 'La porte bouge.', turns: [] },
                [alice]
            )
        ).toEqual([]);
        expect(
            filterVisiblePlannedTransitions(
                [entrance],
                { narration: 'Alice franchit la porte.', turns: [] },
                [alice]
            )
        ).toEqual([entrance]);
    });

    it('rejects private facts in narration or in the mouth of an uninformed character', () => {
        const fact = {
            id: 'hidden-key',
            text: 'Bob a caché la clé',
            aliases: ['la clé cachée par Bob'],
            visibility: 'private' as const,
            knownBy: [bob.ref.id],
        };
        expect(() =>
            assertNoPrivateIntentLeak(
                { narration: 'Bob a caché la clé sous le tapis.', turns: [] },
                [],
                [fact]
            )
        ).toThrow(/fait privé/);
        expect(() =>
            assertNoPrivateIntentLeak(
                { turns: [{ characterRefId: alice.ref.id, text: 'Bob a caché la clé.' }] },
                [],
                [fact]
            )
        ).toThrow(/ne connaît pas/);
        expect(() =>
            assertNoPrivateIntentLeak(
                { turns: [{ characterRefId: bob.ref.id, text: 'J’ai caché la clé.' }] },
                [],
                [fact]
            )
        ).not.toThrow();
    });

    it('runs workers concurrently without exceeding the requested pool', async () => {
        let active = 0;
        let peak = 0;
        const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return value * 2;
        });
        expect(peak).toBe(2);
        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    });

    it('finishes a full four-worker batch in the duration of the slowest worker', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        try {
            const startedAt = Date.now();
            const batch = mapWithConcurrency([1_000, 800, 600, 400], 4, async (duration) => {
                await new Promise((resolve) => setTimeout(resolve, duration));
                return duration;
            });
            await vi.advanceTimersByTimeAsync(1_000);
            const results = await batch;
            expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
            expect(Date.now() - startedAt).toBe(1_000);
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles every reflection and preserves successful intents when one worker fails', async () => {
        const readyBob: ResolvedCharacterProfile = {
            ...bob,
            ref: { ...bob.ref, readiness: 'ready' },
        };
        const chloe: ResolvedCharacterProfile = {
            ...alice,
            ref: {
                ...alice.ref,
                id: 'card:chloe',
                sourceId: 'chloe',
                displayName: 'Chloé',
            },
        };
        const participants = [alice, readyBob, chloe].map((profile) => ({
            characterRefId: profile.ref.id,
            name: profile.ref.displayName,
            mode: 'speak' as const,
            attention: 'brief' as const,
            reason: 'test',
        }));
        const called: string[] = [];
        const settled: number[] = [];
        const latestUserMessage: Message = {
            id: 'user-reflections',
            conversationId: state.conversationId,
            parentId: null,
            role: 'user',
            content: 'Que décidez-vous ?',
            isActiveBranch: true,
            createdAt: new Date(0),
            messageOrder: 1,
            regenerationIndex: 0,
        };
        const batch = await runCharacterReflections({
            participants,
            profiles: [alice, readyBob, chloe],
            existingIntents: [],
            state,
            latestUserMessage,
            route: {
                provider: 'nanogpt',
                model: 'test-model',
                billingScope: 'subscription',
                routing: 'nanogpt',
                resolvedAt: 0,
            },
            concurrency: 3,
            onSettled: (completed) => settled.push(completed),
            reflect: async ({ profile, participant }) => {
                called.push(profile.ref.id);
                if (profile.ref.id === readyBob.ref.id) throw new Error('worker down');
                return {
                    characterRefId: profile.ref.id,
                    name: profile.ref.displayName,
                    attention: participant.attention as 'brief' | 'full',
                    speechIntent: 'Répondre.',
                };
            },
        });
        expect(called).toHaveLength(3);
        expect(settled).toHaveLength(3);
        expect(batch.intents.map((intent) => intent.characterRefId)).toEqual([
            alice.ref.id,
            chloe.ref.id,
        ]);
        expect(batch.failures).toHaveLength(1);
        expect(batch.failures[0].participant.characterRefId).toBe(readyBob.ref.id);
    });
});

describe('directed beat integration helpers', () => {
    it('ships the 24-case acceptance corpus with every critical scenario family', () => {
        expect(DIRECTED_SCENE_EVAL_CORPUS).toHaveLength(24);
        const tags = new Set(DIRECTED_SCENE_EVAL_CORPUS.flatMap((fixture) => fixture.tags));
        for (const required of [
            'entry',
            'exit',
            'false-exit',
            'remote',
            'agency-none',
            'ambiguous-alias',
            'secret',
            'lock',
            'quota',
            'cancellation',
            'branch',
            'reload',
        ]) {
            expect(tags.has(required), `missing eval tag: ${required}`).toBe(true);
        }
    });

    it('projects separate beat bubbles as one assistant context turn', () => {
        const base = {
            conversationId: 'conversation',
            isActiveBranch: true,
            createdAt: new Date(0),
            regenerationIndex: 0,
        };
        const messages: Message[] = [
            {
                ...base,
                id: 'u',
                parentId: null,
                role: 'user',
                content: 'Et maintenant ?',
                messageOrder: 1,
            },
            {
                ...base,
                id: 'n',
                parentId: 'u',
                role: 'assistant',
                content: 'La porte claque.',
                messageOrder: 2,
                sceneBeatId: 'beat',
                speaker: { kind: 'narrator', name: 'Narrateur' },
            },
            {
                ...base,
                id: 'a',
                parentId: 'n',
                role: 'assistant',
                content: 'Alice: Alice se retourne.',
                messageOrder: 3,
                sceneBeatId: 'beat',
                speaker: { kind: 'character', name: 'Alice' },
                storyStateRevisionId: 'state-2',
            },
        ];
        const projected = projectSceneBeatsForContext(messages);
        expect(projected).toHaveLength(2);
        expect(projected[1].content).toContain('[Narrateur]');
        expect(projected[1].content).toContain('[Alice]');
        expect(projected[1].content.match(/Alice:/g)).toBeNull();
        expect(projected[1].storyStateRevisionId).toBe('state-2');
    });

    it('uses the subscription-only NanoGPT endpoint unless paygo is explicit', () => {
        expect(nanogptBaseURL()).toContain('/api/subscription/v1');
        expect(nanogptBaseURL('subscription')).toContain('/api/subscription/v1');
        expect(nanogptBaseURL('paygo')).toBe('https://nano-gpt.com/api/v1');
    });
});
