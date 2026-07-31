/**
 * Prompt-cache stability contract.
 *
 * The payload has three zones:
 *   [ stable system ] [ history window (sticky cut) ] [ dynamic context + instructions ]
 *
 * Provider prompt caching keys on the leading byte-stable prefix, so:
 *  1. The system prompt must be identical between turns when nothing durable changed.
 *  2. Per-turn material (lorebook, RAG, scratchpad, momentum, arc cursor) must live in the
 *     final (dynamic) message, never in the system prompt.
 *  3. The history window must NOT slide one message at a time: it moves only on overflow,
 *     and then cuts a whole block (hysteresis) anchored on a message id.
 */

import { describe, it, expect } from 'vitest';
import { buildConversationPayload } from '@/lib/ai/payload-builder';
import { buildRAGEnhancedPayload } from '@/lib/ai/context-builder';
import { LEGACY_DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/types/preset';
import type { CharacterCard } from '@/types/character';
import type { Message } from '@/types/chat';
import type { APIPreset } from '@/types/preset';

const card: CharacterCard = {
    id: 'c1',
    name: 'Mara',
    description: 'a weary caravan guard',
    personality: 'gruff but fair',
    scenario: 'a dusty trade road',
    first_mes: '',
    mes_example: '',
};



let counter = 0;
function msg(content: string, role: 'user' | 'assistant' = 'user'): Message {
    counter++;
    return {
        id: `m${counter}`,
        conversationId: 'conv1',
        parentId: null,
        role,
        content,
        isActiveBranch: true,
        createdAt: new Date(0),
        messageOrder: counter,
        regenerationIndex: 0,
    };
}

function preset(overrides: Partial<APIPreset> = {}): APIPreset {
    return { id: 'p', name: 'p', createdAt: new Date(0), ...overrides } as unknown as APIPreset;
}

const lore = [{ keys: ['Konoha'], content: 'The hidden leaf village.', enabled: true }];

describe('stable/dynamic zone split', () => {
    it('keeps the system prompt byte-identical when only per-turn material changes', async () => {
        const base = {
            mode: 'generate' as const,
            character: card,

            activePreset: preset(),
            activeEngine: null,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        };
        const turn1 = await buildConversationPayload({
            ...base,
            activeEntries: lore,
            history: [msg('hello')],
            scratchpad: 'plan A',
            storyGuidance: 'go darker',
        });
        const turn2 = await buildConversationPayload({
            ...base,
            activeEntries: [], // lorebook match changed
            history: [msg('hello'), msg('hi', 'assistant'), msg('more')],
            scratchpad: 'plan B (changed)',
            storyGuidance: 'go lighter',
        });
        expect(turn1.systemPrompt).toBe(turn2.systemPrompt);
        expect(turn1.messagesPayload[0].content).toBe(turn2.messagesPayload[0].content);
    });

    it('renders lorebook, scratchpad and guidance in the FINAL message, not the system', async () => {
        const { messagesPayload, systemPrompt } = await buildConversationPayload({
            mode: 'generate',
            character: card,

            activeEntries: lore,
            history: [msg('tell me about Konoha')],
            activePreset: preset(),
            activeEngine: null,
            scratchpad: 'SCRATCH_PLAN',
            storyGuidance: 'GUIDANCE_MARKER',
            canonOptions: { momentumNudge: 'MOMENTUM_MARKER' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const last = messagesPayload[messagesPayload.length - 1].content;
        for (const marker of ['hidden leaf village', 'SCRATCH_PLAN', 'GUIDANCE_MARKER', 'MOMENTUM_MARKER']) {
            expect(systemPrompt).not.toContain(marker);
            expect(last).toContain(marker);
        }
        expect(last).toContain('CURRENT CONTEXT');
    });

    it('honours a CUSTOM template that places {{lorebook}} itself (degraded caching accepted)', async () => {
        const { systemPrompt } = await buildConversationPayload({
            mode: 'generate',
            character: card,

            activeEntries: lore,
            history: [msg('hello')],
            activePreset: preset({ systemPromptTemplate: 'CUSTOM {{lorebook}}' }),
            activeEngine: null,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        expect(systemPrompt).toContain('hidden leaf village');
    });

    it('upgrades pristine copies of the LEGACY default template to dynamic placement', async () => {
        const { systemPrompt, messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,

            activeEntries: lore,
            history: [msg('hello')],
            activePreset: preset({ systemPromptTemplate: LEGACY_DEFAULT_SYSTEM_PROMPT_TEMPLATE }),
            activeEngine: null,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        expect(systemPrompt).not.toContain('hidden leaf village');
        expect(messagesPayload[messagesPayload.length - 1].content).toContain(
            'hidden leaf village'
        );
    });
});

describe('continue-in-place (providers without prefill)', () => {
    it('appends the CONTINUE instruction LAST so it beats the user post-history', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,

            activeEntries: [],
            history: [msg('hello'), msg('The story begins…', 'assistant')],
            activePreset: preset({ postHistoryInstructions: 'USER_POSTHISTORY_MARKER' }),
            activeEngine: null,
            continueFromAssistant: true,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const last = messagesPayload[messagesPayload.length - 1].content;
        expect(last).toContain('[CONTINUE —');
        expect(last.indexOf('USER_POSTHISTORY_MARKER')).toBeLessThan(last.indexOf('[CONTINUE —'));
        // The incomplete assistant message stays in the history.
        expect(messagesPayload[messagesPayload.length - 2].content).toBe('The story begins…');
    });

    it('omits the CONTINUE instruction in normal generation', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,

            activeEntries: [],
            history: [msg('hello')],
            activePreset: preset(),
            activeEngine: null,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        expect(messagesPayload.map((m) => m.content).join('\n')).not.toContain('[CONTINUE —');
    });
});

describe('unified ensemble scene (single-call style)', () => {
    it('appends the ENSEMBLE SCENE block with roster, goal and per-character directions', async () => {
        const { messagesPayload, systemPrompt } = await buildConversationPayload({
            mode: 'generate',
            character: card,
            activeEntries: [],
            history: [msg('hello')],
            activePreset: preset(),
            activeEngine: null,
            sceneEnsemble: {
                roster: ['Rukia Kuchiki', 'Renji Abarai'],
                directions: [
                    { name: 'Rukia Kuchiki', direction: 'DIRECTION_RUKIA' },
                    { name: 'Renji Abarai' },
                ],
                sceneGoal: 'GOAL_MARKER',
                narrationHint: 'NARRATION_HINT',
                userName: 'Alex',
            },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const last = messagesPayload[messagesPayload.length - 1].content;
        expect(last).toContain('[ENSEMBLE SCENE');
        expect(last).toContain('Rukia Kuchiki, Renji Abarai');
        expect(last).toContain('GOAL_MARKER');
        expect(last).toContain('NARRATION_HINT');
        expect(last).toContain('- Rukia Kuchiki: DIRECTION_RUKIA');
        expect(last).toContain('- Renji Abarai: react in character');
        expect(last).toContain('speak for Alex');
        // The stable prefix must not carry the per-beat block.
        expect(systemPrompt).not.toContain('ENSEMBLE SCENE');
    });
});

describe('scene narrator regeneration', () => {
    it('adds the narrator-only contract (no dialogue) when regenerating a narrator message', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,
            activeEntries: [],
            history: [msg('hello')],
            activePreset: preset(),
            activeEngine: null,
            sceneNarrator: true,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const last = messagesPayload[messagesPayload.length - 1].content;
        expect(last).toContain('Write ONLY the narrator');
        expect(last).toContain('No character dialogue');
    });
});

describe('history window hysteresis', () => {
    const opts = { maxContextTokens: 450, maxOutputTokens: 100 };
    const longHistory = Array.from({ length: 40 }, (_, i) =>
        msg(`message number ${i} with some padding words to weigh a few tokens`)
    );

    it('keeps the whole history (no cut) when it fits', () => {
        const r = buildRAGEnhancedPayload('SYS', [], longHistory.slice(0, 3), {
            maxContextTokens: 100000,
            maxOutputTokens: 100,
        });
        expect(r.suggestedCutMessageId).toBeUndefined();
        expect(r.includedMessageCount).toBe(3);
        expect(r.stablePrefixLength).toBe(4); // system + 3 messages
    });

    it('cuts a whole block on overflow and reuses the anchor on later turns', () => {
        const first = buildRAGEnhancedPayload('SYS', [], longHistory, opts);
        expect(first.suggestedCutMessageId).toBeDefined();
        expect(first.includedMessageCount).toBeLessThan(longHistory.length);

        // Next turn: one new message, anchor applied → same window start, no new cut.
        const nextHistory = [...longHistory, msg('the newest message')];
        const second = buildRAGEnhancedPayload('SYS', [], nextHistory, {
            ...opts,
            historyCutMessageId: first.suggestedCutMessageId,
        });
        expect(second.suggestedCutMessageId).toBeUndefined();
        // The anchored refit must preserve the cache-prefix CONTRACT: same prefix length
        // plus exactly the one new message (this assertion had been orphaned to a bare //).
        expect(second.stablePrefixLength).toBe(first.stablePrefixLength + 1);

        // Window starts at the same anchored message → stable prefix.
        expect(second.messagesPayload[1].content).toBe(
            first.messagesPayload[1].content
        );
        expect(second.includedMessageCount).toBe(first.includedMessageCount + 1);
    });

    it('leaves headroom: the refit uses ~75% of the budget', () => {
        const r = buildRAGEnhancedPayload('SYS', [], longHistory, opts);
        const budget = opts.maxContextTokens - opts.maxOutputTokens - 1; // minus SYS≈1
        expect(r.tokenBreakdown.history).toBeLessThanOrEqual(Math.floor(budget * 0.75));
        // Lower bound: a refit that includes ZERO messages (real starvation regression)
        // must fail this test, not pass the one-sided upper bound.
        expect(r.includedMessageCount).toBeGreaterThan(0);
        expect(r.tokenBreakdown.history).toBeGreaterThan(Math.floor(budget * 0.35));
    });
});
