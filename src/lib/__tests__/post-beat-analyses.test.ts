/**
 * `skipBeatAnalyses` gates BOTH fact extraction and the relationship analyst.
 *
 * It used to be `skipFactExtraction`, honoured only by fact extraction — so in Troupe "turns"
 * mode the relationship analyst fired once per SPEAKER instead of once per beat: N background
 * calls, and up to N × NORMAL_DELTA_CAP of drift on a single beat. Regenerate/continue/retry
 * had the same problem, re-applying deltas for a beat already scored.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runPostBeatAnalyses, type PostBeatParams } from '@/lib/ai/post-beat';
import { useSettingsStore } from '@/stores/settings-store';
import { useChatStore } from '@/stores/chat-store';
import type { CharacterCard } from '@/types/character';
import type { Conversation } from '@/types/chat';

vi.mock('@/lib/db', () => ({
    saveFactsBatch: vi.fn(async () => undefined),
    getFactsByConversation: vi.fn(async () => [] as never[]),
    saveConversation: vi.fn(async () => undefined),
    getConversationsByCharacter: vi.fn(async () => [] as never[]),
    saveMessage: vi.fn(async () => undefined),
    getConversationMessages: vi.fn(async () => [] as never[]),
    deleteMessagedb: vi.fn(async () => undefined),
}));

vi.mock('@/lib/ai/relationship-analyst', () => ({
    analyzeAndUpdateRelationships: vi.fn(async () => undefined),
}));

vi.mock('@/lib/ai/background-ai', () => ({
    backgroundAICall: vi.fn(async () => ({ content: '{"facts":[]}', usedModel: 'noop' })),
}));

// Partial: `resolveWork` still needs the real `deriveWorkFromName`.
vi.mock('@/lib/ai/canon-retrieval', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/ai/canon-retrieval')>()),
    fetchCharacterDossier: vi.fn(async () => null),
}));

import { analyzeAndUpdateRelationships } from '@/lib/ai/relationship-analyst';

const card: CharacterCard = {
    id: 'c1',
    name: 'Naruto',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
};

const CONV_ID = 'cv1';

function params(overrides: Partial<PostBeatParams> = {}): PostBeatParams {
    return {
        character: card,
        conversationId: CONV_ID,
        finalContent: 'Sasuke turns away without a word.',
        fullContent: 'Sasuke turns away without a word.',
        targetId: 'm1',
        history: [],
        branchMessageIds: [],
        isImpersonation: false,
        skipBeatAnalyses: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ enableFactExtraction: false, enableMomentum: false });
    useChatStore.setState({
        conversations: [
            {
                id: CONV_ID,
                characterId: 'c1',
                title: 't',
                createdAt: new Date(0),
                updatedAt: new Date(0),
            } as Conversation,
        ],
        messages: [],
    });
});

describe('runPostBeatAnalyses — one relationship pass per beat', () => {
    it('runs the analyst on a normal beat', () => {
        runPostBeatAnalyses(params());
        expect(analyzeAndUpdateRelationships).toHaveBeenCalledTimes(1);
    });

    it('holds it back on a non-final Troupe turn', () => {
        runPostBeatAnalyses(params({ skipBeatAnalyses: true }));
        expect(analyzeAndUpdateRelationships).not.toHaveBeenCalled();
    });

    it('a 3-speaker beat scores ONCE, over every speaker line', () => {
        const lines = ['Naruto: I trusted you.', 'Sakura: Stop it, both of you.'];
        // Turns 1 and 2 are held back; the final turn carries the whole beat.
        runPostBeatAnalyses(params({ skipBeatAnalyses: true, finalContent: lines[0] }));
        runPostBeatAnalyses(params({ skipBeatAnalyses: true, finalContent: lines[1] }));
        runPostBeatAnalyses(
            params({
                finalContent: 'Sasuke turns away without a word.',
                beatContent: `${lines.join('\n')}\nSasuke: turns away without a word.`,
            })
        );

        expect(analyzeAndUpdateRelationships).toHaveBeenCalledTimes(1);
        const content = vi.mocked(analyzeAndUpdateRelationships).mock.calls[0][2];
        expect(content).toContain('Naruto:');
        expect(content).toContain('Sakura:');
        expect(content).toContain('Sasuke:');
    });

    it('falls back to the single reply when there is no beat transcript', () => {
        runPostBeatAnalyses(params({ finalContent: 'A lone line.' }));
        expect(vi.mocked(analyzeAndUpdateRelationships).mock.calls[0][2]).toBe('A lone line.');
    });

    it('skips impersonation (the player ghost-writing themselves is not a beat)', () => {
        runPostBeatAnalyses(params({ isImpersonation: true }));
        expect(analyzeAndUpdateRelationships).not.toHaveBeenCalled();
    });
});
