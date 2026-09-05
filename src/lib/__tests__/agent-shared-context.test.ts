/**
 * The seams that were left open by the first pass: what the agent contracts actually say,
 * and whether the classic Director and the post-beat maintenance agents really go through
 * the shared payload rather than their old private prompts.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type { SceneBeatRecord, StoryState } from '@/types/scene';
import { directorContract, reflectionContract } from '@/lib/ai/directed-scene';
import type { ResolvedCharacterProfile } from '@/lib/ai/story-state';
import { directorDecide } from '@/lib/ai/scene-orchestrator';
import { maintainNarrativeAfterBeat } from '@/lib/ai/narrative-maintenance';
import { backgroundAICall } from '@/lib/ai/background-ai';
import type { AgentPayload, RetrievalStack, SamplerParams } from '@/lib/ai/conversation-context';
import { saveConversation, saveMessage, saveSceneBeat, saveStoryState } from '@/lib/db';
import { useChatStore } from '@/stores/chat-store';

vi.mock('@/lib/ai/background-ai', () => ({
    backgroundAICall: vi.fn(async () => ({
        content: '{"speakers":[],"sceneSummary":"ok","openThreads":[],"nextMoves":["x"]}',
        usedModel: 'mock',
        usedProvider: 'openrouter',
    })),
    resolveBackgroundRoute: vi.fn(async () => null),
}));

const route = {
    provider: 'openrouter' as const,
    model: 'mock',
    billingScope: 'free' as const,
    routing: 'openrouter-free' as const,
    resolvedAt: 0,
};
const sampler: SamplerParams = {
    temperature: 0.5,
    maxTokens: 256,
    enableReasoning: false,
    useFlexTier: false,
};

const root: ResolvedCharacterProfile = {
    ref: {
        id: 'card:root',
        source: 'root-card',
        sourceId: 'root',
        displayName: 'Mara',
        readiness: 'ready',
    },
    description: 'ROOT_DESC',
    personality: 'ROOT_PERSONALITY',
};
const libraryCard: ResolvedCharacterProfile = {
    ref: {
        id: 'card:bob',
        source: 'character-card',
        sourceId: 'bob',
        displayName: 'Bob',
        readiness: 'ready',
    },
    description: 'BOB_DESC',
    personality: 'BOB_PERSONALITY',
};
const dossier: ResolvedCharacterProfile = {
    ref: { id: 'canon:w:zed', source: 'canon-dossier', displayName: 'Zed', readiness: 'ready' },
    description: 'ZED_DESC',
};

const state: StoryState = {
    id: 'state-1',
    conversationId: 'c1',
    revision: 1,
    source: 'migration',
    scene: {
        location: 'Quai',
        participants: [
            { character: root.ref, presence: 'onstage', agency: 'active' },
            { character: libraryCard.ref, presence: 'onstage', agency: 'active' },
            { character: dossier.ref, presence: 'onstage', agency: 'active' },
        ],
    },
    plot: {
        arcWork: 'ARC_WORK',
        currentBeat: 'CURRENT_BEAT',
        objective: 'OBJECTIVE',
        openThreads: ['THREAD_1'],
        nextMoves: ['NEXT_MOVE_1'],
    },
    knowledge: [
        { id: 'k1', text: 'PUBLIC_FACT', visibility: 'public', knownBy: [] },
        { id: 'k2', text: 'BOB_SECRET', visibility: 'private', knownBy: [libraryCard.ref.id] },
        { id: 'k3', text: 'ZED_SECRET', visibility: 'private', knownBy: [dossier.ref.id] },
    ],
    locks: {},
    createdAt: 0,
};

const relationships = [
    {
        from: 'Bob',
        to: 'Mara',
        axes: { trust: 10, affection: 20, respect: 30, attraction: 40 },
        ledger: [],
    },
];

describe('agent contracts carry what the digest used to lose', () => {
    it('gives the director ids, the four bonds axes, the arc and the medium-term plan', () => {
        const contract = directorContract({
            state,
            profiles: [root, libraryCard, dossier],
            userName: 'Alex',
            relationships,
            maxSpeakers: 3,
        });
        for (const marker of [
            'card:root',
            'card:bob',
            'canon:w:zed',
            '"attraction":40',
            'ARC_WORK',
            'CURRENT_BEAT',
            'NEXT_MOVE_1',
            'THREAD_1',
        ]) {
            expect(contract, `missing ${marker}`).toContain(marker);
        }
        // The transcript is the history above, never a digest inside the contract.
        expect(contract).not.toContain('recentMessages');
        // A separate library card is NOT in the shared system prompt: it keeps an identity.
        expect(contract).toContain('BOB_DESC');
        // The root card and an on-stage dossier are already described above: no duplicate.
        expect(contract).not.toContain('ROOT_DESC');
        expect(contract).not.toContain('ZED_DESC');
    });

    it('gives a character its own journal, its bonds and only the facts it may know', () => {
        const contract = reflectionContract({
            profile: libraryCard,
            participant: {
                characterRefId: libraryCard.ref.id,
                name: 'Bob',
                mode: 'speak',
                attention: 'full',
                reason: 'test',
                direction: 'DIRECTION_MARKER',
            },
            state,
            relationships,
            rpJournal: ['JOURNAL_NOTE_1'],
        });
        for (const marker of [
            'BOB_DESC',
            'JOURNAL_NOTE_1',
            '"attraction":40',
            'PUBLIC_FACT',
            'BOB_SECRET',
            'DIRECTION_MARKER',
            'THREAD_1',
        ]) {
            expect(contract, `missing ${marker}`).toContain(marker);
        }
        // Another character's private fact never rides along.
        expect(contract).not.toContain('ZED_SECRET');
    });

    it('does not repeat the root card or an injected dossier inside a reflection', () => {
        const participant = {
            characterRefId: root.ref.id,
            name: 'Mara',
            mode: 'speak' as const,
            attention: 'brief' as const,
            reason: 'test',
        };
        expect(reflectionContract({ profile: root, participant, state })).not.toContain(
            'ROOT_DESC'
        );
        expect(
            reflectionContract({
                profile: dossier,
                participant: { ...participant, characterRefId: dossier.ref.id, name: 'Zed' },
                state,
            })
        ).not.toContain('ZED_DESC');
    });
});

const sharedPayload = (contract: string): AgentPayload => ({
    messages: [
        { role: 'system', content: 'SHARED_SYSTEM' },
        { role: 'user', content: 'transcript' },
        { role: 'system', content: contract },
    ],
    stablePrefixLength: 2,
    windowStartMessageId: 'm1',
    includedMessageCount: 1,
    tokenBreakdown: {
        system: 1,
        rag: 0,
        history: 1,
        postHistory: 1,
        total: 3,
        dynamicReserve: 0,
        historyBudget: 10,
        historyTarget: 9,
        historyHeadroom: 8,
    },
    historyWindow: { action: 'unchanged', reason: 'test', recoverableMessageCount: 0 },
});

beforeEach(() => {
    vi.mocked(backgroundAICall).mockClear();
});

describe('the classic Troupe director on the shared context', () => {
    it('sends the shared messages with the decision request as the final block', async () => {
        const built: string[] = [];
        await directorDecide({
            roster: ['Bob', 'Zed', 'Mara'],
            userName: 'Alex',
            recentMessages: [],
            relationships,
            arcPosition: 'ARC_POS',
            maxSpeakers: 2,
            context: {
                route,
                sampler,
                buildPayload: async (contract) => {
                    built.push(contract);
                    return sharedPayload(contract);
                },
            },
        });
        expect(built).toHaveLength(1);
        expect(built[0]).toContain('On stage: Bob, Zed, Mara');
        expect(built[0]).toContain('ARC_POS');
        expect(built[0]).toContain('attraction 40');
        const call = vi.mocked(backgroundAICall).mock.calls[0][0];
        expect(call.messages?.[0].content).toBe('SHARED_SYSTEM');
        expect(call.messages?.at(-1)?.content).toContain('scene DIRECTOR');
        expect(call.sampler).toEqual(sampler);
        expect(call.route).toEqual(route);
    });

    it('keeps the old digest prompt when no context is supplied', async () => {
        await directorDecide({ roster: ['Bob'], userName: 'Alex', recentMessages: [] });
        const call = vi.mocked(backgroundAICall).mock.calls[0][0];
        expect(call.messages).toBeUndefined();
        expect(call.userPrompt).toContain('On stage: Bob');
    });
});

describe('the auditor and the story director on the shared context', () => {
    const character: CharacterCard = {
        id: 'root',
        name: 'Mara',
        description: 'ROOT_DESC',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
    };

    afterEach(() => {
        useChatStore.setState({ activeConversationId: null, conversations: [], messages: [] });
    });

    it('build both prompts from the shared stack, beat text inside the final block', async () => {
        const suffix = crypto.randomUUID();
        const conversation: Conversation = {
            id: `conv-${suffix}`,
            characterId: character.id,
            title: 'Maintenance',
            createdAt: new Date(0),
            updatedAt: new Date(0),
        };
        const trigger: Message = {
            id: `u-${suffix}`,
            conversationId: conversation.id,
            parentId: null,
            role: 'user',
            content: 'Je pousse la porte.',
            isActiveBranch: true,
            createdAt: new Date(0),
            messageOrder: 1,
            regenerationIndex: 0,
        };
        const committedState: StoryState = {
            ...state,
            id: `state-${suffix}`,
            conversationId: conversation.id,
            anchorMessageId: `a-${suffix}`,
        };
        const bubble: Message = {
            id: `a-${suffix}`,
            conversationId: conversation.id,
            parentId: trigger.id,
            role: 'assistant',
            content: 'BEAT_TEXT_MARKER',
            isActiveBranch: true,
            createdAt: new Date(1),
            messageOrder: 2,
            regenerationIndex: 0,
            sceneBeatId: `beat-${suffix}`,
            storyStateRevisionId: committedState.id,
        };
        const beat: SceneBeatRecord = {
            id: `beat-${suffix}`,
            conversationId: conversation.id,
            triggerMessageId: trigger.id,
            branchTipId: bubble.id,
            generationId: 'g',
            committedStoryStateRevisionId: committedState.id,
            status: 'committed',
            backgroundRoute: route,
            intents: [],
            outputMessageIds: [bubble.id],
            errors: [],
            timings: {},
            createdAt: 0,
            updatedAt: 0,
        };
        await saveConversation(conversation);
        await saveMessage(trigger);
        await saveMessage(bubble);
        await saveStoryState(committedState);
        await saveSceneBeat(beat);
        useChatStore.setState({
            activeConversationId: conversation.id,
            conversations: [conversation],
            messages: [trigger, bubble],
        });

        const stack: RetrievalStack = {
            canonOptions: { canonDossiers: [], relationshipBlock: 'RELATIONSHIP_MARKER' },
            activeEntries: [],
        };
        await maintainNarrativeAfterBeat({
            character,
            conversationId: conversation.id,
            beatId: beat.id,
            targetMessageId: bubble.id,
            beatContent: 'Mara: BEAT_TEXT_MARKER',
            stalled: false,
            history: [trigger],
            sceneContext: {
                stack,
                conversation,
                preset: null,
                engine: null,
                persona: { name: 'Alex', bio: '' },
                provider: 'openrouter',
                learnedBanList: ['BAN_MARKER'],
                sampler,
            },
        });

        const calls = vi.mocked(backgroundAICall).mock.calls.map(([options]) => options);
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect(call.messages).toBeDefined();
            expect(call.messages![0].content).toContain('ROOT_DESC');
            expect(call.messages![0].content).toContain('BAN_MARKER');
            expect(call.sampler).toEqual(sampler);
            expect(call.route).toEqual(route);
            expect(call.messages!.map((m) => m.content).join('\n')).toContain(
                'RELATIONSHIP_MARKER'
            );
        }
        expect(calls[0].messages!.at(-1)!.content).toContain('[CONTINUITY AUDITOR]');
        expect(calls[0].messages!.at(-1)!.content).toContain('BEAT_TEXT_MARKER');
        expect(calls[1].messages!.at(-1)!.content).toContain('[STORY DIRECTOR]');
    });
});
