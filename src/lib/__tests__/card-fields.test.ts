import { describe, it, expect } from 'vitest';
import { buildConversationPayload } from '@/lib/ai/payload-builder';
import { trimExampleDialogue } from '@/lib/ai/context-builder';
import { countTokens } from '@/lib/tokenizer';
import type { CharacterCard } from '@/types/character';
import type { Message } from '@/types/chat';
import type { APIPreset } from '@/types/preset';
import type { ContextSection } from '@/types/rag';

const card: CharacterCard = {
    id: 'c1',
    name: 'Mara',
    description: 'DESC_MARKER a weary caravan guard',
    personality: 'gruff but fair',
    scenario: 'a dusty trade road',
    first_mes: '',
    mes_example: '<START>\n{{user}}: Any trouble on the road?\nMara: EXAMPLE_MARKER "Trouble finds us, not the other way round."',
};

function userMsg(content: string, id = 'm1'): Message {
    return {
        id,
        conversationId: 'conv1',
        parentId: null,
        role: 'user',
        content,
        isActiveBranch: true,
        createdAt: new Date(0),
        messageOrder: 1,
        regenerationIndex: 0,
    };
}

function preset(overrides: Partial<APIPreset> = {}): APIPreset {
    return { id: 'p', name: 'p', createdAt: new Date(0), ...overrides } as unknown as APIPreset;
}

describe('mes_example injection', () => {
    it('reaches the system prompt for generation, byte-stable across builds', async () => {
        const build = () =>
            buildConversationPayload({
                mode: 'generate',
                character: card,
                activeEntries: [],
                history: [userMsg('hello')],
                activePreset: preset(),
                activeEngine: null,
                maxContextTokens: 8192,
                maxOutputTokens: 1000,
            });
        const a = await build();
        const b = await build();
        expect(a.systemPrompt).toContain('EXAMPLE_MARKER');
        expect(a.systemPrompt).toContain('EXAMPLE DIALOGUE');
        // Byte-stable: the cache prefix must not flap between turns.
        expect(a.systemPrompt).toBe(b.systemPrompt);
    });

    it('is ABSENT from the impersonation ghost-writer system', async () => {
        const { systemPrompt } = await buildConversationPayload({
            mode: 'impersonate',
            character: card,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: null,
            userPersona: { name: 'Alex', bio: 'a traveler' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        expect(systemPrompt).not.toContain('EXAMPLE_MARKER');
        expect(systemPrompt).not.toContain('DESC_MARKER');
    });

    it('trimExampleDialogue is deterministic and cuts at <START> boundaries', () => {
        const block = (n: number) => `Speaker: ${'lorem ipsum dolor '.repeat(40)}BLOCK_${n}`;
        const text = [1, 2, 3, 4, 5].map((n) => `<START>\n${block(n)}`).join('\n');
        const capped = trimExampleDialogue(text, 300);
        expect(capped).toBe(trimExampleDialogue(text, 300)); // deterministic
        expect(countTokens(capped)).toBeLessThanOrEqual(300);
        expect(capped).toContain('BLOCK_1');
        expect(capped).not.toContain('BLOCK_5');
        // Small input passes through untouched.
        expect(trimExampleDialogue('short', 300)).toBe('short');
    });
});

describe('card system_prompt (V2)', () => {
    it('without {{original}}: appended after the card body', async () => {
        const { systemPrompt } = await buildConversationPayload({
            mode: 'generate',
            character: { ...card, system_prompt: 'CARD_SYSTEM_MARKER obey {{char}}' },
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: null,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        expect(systemPrompt).toContain('CARD_SYSTEM_MARKER obey Mara');
        // The card body survives (append, not replace).
        expect(systemPrompt).toContain('DESC_MARKER');
        expect(systemPrompt.indexOf('DESC_MARKER')).toBeLessThan(
            systemPrompt.indexOf('CARD_SYSTEM_MARKER')
        );
    });

    it('with {{original}}: the card controls the template and splices the default in', async () => {
        const { systemPrompt } = await buildConversationPayload({
            mode: 'generate',
            character: {
                ...card,
                system_prompt: 'CARD_PREFIX_MARKER\n{{original}}\nCARD_SUFFIX_MARKER',
            },
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: null,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        expect(systemPrompt).toContain('CARD_PREFIX_MARKER');
        expect(systemPrompt).toContain('CARD_SUFFIX_MARKER');
        expect(systemPrompt).toContain('DESC_MARKER'); // default template spliced in
        expect(systemPrompt).not.toContain('{{original}}');
    });

    it('is ignored for impersonation', async () => {
        const { systemPrompt } = await buildConversationPayload({
            mode: 'impersonate',
            character: { ...card, system_prompt: 'CARD_SYSTEM_MARKER' },
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: null,
            userPersona: { name: 'Alex', bio: 'a traveler' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        expect(systemPrompt).not.toContain('CARD_SYSTEM_MARKER');
    });
});

describe('card post_history_instructions (V2)', () => {
    it('follows the preset post-history in the final dynamic message', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: { ...card, post_history_instructions: 'CARD_PHI_MARKER for {{user}}' },
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset({ postHistoryInstructions: 'PRESET_PHI_MARKER' }),
            activeEngine: null,
            userPersona: { name: 'Alex', bio: '' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const last = messagesPayload[messagesPayload.length - 1];
        expect(last.content).toContain('PRESET_PHI_MARKER');
        expect(last.content).toContain('CARD_PHI_MARKER for Alex');
        expect(last.content.indexOf('PRESET_PHI_MARKER')).toBeLessThan(
            last.content.indexOf('CARD_PHI_MARKER')
        );
    });

    it('{{original}} splices the preset post-history inside the card block', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: {
                ...card,
                post_history_instructions: 'BEFORE_MARKER {{original}} AFTER_MARKER',
            },
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset({ postHistoryInstructions: 'PRESET_PHI_MARKER' }),
            activeEngine: null,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const last = messagesPayload[messagesPayload.length - 1];
        expect(last.content).toContain('BEFORE_MARKER PRESET_PHI_MARKER AFTER_MARKER');
    });

    it('never reaches impersonation', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'impersonate',
            character: { ...card, post_history_instructions: 'CARD_PHI_MARKER' },
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: null,
            userPersona: { name: 'Alex', bio: '' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const joined = messagesPayload.map((m) => m.content).join('\n');
        expect(joined).not.toContain('CARD_PHI_MARKER');
    });
});

describe('RAG budget vs history starvation', () => {
    it('small context + big system: history keeps messages, RAG is capped by real room', async () => {
        // A system prompt heavy enough that the old 15%-of-total floor (614 tokens here)
        // exceeded the actual remaining room and evicted the entire history.
        const bigCard: CharacterCard = {
            ...card,
            description: 'guard duty roster entry. '.repeat(320), // ≈ 1700+ tokens
        };
        const history = Array.from({ length: 8 }, (_, i) =>
            userMsg(`beat number ${i}: the caravan moves on through dust`, `m${i}`)
        );
        let grantedBudget = 0;
        const { includedMessageCount, tokenBreakdown } = await buildConversationPayload({
            mode: 'generate',
            character: bigCard,
            activeEntries: [],
            history,
            activePreset: preset(),
            activeEngine: null,
            maxContextTokens: 4096,
            maxOutputTokens: 1024,
            retrieveRag: async (budget): Promise<ContextSection[]> => {
                grantedBudget = budget;
                return [
                    {
                        priority: 1,
                        content: Array(budget).fill('mem').join(' '),
                        tokens: budget,
                        label: 'RAG',
                        type: 'summary',
                    },
                ];
            },
        });
        const available = 4096 - tokenBreakdown.system - 1024;
        // The floor no longer overrides the real room: RAG ≤ 50% of what's left…
        expect(grantedBudget).toBeLessThanOrEqual(Math.floor(available * 0.5));
        // …and the verbatim history is never starved to zero.
        expect(includedMessageCount).toBeGreaterThan(0);
    });
});
