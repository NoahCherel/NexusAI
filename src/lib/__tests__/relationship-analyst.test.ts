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

const reply = (content: string) =>
    vi.mocked(backgroundAICall).mockResolvedValue({
        content,
        usedModel: 'noop',
    } as Awaited<ReturnType<typeof backgroundAICall>>);

beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
        enableRelationshipAnalyst: true,
        personas: [],
        activePersonaId: null,
    });
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
                    {
                        from: 'Sasuke',
                        to: 'Naruto',
                        axis: 'respect',
                        delta: 8,
                        reason: 'saved him',
                    },
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

/**
 * REGRESSION. Presence used to be inferred by matching cast names against the reply text, and
 * nothing else — so ordinary prose ("She threw herself in front of him"), where a character
 * does not write their own name, read as "nobody on stage" and the analyst silently bailed.
 * That killed the feature for the most common case.
 */
describe('analyzeAndUpdateRelationships — presence comes from ground truth', () => {
    const bond = () => [
        makeRelationship(USER_REL_KEY, 'Sakura'),
        makeRelationship('Sakura', USER_REL_KEY),
    ];
    const sakuraTrust = () =>
        stored().find((r) => r.from === 'Sakura' && r.to === USER_REL_KEY)?.axes.trust ?? 0;
    const grateful = JSON.stringify({
        changes: [
            { from: 'Sakura', to: '{{user}}', axis: 'trust', delta: 8, reason: 'took the blow' },
        ],
    });

    it('runs when the reply never names the character who wrote it', async () => {
        seedConversation(bond());
        reply(grateful);
        await analyzeAndUpdateRelationships(
            card,
            CONV_ID,
            'She throws herself in front of him, taking the blow. Blood runs down her arm.',
            'm1',
            ['Sakura']
        );
        expect(backgroundAICall).toHaveBeenCalled();
        expect(sakuraTrust()).toBeGreaterThan(0);
    });

    it('falls back to the card character when no speaker is supplied', async () => {
        seedConversation(bond());
        reply(grateful);
        await analyzeAndUpdateRelationships(card, CONV_ID, 'A long silence, then a nod.');
        expect(backgroundAICall).toHaveBeenCalled();
        expect(sakuraTrust()).toBeGreaterThan(0);
    });

    it('tells the model who is present and who wrote the beat', async () => {
        seedConversation(bond());
        reply(grateful);
        await analyzeAndUpdateRelationships(card, CONV_ID, 'A tense pause.', 'm1', ['Sakura']);
        const prompt = vi.mocked(backgroundAICall).mock.calls[0][0].userPrompt;
        expect(prompt).toContain('Characters present in this scene');
        expect(prompt).toContain('This beat was written by: Sakura');
    });

    it('still refuses to create a bond for a character on stage but untracked', async () => {
        seedConversation([makeRelationship('Sakura', USER_REL_KEY)]);
        reply(
            JSON.stringify({
                changes: [
                    { from: 'Kakashi', to: '{{user}}', axis: 'trust', delta: 8, reason: 'x' },
                ],
            })
        );
        await analyzeAndUpdateRelationships(card, CONV_ID, 'The scene turns.', 'm1', ['Kakashi']);
        expect(stored()).toHaveLength(1);
        expect(stored().some((r) => r.from === 'Kakashi')).toBe(false);
    });
});

describe('analyzeAndUpdateRelationships — a rerolled beat is scored once', () => {
    const sakuraTrust = () =>
        stored().find((r) => r.from === 'Sakura' && r.to === USER_REL_KEY)?.axes.trust ?? 0;
    const delta = (n: number) =>
        JSON.stringify({
            changes: [
                { from: 'Sakura', to: '{{user}}', axis: 'trust', delta: n, reason: 'the beat' },
            ],
        });

    it('re-scoring the same message replaces its deltas instead of stacking them', async () => {
        seedConversation([makeRelationship('Sakura', USER_REL_KEY)]);
        reply(delta(8));
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Beat.', 'm1', ['Sakura']);
        const once = sakuraTrust();
        expect(once).toBeGreaterThan(0);

        await analyzeAndUpdateRelationships(card, CONV_ID, 'Beat, reworded.', 'm1', ['Sakura']);
        expect(sakuraTrust()).toBe(once);
        expect(stored()[0].ledger).toHaveLength(1);
    });

    it('a reroll under a NEW id rolls back the discarded version', async () => {
        seedConversation([makeRelationship('Sakura', USER_REL_KEY)]);
        reply(delta(8));
        await analyzeAndUpdateRelationships(card, CONV_ID, 'First take.', 'm1', ['Sakura']);
        const once = sakuraTrust();

        // Regenerate: new message id, the old one is superseded.
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Second take.', 'm2', ['Sakura'], 'm1');
        expect(sakuraTrust()).toBe(once);
        expect(stored()[0].ledger).toHaveLength(1);
        expect(stored()[0].ledger[0].messageId).toBe('m2');
    });

    it('a FAILED re-analysis leaves the old deltas alone (no silent history loss)', async () => {
        seedConversation([makeRelationship('Sakura', USER_REL_KEY)]);
        reply(delta(8));
        await analyzeAndUpdateRelationships(card, CONV_ID, 'First take.', 'm1', ['Sakura']);
        const earned = sakuraTrust();
        expect(earned).toBeGreaterThan(0);

        // The background call dies (no key / quota / network). Rolling the old deltas back
        // before the call would have wiped `earned` with nothing to replace it.
        vi.mocked(backgroundAICall).mockResolvedValue(null as never);
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Second take.', 'm2', ['Sakura'], 'm1');
        expect(sakuraTrust()).toBe(earned);
        expect(stored()[0].ledger).toHaveLength(1);
    });

    it('an empty verdict commits the rollback — the old beat no longer exists', async () => {
        seedConversation([makeRelationship('Sakura', USER_REL_KEY)]);
        reply(delta(8));
        await analyzeAndUpdateRelationships(card, CONV_ID, 'First take.', 'm1', ['Sakura']);
        expect(sakuraTrust()).toBeGreaterThan(0);

        reply(JSON.stringify({ changes: [] }));
        await analyzeAndUpdateRelationships(
            card,
            CONV_ID,
            'A flatter take.',
            'm2',
            ['Sakura'],
            'm1'
        );
        expect(sakuraTrust()).toBe(0);
        expect(stored()[0].ledger).toHaveLength(0);
    });

    it('a genuinely new beat still stacks on top of the previous one', async () => {
        seedConversation([makeRelationship('Sakura', USER_REL_KEY)]);
        reply(delta(8));
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Beat one.', 'm1', ['Sakura']);
        const once = sakuraTrust();
        await analyzeAndUpdateRelationships(card, CONV_ID, 'Beat two.', 'm2', ['Sakura']);
        expect(sakuraTrust()).toBeGreaterThan(once);
        expect(stored()[0].ledger).toHaveLength(2);
    });
});
