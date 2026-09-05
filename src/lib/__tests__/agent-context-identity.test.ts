/**
 * The contract this whole change exists to enforce: an invisible agent of a directed beat
 * sees exactly what the writer sees. Same card, same canon, same lorebook, same Chronicle,
 * same history window, same preset — only the final instruction differs.
 *
 * These assertions are byte-level on purpose. A digest that is "roughly the same" is what the
 * pipeline had before, and it is why the Director could not remember the story.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterCard, LorebookEntry } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type { APIPreset } from '@/types/preset';
import { DEFAULT_PRESETS } from '@/types/preset';
import { buildConversationPayload } from '@/lib/ai/payload-builder';
import {
    buildAgentPayload,
    buildSamplerParams,
    withSpeakerPrefixes,
    type RetrievalStack,
} from '@/lib/ai/conversation-context';

const card: CharacterCard = {
    id: 'card-1',
    name: 'Mara',
    description: 'DESC_MARKER — a gruff but fair caravan guard.',
    personality: 'gruff but fair',
    scenario: 'The road to Vantry.',
    first_mes: 'You again.',
    mes_example: '',
};

const preset = (): APIPreset => ({
    ...DEFAULT_PRESETS[1],
    id: 'preset-1',
    createdAt: new Date(0),
    temperature: 0.77,
    topP: 0.91,
    topK: 42,
    minP: 0.05,
    frequencyPenalty: 0.3,
    presencePenalty: 0.2,
    repetitionPenalty: 1.1,
    stoppingStrings: ['###'],
    maxContextTokens: 8192,
    maxOutputTokens: 512,
    enableReasoning: true,
    useFlexTier: true,
});

const conversation: Conversation = {
    id: 'conversation-1',
    characterId: card.id,
    title: 'Identity',
    storyGuidance: 'GUIDANCE_MARKER',
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

function message(id: string, role: 'user' | 'assistant', content: string, order: number): Message {
    return {
        id,
        conversationId: conversation.id,
        parentId: null,
        role,
        content,
        isActiveBranch: true,
        createdAt: new Date(order),
        messageOrder: order,
        regenerationIndex: 0,
    };
}

const history: Message[] = [
    message('m1', 'user', 'We reach the gate at dusk.', 1),
    message('m2', 'assistant', 'The guards wave you through.', 2),
    message('m3', 'user', 'I ask Mara what she saw.', 3),
];

const lorebookEntry: LorebookEntry = {
    keys: ['gate'],
    content: 'LOREBOOK_MARKER — the gate is watched at night.',
    enabled: true,
};

const stack: RetrievalStack = {
    canonOptions: {
        canonDossiers: [],
        rpJournal: { Mara: ['JOURNAL_MARKER — she owes the player a debt.'] },
        relationshipBlock: 'RELATIONSHIP_MARKER',
    },
    activeEntries: [lorebookEntry],
    chronicle: async () => ({
        text: 'CHRONICLE_MARKER — earlier, the caravan lost two horses.',
        stats: {
            arcs: 0,
            sections: 0,
            fragments: 1,
            omittedArcs: 0,
            omittedSections: 0,
            uncoveredEvictedMessages: 0,
        },
    }),
};

const persona = { name: 'Alex', bio: 'a ranger' };

const buildFor = (agentContract: string, frozenWindow?: { startMessageId: string }) =>
    buildAgentPayload({
        stack,
        character: card,
        conversation,
        history,
        preset: preset(),
        engine: null,
        persona,
        provider: 'openrouter',
        learnedBanList: ['BAN_MARKER'],
        agentContract,
        frozenWindow,
    });

describe('agents share the writer’s context', () => {
    it('gives an agent the same system prompt and history as the composer, differing only in the final block', async () => {
        const composer = await buildFor('[DIRECTED ENSEMBLE COMPOSITION] write the beat');
        const director = await buildFor('[BEAT DIRECTOR] decide who acts', {
            startMessageId: composer.windowStartMessageId!,
        });

        // The cacheable prefix — system + history — is byte-identical.
        expect(director.messages.slice(0, director.stablePrefixLength)).toEqual(
            composer.messages.slice(0, composer.stablePrefixLength)
        );
        expect(director.stablePrefixLength).toBe(composer.stablePrefixLength);
        expect(director.includedMessageCount).toBe(composer.includedMessageCount);

        // Only the last message differs.
        expect(director.messages.at(-1)!.content).not.toBe(composer.messages.at(-1)!.content);
        expect(director.messages.at(-1)!.content).toContain('[BEAT DIRECTOR]');
    });

    it('carries every memory system the writer gets into the agent payload', async () => {
        const agent = await buildFor('[BEAT DIRECTOR] decide who acts');
        const whole = agent.messages.map((m) => m.content).join('\n');

        // The card and the Style Guard are in the system prompt; the per-turn memories are
        // in the final block.
        expect(agent.messages[0].content).toContain('DESC_MARKER');
        expect(agent.messages[0].content).toContain('BAN_MARKER');
        for (const marker of [
            'CHRONICLE_MARKER',
            'LOREBOOK_MARKER',
            'JOURNAL_MARKER',
            'RELATIONSHIP_MARKER',
            'GUIDANCE_MARKER',
        ]) {
            expect(whole, `missing ${marker}`).toContain(marker);
        }
        // The conversation transcript itself is present, not a truncated digest.
        expect(whole).toContain('I ask Mara what she saw.');
        expect(whole).toContain('The guards wave you through.');
    });

    it('never asks an agent for a scratchpad', async () => {
        const agent = await buildFor('[BEAT DIRECTOR] decide who acts');
        expect(agent.messages.map((m) => m.content).join('\n')).not.toContain('<scratchpad>');
    });

    it('replays the frozen window even when a fatter contract would have trimmed it', async () => {
        const planner = await buildFor('[SHORT]');
        const fat = await buildFor('[FAT] ' + 'x '.repeat(400), {
            startMessageId: planner.windowStartMessageId!,
        });
        expect(fat.includedMessageCount).toBe(planner.includedMessageCount);
        expect(fat.messages.slice(0, fat.stablePrefixLength)).toEqual(
            planner.messages.slice(0, planner.stablePrefixLength)
        );
    });

    it('reports a divergence instead of silently sending a different transcript', async () => {
        // A contract far larger than the whole context budget cannot fit beside the window.
        const planned = await buildFor('[SHORT]');
        const huge = await buildFor('[HUGE] ' + 'token '.repeat(20_000), {
            startMessageId: planned.windowStartMessageId!,
        });
        expect(huge.historyWindow.action).toBe('transient-trim');
    });
});

describe('preset parameters reach the agents', () => {
    it('derives one sampler body used by both the visible fetch and the agents', () => {
        const sampler = buildSamplerParams(preset(), {
            temperature: 0.1,
            enableReasoning: false,
            useFlexTier: false,
        });
        expect(sampler).toEqual({
            temperature: 0.77,
            maxTokens: 512,
            topP: 0.91,
            topK: 42,
            frequencyPenalty: 0.3,
            presencePenalty: 0.2,
            repetitionPenalty: 1.1,
            minP: 0.05,
            stoppingStrings: ['###'],
            enableReasoning: true,
            useFlexTier: true,
        });
    });

    it('falls back to the global settings when no preset is active', () => {
        const sampler = buildSamplerParams(null, {
            temperature: 0.42,
            enableReasoning: true,
            useFlexTier: true,
        });
        expect(sampler.temperature).toBe(0.42);
        expect(sampler.enableReasoning).toBe(true);
        expect(sampler.useFlexTier).toBe(true);
        expect(sampler.maxTokens).toBe(2048);
    });

    it('builds the agent system prompt through the same path as a normal generation', async () => {
        const agent = await buildFor('[BEAT DIRECTOR]');
        const composer = await buildConversationPayload({
            mode: 'generate',
            character: card,
            activeEntries: stack.activeEntries,
            history: withSpeakerPrefixes(history),
            recentMessages: history,
            activePreset: preset(),
            activeEngine: null,
            userPersona: persona,
            learnedBanList: ['BAN_MARKER'],
            canonOptions: stack.canonOptions,
            enableScratchpad: false,
            activeProvider: 'openrouter',
            maxContextTokens: 8192,
            maxOutputTokens: 512,
        });
        // Byte-identical: same card, same canon, same preset template, same engine.
        expect(agent.messages[0].content).toBe(composer.systemPrompt);
    });
});
