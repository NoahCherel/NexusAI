import { describe, it, expect } from 'vitest';
import {
    BUILTIN_ENGINES,
    IMMERSIVE_NEXUS_KEY,
    buildEngineSystemBlock,
    buildEnginePostHistory,
    getEngineById,
} from '@/lib/ai/rp-engine';
import { buildConversationPayload } from '@/lib/ai/payload-builder';
import type { CharacterCard } from '@/types/character';
import type { Message, WorldState } from '@/types/chat';
import type { APIPreset } from '@/types/preset';

const immersive = BUILTIN_ENGINES.find((e) => e.builtinKey === IMMERSIVE_NEXUS_KEY)!;

const card: CharacterCard = {
    id: 'c1',
    name: 'Mara',
    description: 'DESC_MARKER a weary caravan guard',
    personality: 'gruff but fair',
    scenario: 'a dusty trade road',
    first_mes: '',
    mes_example: '',
};

const worldState: WorldState = { inventory: [], location: '', relationships: {} };

function userMsg(content: string): Message {
    return {
        id: 'm1',
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

describe('rp-engine builders', () => {
    it('system block carries the priority hierarchy, register policy and ban list', () => {
        const block = buildEngineSystemBlock(immersive, { userName: 'Alex' });
        expect(block).toContain('PLAYER AUTONOMY');
        expect(block).toContain('WHAT CHARACTERS CAN KNOW');
        expect(block).toContain('REGISTER:');
        expect(block).toContain('Match the explicitness already established'); // faithful
        expect(block).toContain('AVOID THESE OVERUSED PHRASES');
        // {{user}} is resolved to the persona name.
        expect(block).toContain("Never write Alex's");
        expect(block).not.toContain('{{user}}');
    });

    it('generate post-history is the final checklist with opening variety', () => {
        const post = buildEnginePostHistory(immersive, 'generate', { userName: 'Alex' });
        expect(post).toContain('BEFORE YOU SEND');
        expect(post).toContain('Vary your opening');
        expect(post).toContain("Alex's words");
    });

    it('impersonate post-history is the inverted contract', () => {
        const post = buildEnginePostHistory(immersive, 'impersonate', { userName: 'Alex' });
        expect(post).toContain('IMPERSONATION');
        expect(post).toContain('write ONLY Alex');
        expect(post).not.toContain('BEFORE YOU SEND');
    });

    it('getEngineById resolves built-ins by id or builtinKey', () => {
        expect(getEngineById(IMMERSIVE_NEXUS_KEY)?.name).toBe('Immersive Nexus');
        expect(getEngineById(null)).toBeUndefined();
        expect(getEngineById('nope')).toBeUndefined();
    });
});

describe('buildConversationPayload — generate', () => {
    it('injects the engine block in the system message AFTER the character body', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: immersive,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });

        const system = messagesPayload[0];
        expect(system.role).toBe('system');
        expect(system.content).toContain('PLAYER AUTONOMY');
        // Character description appears before the engine block (engine = "how to write").
        expect(system.content.indexOf('DESC_MARKER')).toBeLessThan(
            system.content.indexOf('PLAYER AUTONOMY')
        );

        // The generate checklist is the LAST message (post-history, after history).
        const last = messagesPayload[messagesPayload.length - 1];
        expect(last.role).toBe('system');
        expect(last.content).toContain('BEFORE YOU SEND');
    });

    it('merges the engine contract with the user preset post-history (never replaces)', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset({ postHistoryInstructions: 'USER_POSTHISTORY_MARKER' }),
            activeEngine: immersive,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const last = messagesPayload[messagesPayload.length - 1];
        expect(last.content).toContain('BEFORE YOU SEND');
        expect(last.content).toContain('USER_POSTHISTORY_MARKER');
    });

    it('engine off → no engine block, no checklist (legacy behaviour)', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: null,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const joined = messagesPayload.map((m) => m.content).join('\n');
        expect(joined).not.toContain('PLAYER AUTONOMY');
        expect(joined).not.toContain('BEFORE YOU SEND');
    });

    it('still asks for a <scratchpad> during normal generation', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: immersive,
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const joined = messagesPayload.map((m) => m.content).join('\n');
        expect(joined).toContain('output a <scratchpad>');
    });

    it('injects the learned ban list (Style Guard) into the system prompt', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: immersive,
            learnedBanList: ['stop describing the weather'],
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        expect(messagesPayload[0].content).toContain('STYLE GUARD');
        expect(messagesPayload[0].content).toContain('stop describing the weather');
    });

    it('applies the learned ban list even when the engine is off', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: null,
            learnedBanList: ['no purple prose'],
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        expect(messagesPayload[0].content).toContain('no purple prose');
    });
});

describe('buildConversationPayload — impersonate (inverted contract)', () => {
    it('omits the player-autonomy engine block and asserts the impersonation contract last', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'impersonate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            recentMessages: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: immersive,
            userPersona: { name: 'Alex', bio: 'a ranger' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });

        const system = messagesPayload[0];
        // The "never write the player" engine block must NOT be present in impersonation.
        expect(system.content).not.toContain('PLAYER AUTONOMY');
        // The default template's contradictory line is stripped.
        expect(system.content).not.toContain('Do not speak for Alex');

        const last = messagesPayload[messagesPayload.length - 1];
        expect(last.role).toBe('system');
        expect(last.content).toContain('IMPERSONATION');
        expect(last.content).toContain('write ONLY Alex');
    });

    it('does not emit a duplicate system prompt (single system message at the head)', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'impersonate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: immersive,
            userPersona: { name: 'Alex', bio: 'a ranger' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        // Exactly one leading system message; the only other system message is the trailing contract.
        const systemCount = messagesPayload.filter((m) => m.role === 'system').length;
        expect(messagesPayload[0].role).toBe('system');
        expect(systemCount).toBe(2);
    });

    it('respects a custom impersonationPrompt over the engine contract', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'impersonate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset({ impersonationPrompt: 'CUSTOM_IMP for {{user}}' }),
            activeEngine: immersive,
            userPersona: { name: 'Alex', bio: 'a ranger' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const last = messagesPayload[messagesPayload.length - 1];
        expect(last.content).toContain('CUSTOM_IMP for Alex');
        expect(last.content).not.toContain('write ONLY Alex'); // generic engine block not used
    });

    it('places the inverted contract AFTER the user post-history (so it wins)', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'impersonate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset({ postHistoryInstructions: 'USER_POSTHISTORY_MARKER' }),
            activeEngine: immersive,
            userPersona: { name: 'Alex', bio: 'a ranger' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const last = messagesPayload[messagesPayload.length - 1];
        expect(last.content).toContain('USER_POSTHISTORY_MARKER');
        expect(last.content).toContain('IMPERSONATION');
        expect(last.content.indexOf('USER_POSTHISTORY_MARKER')).toBeLessThan(
            last.content.indexOf('IMPERSONATION')
        );
    });

    it('does not ask the model to emit a <scratchpad> during impersonation', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'impersonate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: immersive,
            userPersona: { name: 'Alex', bio: 'a ranger' },
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const joined = messagesPayload.map((m) => m.content).join('\n');
        expect(joined).not.toContain('output a <scratchpad>');
    });

    it('omits the learned ban list during impersonation', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'impersonate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: immersive,
            userPersona: { name: 'Alex', bio: 'a ranger' },
            learnedBanList: ['stop describing the weather'],
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const joined = messagesPayload.map((m) => m.content).join('\n');
        expect(joined).not.toContain('STYLE GUARD');
        expect(joined).not.toContain('stop describing the weather');
    });

    it('does not feed the prior scratchpad to the impersonation model (no metagaming)', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'impersonate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: immersive,
            userPersona: { name: 'Alex', bio: 'a ranger' },
            scratchpad: 'SCRATCH_SECRET the villain is the mayor',
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const joined = messagesPayload.map((m) => m.content).join('\n');
        expect(joined).not.toContain('SCRATCH_SECRET');
    });

    it('still injects the prior scratchpad during normal generation', async () => {
        const { messagesPayload } = await buildConversationPayload({
            mode: 'generate',
            character: card,
            worldState,
            activeEntries: [],
            history: [userMsg('hello')],
            activePreset: preset(),
            activeEngine: immersive,
            scratchpad: 'SCRATCH_SECRET plan',
            maxContextTokens: 8192,
            maxOutputTokens: 1000,
        });
        const joined = messagesPayload.map((m) => m.content).join('\n');
        expect(joined).toContain('SCRATCH_SECRET');
    });
});
