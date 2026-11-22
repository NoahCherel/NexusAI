// Imported SillyTavern presets: an instruction-only main prompt must still send the card,
// the prefill is sent (never shown) on every provider, and {{char}}/{{user}} are resolved.
import { describe, it, expect } from 'vitest';
import { buildConversationPayload } from '@/lib/ai/payload-builder';
import { buildSystemPrompt } from '@/lib/ai/context-builder';
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/types/preset';
import { buildOpenRouterChatBody } from '@/lib/ai/openrouter-request';
import type { CharacterCard } from '@/types/character';
import type { CanonDossier } from '@/types/canon';
import type { Message } from '@/types/chat';
import type { APIPreset } from '@/types/preset';

const card: CharacterCard = {
    id: 'c1',
    name: 'Mira',
    description: 'DESC_MARKER smuggler with a brass compass',
    personality: 'PERSO_MARKER sardonic',
    scenario: 'SCEN_MARKER {{user}} walks into the tavern',
    first_mes: '',
    mes_example: '',
};
const persona = { name: 'Noah', bio: 'a scribe' };
const PREFILL = '1. Audit {{char}} vs {{user}}.\n2. Skip the drafting.';

const msg = (id: string, role: Message['role'], content: string): Message => ({
    id,
    conversationId: 'conv',
    parentId: null,
    role,
    content,
    isActiveBranch: true,
    createdAt: new Date(0),
    messageOrder: 1,
    regenerationIndex: 0,
});

const preset = (overrides: Partial<APIPreset> = {}): APIPreset =>
    ({
        id: 'p',
        name: 'Maestro',
        createdAt: new Date(0),
        systemPromptTemplate: 'Advance the plot as {{char}}.',
        postHistoryInstructions: 'Never write for {{user}}; you are {{char}}.',
        impersonationPrompt: 'Write as {{user}}, never as {{char}}.',
        assistantPrefill: PREFILL,
        ...overrides,
    }) as unknown as APIPreset;

const build = (overrides: Partial<Parameters<typeof buildConversationPayload>[0]> = {}) =>
    buildConversationPayload({
        mode: 'generate',
        character: card,
        activeEntries: [],
        history: [msg('u1', 'user', 'hello')],
        activePreset: preset(),
        activeEngine: null,
        userPersona: persona,
        activeProvider: 'nanogpt',
        maxContextTokens: 8192,
        maxOutputTokens: 500,
        ...overrides,
    });

const RAW_MACRO = /\{\{(char|user|character_name)\}\}/i;

describe('card injection with an instruction-only template', () => {
    it('appends description, personality and scenario, macros resolved', () => {
        const prompt = buildSystemPrompt(card, [], {
            template: 'Advance the plot as {{char}}.',
            userPersona: persona,
        });
        expect(prompt).toContain('Advance the plot as Mira.');
        expect(prompt).toContain('DESC_MARKER');
        expect(prompt).toContain("Mira's personality: PERSO_MARKER");
        expect(prompt).toContain('Scenario: SCEN_MARKER Noah walks into the tavern');
        // Instructions first, then the card (SillyTavern order).
        expect(prompt.indexOf('Advance')).toBeLessThan(prompt.indexOf('DESC_MARKER'));
    });

    it('never duplicates a field the template places itself', () => {
        const count = (s: string, m: string) => s.split(m).length - 1;
        const def = buildSystemPrompt(card, [], { template: DEFAULT_SYSTEM_PROMPT_TEMPLATE });
        const st = buildSystemPrompt(card, [], {
            template: '{{description}}\n{{personality}}\n{{scenario}}',
        });
        for (const prompt of [def, st]) {
            expect(count(prompt, 'DESC_MARKER')).toBe(1);
            expect(count(prompt, 'PERSO_MARKER')).toBe(1);
            expect(count(prompt, 'SCEN_MARKER')).toBe(1);
            expect(prompt).not.toMatch(/\{\{(description|personality)\}\}/);
        }
    });
});

describe('preset prefill and macros', () => {
    it('sends the resolved prefill as the last assistant message on nanogpt', async () => {
        const { messagesPayload } = await build();
        const last = messagesPayload[messagesPayload.length - 1];
        expect(last).toEqual({
            role: 'assistant',
            content: '1. Audit Mira vs Noah.\n2. Skip the drafting.',
        });
        for (const m of messagesPayload) expect(m.content).not.toMatch(RAW_MACRO);
        expect(
            messagesPayload.some((m) => m.content.includes('Never write for Noah; you are Mira.'))
        ).toBe(true);
    });

    it('strips a stored copy of the prefill from earlier replies', async () => {
        const history = [
            msg('a0', 'assistant', `${PREFILL}The tavern smells of salt.`),
            msg('u1', 'user', 'hello'),
        ];
        const { messagesPayload } = await build({ history });
        expect(messagesPayload[1]).toEqual({
            role: 'assistant',
            content: 'The tavern smells of salt.',
        });
    });

    it('keeps the prefill away from agents, continue-in-place and impersonation', async () => {
        const hasPrefill = (p: { content: string }[]) =>
            p.some((m) => m.content.includes('Audit Mira'));
        expect(hasPrefill((await build({ agentContract: 'Return JSON.' })).messagesPayload)).toBe(
            false
        );
        expect(
            hasPrefill(
                (
                    await build({
                        history: [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'She')],
                        continueFromAssistant: true,
                    })
                ).messagesPayload
            )
        ).toBe(false);
        const imp = await build({ mode: 'impersonate' });
        expect(hasPrefill(imp.messagesPayload)).toBe(false);
        expect(
            imp.messagesPayload.some((m) => m.content.includes('Write as Noah, never as Mira.'))
        ).toBe(true);
    });

    it('lets an explicit prefill (continue path) win over the preset one', async () => {
        const { messagesPayload } = await build({ assistantPrefill: 'She ' });
        expect(messagesPayload[messagesPayload.length - 1]).toEqual({
            role: 'assistant',
            content: 'She ',
        });
    });
});

describe('Casting dossiers switch', () => {
    const dossier: CanonDossier = {
        work: 'W',
        character: 'Rukia',
        timelineCap: 'S1',
        identity: 'DOSSIER_MARKER composed Soul Reaper',
        fetchedAt: 0,
    } as CanonDossier;
    const canonOptions = (injectDossiers?: boolean) => ({
        canonDossiers: [dossier],
        injectDossiers,
        rpJournal: { Rukia: ['JOURNAL_MARKER lost her powers'] },
    });

    it('drops the dossier text but keeps the cast journal when off', async () => {
        const off = await build({ canonOptions: canonOptions(false) });
        const on = await build({ canonOptions: canonOptions(undefined) });
        expect(off.systemPrompt).not.toContain('DOSSIER_MARKER');
        expect(off.effectivePostHistory).toContain('JOURNAL_MARKER');
        expect(on.systemPrompt).toContain('DOSSIER_MARKER');
    });
});

describe('degenerate min_p', () => {
    it('never forwards min_p >= 1 (greedy) but keeps a real value', () => {
        const body = (minP: number) =>
            buildOpenRouterChatBody({ model: 'z-ai/glm-5.3', messages: [], minP, mode: 'stream' });
        expect(body(1)).not.toHaveProperty('min_p');
        expect(body(0.05).min_p).toBe(0.05);
    });
});
