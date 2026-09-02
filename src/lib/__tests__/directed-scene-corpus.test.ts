/**
 * Replays the 24-scene acceptance corpus through the REAL orchestrator with a scripted
 * model. What is under test is the state machine, the validators and the atomicity
 * contract — not any model's prose. Faults (worker failure, quota, Stop, branch switch,
 * reload) are injected through the dependency seams the chat hook itself uses.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type { CharacterRef, SceneBeatRecord, StoryKnowledgeFact, StoryState } from '@/types/scene';
import {
    executeDirectedBeat,
    type DirectedBeatDeps,
    type DirectedBeatOutcome,
} from '@/lib/ai/directed-beat';
import { parseDirectedDecision, type reflectCharacter } from '@/lib/ai/directed-scene';
import {
    AmbiguousCharacterError,
    storyRoster,
    type ResolvedCharacterProfile,
} from '@/lib/ai/story-state';
import {
    DIRECTED_SCENE_EVAL_CORPUS,
    type DirectedSceneEvalCase,
    type DirectedSceneScript,
    type ScriptedComposition,
    type ScriptedTransition,
} from '@/lib/ai/evals/directed-scene-corpus';

type ParticipantSpec = NonNullable<
    NonNullable<DirectedSceneScript['state']>['participants']
>[number];

const slug = (name: string) => name.trim().toLocaleLowerCase();
const abortError = () => new DOMException('Aborted', 'AbortError');

const ROOT: CharacterCard = {
    id: 'root-card',
    name: 'Maître du jeu',
    description: 'Carte principale',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
};

function cardProfile(name: string, id = `card:${slug(name)}`): ResolvedCharacterProfile {
    return {
        ref: {
            id,
            source: 'character-card',
            sourceId: id.replace(/^card:/, ''),
            displayName: name,
            readiness: 'ready',
        },
        description: `${name}, profil de test.`,
        personality: 'Directe.',
    };
}

function stubProfile(name: string): ResolvedCharacterProfile {
    return {
        ref: { id: `adhoc:${slug(name)}`, source: 'ad-hoc', displayName: name, readiness: 'stub' },
        description: '',
    };
}

interface Harness {
    conversation: Conversation;
    history: Message[];
    deps: DirectedBeatDeps;
    controller: AbortController;
    registry: Map<string, ResolvedCharacterProfile>;
    calls: {
        director: number;
        reflections: string[];
        compositions: number;
        commits: number;
        observedCommits: number;
    };
    persisted: SceneBeatRecord[];
    committed: { messages: Message[]; state: StoryState } | null;
    /** Observed revisions, shared with a retry harness the way IndexedDB would be. */
    persistedStates?: Map<string, StoryState>;
    /** Flip to make the injected fault stop firing (second attempt = healthy world). */
    healthy: boolean;
}

function buildHarness(
    fixture: DirectedSceneEvalCase,
    overrides?: Record<string, CharacterRef>
): Harness {
    const { script } = fixture;
    const registry = new Map<string, ResolvedCharacterProfile>();
    const register = (profile: ResolvedCharacterProfile) => registry.set(profile.ref.id, profile);
    const knownNames = new Set<string>([
        ...fixture.roster,
        ...(script.library ?? []),
        ...(script.state?.participants ?? []).map((participant) => participant.name),
        ...(script.state?.knowledge ?? []).flatMap((fact) => fact.knownBy),
    ]);
    for (const name of knownNames) {
        if (script.ambiguous?.includes(name)) {
            register(cardProfile(name, `card:${slug(name)}-1`));
            register(cardProfile(name, `card:${slug(name)}-2`));
        } else if (script.stubs?.includes(name)) {
            register(stubProfile(name));
        } else {
            register(cardProfile(name));
        }
    }
    const byName = (name: string): ResolvedCharacterProfile => {
        const key = slug(name);
        const override = overrides?.[key];
        if (override) return registry.get(override.id)!;
        const hit = registry.get(`card:${key}`) ?? registry.get(`adhoc:${key}`);
        if (!hit) throw new Error(`Fixture ${fixture.id}: unknown name ${name}`);
        return hit;
    };

    const conversation: Conversation = {
        id: `conversation-${fixture.id}`,
        characterId: ROOT.id,
        title: fixture.title,
        sceneMode: true,
        sceneStyle: 'composed-turns',
        sceneRoster: fixture.roster,
        sceneCharacterOverrides: overrides,
        createdAt: new Date(0),
        updatedAt: new Date(0),
    };
    const history: Message[] = [
        {
            id: `trigger-${fixture.id}`,
            conversationId: conversation.id,
            parentId: null,
            role: 'user',
            content: fixture.userMessage,
            isActiveBranch: true,
            createdAt: new Date(0),
            messageOrder: 1,
            regenerationIndex: 0,
        },
    ];

    const storedState: StoryState | undefined = script.state
        ? {
              id: `state-${fixture.id}`,
              conversationId: conversation.id,
              revision: 1,
              source: 'migration',
              anchorMessageId: history[0].id,
              scene: {
                  location: script.state.location,
                  participants: (
                      script.state.participants ??
                      fixture.roster.map((name): ParticipantSpec => ({ name }))
                  ).map((participant) => ({
                      character: byName(participant.name).ref,
                      presence: participant.presence ?? 'onstage',
                      agency: participant.agency ?? 'active',
                  })),
              },
              plot: { openThreads: [], nextMoves: [] },
              knowledge: script.state.knowledge?.map<StoryKnowledgeFact>((fact, index) => ({
                  id: `fact-${index}`,
                  text: fact.text,
                  aliases: fact.aliases,
                  visibility: 'private',
                  knownBy: fact.knownBy.map((name) => byName(name).ref.id),
              })),
              locks: Object.fromEntries((script.state.locks ?? []).map((path) => [path, true])),
              createdAt: 0,
          }
        : undefined;

    const controller = new AbortController();
    const harness: Harness = {
        conversation,
        history,
        controller,
        registry,
        calls: { director: 0, reflections: [], compositions: 0, commits: 0, observedCommits: 0 },
        persisted: [],
        committed: null,
        healthy: false,
        deps: undefined as unknown as DirectedBeatDeps,
    };

    let directorProfiles: ResolvedCharacterProfile[] = [];
    const idOf = (name: string) =>
        directorProfiles.find((profile) => profile.ref.displayName === name)?.ref.id ??
        byName(name).ref.id;
    const transition = (entry: ScriptedTransition) => ({
        type: entry.type,
        characterRefId: entry.name ? idOf(entry.name) : undefined,
        presence: entry.presence,
        agency: entry.agency,
        value: entry.value,
        evidence: entry.evidence,
    });
    const compositionJson = (composition: ScriptedComposition) =>
        JSON.stringify({
            narration: composition.narration,
            turns: (composition.turns ?? []).map((turn) => ({
                characterRefId: idOf(turn.name),
                text: turn.text,
                effects: turn.effects?.map(transition),
            })),
            effects: composition.effects?.map(transition),
        });

    let directorDone = false;
    let tabClosed = false;
    const faultActive = () => !!script.fault && !harness.healthy;

    const reflect: typeof reflectCharacter = async ({ profile, participant }) => {
        harness.calls.reflections.push(profile.ref.displayName);
        if (faultActive() && script.failingReflections?.includes(profile.ref.displayName)) {
            if (script.fault === 'reload') {
                // The tab dies: promises never resolve, nothing else gets written.
                tabClosed = true;
                controller.abort();
                throw abortError();
            }
            throw new Error(`worker down: ${profile.ref.displayName}`);
        }
        return {
            characterRefId: profile.ref.id,
            name: profile.ref.displayName,
            attention: participant.attention as 'brief' | 'full',
            emotion: 'tendue',
            privateGoal: `Objectif privé de ${profile.ref.displayName} pour ce beat précis.`,
            speechIntent: participant.direction ?? 'réagir',
        };
    };

    harness.deps = {
        resolveRoute: async () => ({
            provider: 'nanogpt',
            model: 'scripted-model',
            billingScope: 'subscription',
            routing: 'auto',
            resolvedAt: 0,
        }),
        loadStoredState: async () => storedState,
        loadState: async (id) => harness.persistedStates?.get(id),
        resolveCharacters: async (roster, _character, resolvedOverrides) =>
            roster.map((entry) => {
                if (typeof entry !== 'string') {
                    const profile = registry.get(entry.id);
                    if (!profile) throw new Error(`Fixture ${fixture.id}: unknown ref ${entry.id}`);
                    return profile;
                }
                const key = slug(entry);
                if (resolvedOverrides?.[key]) return registry.get(resolvedOverrides[key].id)!;
                if (script.ambiguous?.includes(entry)) {
                    throw new AmbiguousCharacterError(entry, [
                        registry.get(`card:${key}-1`)!.ref,
                        registry.get(`card:${key}-2`)!.ref,
                    ]);
                }
                return byName(entry);
            }),
        resolveEntryCandidates: async () => (script.library ?? []).map((name) => byName(name)),
        direct: async ({ profiles, maxSpeakers }) => {
            harness.calls.director++;
            directorProfiles = profiles;
            const raw = JSON.stringify({
                sceneGoal: fixture.title,
                participants: script.director.participants.map((participant) => ({
                    characterRefId: idOf(participant.name),
                    mode: participant.mode,
                    attention: participant.attention,
                    reason: 'scripted',
                    direction: participant.direction,
                })),
                observedTransitions: (script.director.observed ?? []).map(transition),
                plannedTransitions: (script.director.planned ?? []).map(transition),
            });
            const decision = parseDirectedDecision(raw, profiles, maxSpeakers);
            directorDone = true;
            return decision;
        },
        reflect,
        compose: async () => {
            if (faultActive() && script.fault === 'cancel-during-composition') {
                controller.abort();
                throw abortError();
            }
            const composition = script.compositions[harness.calls.compositions];
            harness.calls.compositions++;
            if (!composition) return null;
            return { content: compositionJson(composition), usage: { promptTokens: 10 } };
        },
        fetchRemainingTokens: async () =>
            faultActive() && script.fault === 'quota' ? 100 : 1_000_000,
        persistBeat: async (record) => {
            if (tabClosed) return;
            harness.persisted.push(record);
        },
        commitObservedState: async (state) => {
            harness.calls.observedCommits++;
            (harness.persistedStates ??= new Map()).set(state.id, state);
        },
        commitBeat: async ({ messages, storyState }) => {
            if (tabClosed) throw new Error('tab closed');
            harness.calls.commits++;
            harness.committed = { messages, state: storyState };
        },
        assertCurrent: () => {
            if (faultActive() && script.fault === 'branch-switch' && directorDone) {
                throw new DOMException('Beat obsolète.', 'AbortError');
            }
        },
        newId: (() => {
            let counter = 0;
            return () => `${fixture.id}-${++counter}`;
        })(),
        now: () => 1_000,
    };
    return harness;
}

async function run(
    harness: Harness,
    retrySource?: SceneBeatRecord,
    signal?: AbortSignal
): Promise<DirectedBeatOutcome> {
    return executeDirectedBeat(
        {
            conversation: harness.conversation,
            character: ROOT,
            beatHistory: harness.history,
            userName: 'Noah',
            retrySource,
            preferStoredRoster: !!retrySource,
            maxSpeakers: 5,
            reflectionConcurrency: 4,
            composer: { provider: 'nanogpt', model: 'scripted-rp' },
            signal: signal ?? harness.controller.signal,
        },
        harness.deps
    );
}

function speakers(outcome: DirectedBeatOutcome): string[] {
    return outcome.kind === 'committed' ? outcome.speakerNames : [];
}

function assertCommittedInvariants(
    fixture: DirectedSceneEvalCase,
    harness: Harness,
    outcome: DirectedBeatOutcome
) {
    const { expected } = fixture;
    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') return;
    expect(harness.calls.commits).toBe(1);
    expect(harness.committed?.messages.length).toBeGreaterThan(0);
    for (const message of outcome.messages) {
        expect(message.sceneBeatId).toBe(outcome.record.id);
        expect(message.isActiveBranch).toBe(true);
    }
    expect(outcome.messages.at(-1)?.storyStateRevisionId).toBe(outcome.state.id);
    expect(outcome.record.outputMessageIds).toEqual(outcome.messages.map((message) => message.id));

    const roster = storyRoster(outcome.state);
    for (const name of expected.active ?? []) expect(roster).toContain(name);
    for (const name of expected.inactive ?? []) expect(roster).not.toContain(name);
    for (const name of expected.mustSpeak ?? []) expect(speakers(outcome)).toContain(name);
    for (const name of expected.mustNotSpeak ?? []) expect(speakers(outcome)).not.toContain(name);
    if (expected.maxSpeakers != null) {
        expect(speakers(outcome).length).toBeLessThanOrEqual(expected.maxSpeakers);
    }
    if (expected.allowNoDialogue) {
        expect(speakers(outcome)).toHaveLength(0);
        expect(outcome.messages[0].speaker?.kind).toBe('narrator');
    }
    if (expected.location != null) expect(outcome.state.scene.location).toBe(expected.location);
    if (expected.preserveSecret) {
        const secret = expected.preserveSecret.toLocaleLowerCase();
        const fact = outcome.state.knowledge?.find((candidate) =>
            candidate.text.toLocaleLowerCase().includes(secret)
        );
        expect(fact).toBeDefined();
        for (const message of outcome.messages) {
            const text = message.content.toLocaleLowerCase();
            const knows = message.characterRef
                ? fact!.knownBy.includes(message.characterRef.id)
                : false;
            if (!knows) expect(text).not.toContain(secret);
        }
    }

    // Stubs and attention:none participants never get an autonomous reflection.
    for (const name of harness.calls.reflections) {
        const profile = [...harness.registry.values()].find((p) => p.ref.displayName === name);
        expect(profile?.ref.readiness).toBe('ready');
        const participant = outcome.record.decision?.participants.find((p) => p.name === name);
        expect(participant?.attention).not.toBe('none');
    }
}

function assertAtomicFailure(harness: Harness, outcome: DirectedBeatOutcome) {
    expect(outcome.kind).not.toBe('committed');
    expect(harness.calls.commits).toBe(0);
    expect(harness.committed).toBeNull();
    expect(outcome.record.outputMessageIds).toEqual([]);
    expect(outcome.record.composition).toBeUndefined();
}

describe('directed scene corpus replayed through the orchestrator', () => {
    it('covers every critical scenario family', () => {
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

    for (const fixture of DIRECTED_SCENE_EVAL_CORPUS) {
        it(`${fixture.id} — ${fixture.title}`, async () => {
            const harness = buildHarness(fixture);
            const first = await run(harness);

            if (fixture.expected.requireClarification) {
                expect(first.kind).toBe('awaiting-profile');
                if (first.kind !== 'awaiting-profile') return;
                expect(first.ambiguity.candidates).toHaveLength(2);
                expect(harness.calls.director).toBe(0);
                expect(harness.calls.commits).toBe(0);
                // The user picks the second card; the retry must honour it end to end.
                const chosen = first.ambiguity.candidates[1];
                const resolved = buildHarness(fixture, { [slug(first.ambiguity.name)]: chosen });
                const second = await run(resolved, first.record);
                assertCommittedInvariants(fixture, resolved, second);
                if (second.kind === 'committed') {
                    expect(second.messages.some((m) => m.characterRef?.id === chosen.id)).toBe(
                        true
                    );
                }
                return;
            }

            if (!fixture.script.fault) {
                assertCommittedInvariants(fixture, harness, first);
                expect(harness.calls.director).toBe(1);
                return;
            }

            // Every injected fault: no bubble, no commit, a truthful record.
            assertAtomicFailure(harness, first);
            if (fixture.expected.preserveBranch) {
                expect(first.kind).toBe('cancelled');
            }

            switch (fixture.script.fault) {
                case 'quota': {
                    expect(first.kind).toBe('failed');
                    expect(first.record.errors.at(-1)?.stage).toBe('director');
                    expect(first.record.errors.at(-1)?.retryable).toBe(false);
                    expect(harness.calls.reflections).toHaveLength(0);
                    break;
                }
                case 'cancel-during-composition': {
                    expect(first.kind).toBe('cancelled');
                    expect(first.record.status).toBe('cancelled');
                    // Everything before the composer completed and is kept for inspection.
                    expect(first.record.intents.length).toBeGreaterThan(0);
                    break;
                }
                case 'branch-switch': {
                    expect(first.record.status).toBe('cancelled');
                    expect(harness.calls.reflections).toHaveLength(0);
                    expect(harness.calls.compositions).toBe(0);
                    break;
                }
                case 'reflection-failure': {
                    expect(first.kind).toBe('failed');
                    expect(first.record.status).toBe('failed');
                    const failing = fixture.script.failingReflections ?? [];
                    const kept = first.record.intents.map((intent) => intent.name);
                    for (const name of failing) expect(kept).not.toContain(name);
                    expect(kept.length).toBe(harness.calls.reflections.length - failing.length);
                    expect(
                        first.record.errors.filter((error) => error.stage === 'reflection')
                    ).toHaveLength(failing.length);

                    // Targeted retry: only the missing workers run, the decision is reused.
                    const retry = buildHarness(fixture);
                    retry.healthy = true;
                    retry.persistedStates = harness.persistedStates;
                    const second = await run(retry, first.record);
                    expect(retry.calls.director).toBe(0);
                    expect(retry.calls.reflections).toEqual(failing);
                    assertCommittedInvariants(fixture, retry, second);
                    break;
                }
                case 'reload': {
                    // The tab died mid-reflection: the last durable record still says
                    // "reflecting". Startup marks it interrupted; the user retries.
                    const durable = harness.persisted.at(-1)!;
                    expect(durable.status).toBe('reflecting');
                    const interrupted: SceneBeatRecord = {
                        ...durable,
                        status: 'interrupted',
                        errors: [
                            ...durable.errors,
                            {
                                stage: 'commit',
                                message: 'Génération interrompue par le rechargement.',
                                retryable: true,
                            },
                        ],
                    };
                    const retry = buildHarness(fixture);
                    retry.healthy = true;
                    retry.persistedStates = harness.persistedStates;
                    const second = await run(retry, interrupted);
                    expect(retry.calls.director).toBe(0);
                    assertCommittedInvariants(fixture, retry, second);
                    break;
                }
            }
        });
    }
});
