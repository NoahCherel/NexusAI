/**
 * The relationship analyst MOVES bonds; it never creates one.
 *
 * Bonds are authored by hand in the Relations panel (plus the single player↔card pair seeded at
 * conversation creation). Auto-minting them from whoever was detected on stage is what used to
 * fill the prompt with walk-on NPCs, so the no-creation guarantee is asserted here rather than
 * left to the prompt's good intentions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { analyzeAndUpdateRelationships } from '@/lib/ai/relationship-analyst';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { makeRelationship } from '@/lib/ai/relationship-engine';
import { USER_REL_KEY, type Conversation, type DirectedRelationship } from '@/types/chat';
import type { CharacterCard } from '@/types/character';

vi.mock('@/lib/db', () => ({
    getCanonDossiersByWork: vi.fn(async () => [] as never[]),
    saveConversation: vi.fn(async () => undefined),
    getConversationsByCharacter: vi.fn(async () => [] as never[]),
    saveMessage: vi.fn(async () => undefined),
    getConversationMessages: vi.fn(async () => [] as never[]),
    deleteMessagedb: vi.fn(async () => undefined),
}));

vi.mock('@/lib/ai/background-ai', () => ({
    backgroundAICall: vi.fn(async () => ({ content: '{"changes":[]}', usedModel: 'noop' })),
}));

import { backgroundAICall } from '@/lib/ai/background-ai';

const card: CharacterCard = {
    id: 'c1',
    name: 'Naruto',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    canonCast: ['Naruto', 'Sasuke'],
};

const CONV_ID = 'cv1';

function seedConversation(relationships?: DirectedRelationship[]) {
    const conv = {
        id: CONV_ID,
        characterId: 'c1',
        title: 't',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        relationships,
    } as Conversation;
    useChatStore.setState({ conversations: [conv], messages: [] });
}

/** The stored bonds after the analyst ran. */
const stored = () =>
    useChatStore.getState().conversations.find((c) => c.id === CONV_ID)?.relationships ?? [];

const reply = (content: string) => vi.mocked(backgroundAICall).mockResolvedValue({
    content,
    usedModel: 'noop',
} as Awaited<ReturnType<typeof backgroundAICall>>);

beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ enableRelationshipAnalyst: true, personas: [], activePersonaId: null });
});

describe('analyzeAndUpdateRelationships — creation is manual', () => {
    it('makes NO API call when the conversation has no hand-made bond', async () => {
        seedConversation(undefined);
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Naruto saves Sasuke from the fall.');
        expect(backgroundAICall).not.toHaveBeenCalled();
        expect(stored()).toEqual([]);
    });

    it('makes no API call for an emptied list either (deleting the last bond sticks)', async () => {
        seedConversation([]);
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Naruto saves Sasuke from the fall.');
        expect(backgroundAICall).not.toHaveBeenCalled();
    });

    it('discards a delta for a pair nobody created — no new bond appears', async () => {
        seedConversation([makeRelationship('Naruto', USER_REL_KEY)]);
        reply(
            JSON.stringify({
                changes: [
                    { from: 'Sasuke', to: 'Naruto', axis: 'respect', delta: 8, reason: 'saved him' },
                ],
            })
        );
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Sasuke watched Naruto win.');
        expect(stored()).toHaveLength(1);
        expect(stored().some((r) => r.from === 'Sasuke')).toBe(false);
    });

    it('moves a bond that DOES exist, and records why', async () => {
        seedConversation([makeRelationship('Naruto', USER_REL_KEY)]);
        reply(
            JSON.stringify({
                changes: [
                    {
                        from: 'Naruto',
                        to: '{{user}}',
                        axis: 'trust',
                        delta: 8,
                        reason: 'took the hit for him',
                    },
                ],
            })
        );
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Naruto is grateful.');
        const rel = stored().find((r) => r.from === 'Naruto' && r.to === USER_REL_KEY);
        expect(rel?.axes.trust).toBeGreaterThan(0);
        expect(rel?.ledger.at(-1)?.reason).toBe('took the hit for him');
    });

    it('never authors the player own feelings', async () => {
        seedConversation([
            makeRelationship('Naruto', USER_REL_KEY),
            makeRelationship(USER_REL_KEY, 'Naruto'),
        ]);
        reply(
            JSON.stringify({
                changes: [
                    { from: '{{user}}', to: 'Naruto', axis: 'affection', delta: 20, reason: 'x' },
                ],
            })
        );
        await analyzeAndUpdateRelationships(card, CONV_ID, 'A tender moment.');
        const playerSide = stored().find((r) => r.from === USER_REL_KEY);
        expect(playerSide?.axes.affection).toBe(0);
        expect(playerSide?.ledger).toHaveLength(0);
    });

    it('does nothing at all when its toggle is off', async () => {
        useSettingsStore.setState({ enableRelationshipAnalyst: false });
        seedConversation([makeRelationship('Naruto', USER_REL_KEY)]);
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Naruto saves the day.');
        expect(backgroundAICall).not.toHaveBeenCalled();
    });
});
