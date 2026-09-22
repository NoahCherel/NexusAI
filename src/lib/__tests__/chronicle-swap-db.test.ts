import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { MemorySummary } from '@/types/rag';
import {
    chronicleRevision,
    getSummariesByConversation,
    replaceSummariesForConversation,
    saveSummary,
} from '@/lib/db';

const summary = (id: string, conversationId: string, content: string): MemorySummary => ({
    id,
    conversationId,
    level: 0,
    messageRange: [0, 10],
    content,
    keyFacts: [],
    childIds: [],
    createdAt: 1,
});

describe('replaceSummariesForConversation', () => {
    it('swaps the whole Chronicle and leaves other conversations alone', async () => {
        await saveSummary(summary('old-1', 'swap-a', 'ancien 1'));
        await saveSummary(summary('old-2', 'swap-a', 'ancien 2'));
        await saveSummary(summary('other', 'swap-b', 'autre conversation'));

        await replaceSummariesForConversation('swap-a', [summary('new-1', 'swap-a', 'nouveau')]);

        const stored = await getSummariesByConversation('swap-a');
        expect(stored.map((s) => s.id)).toEqual(['new-1']);
        expect((await getSummariesByConversation('swap-b')).map((s) => s.id)).toEqual(['other']);
    });

    it('refuses the swap and keeps the stored Chronicle when it changed during the rebuild', async () => {
        await saveSummary(summary('keep-1', 'swap-c', 'texte écrit à la main'));
        const expectedRevision = chronicleRevision(await getSummariesByConversation('swap-c'));

        // The background pipeline appends a fragment while the rebuild is still calling the model.
        await saveSummary(summary('keep-2', 'swap-c', 'fragment ajouté pendant la reconstruction'));

        await expect(
            replaceSummariesForConversation(
                'swap-c',
                [summary('new-1', 'swap-c', 'reconstruction')],
                expectedRevision
            )
        ).rejects.toMatchObject({ name: 'StaleChronicleError' });

        const stored = await getSummariesByConversation('swap-c');
        expect(stored.map((s) => s.id).sort()).toEqual(['keep-1', 'keep-2']);
    });

    it('accepts the swap when the stored Chronicle is untouched', async () => {
        await saveSummary(summary('stable', 'swap-d', 'inchangé'));
        const expectedRevision = chronicleRevision(await getSummariesByConversation('swap-d'));

        await replaceSummariesForConversation(
            'swap-d',
            [summary('rebuilt', 'swap-d', 'reconstruit')],
            expectedRevision
        );

        expect((await getSummariesByConversation('swap-d')).map((s) => s.id)).toEqual(['rebuilt']);
    });

    it('sees a hand-rewritten summary as a change even when its id is unchanged', async () => {
        await saveSummary(summary('edited', 'swap-e', 'version machine'));
        const expectedRevision = chronicleRevision(await getSummariesByConversation('swap-e'));

        await saveSummary({
            ...summary('edited', 'swap-e', 'version réécrite par le joueur'),
            isManuallyEdited: true,
            editedAt: 42,
        });

        await expect(
            replaceSummariesForConversation(
                'swap-e',
                [summary('new', 'swap-e', 'reconstruction')],
                expectedRevision
            )
        ).rejects.toMatchObject({ name: 'StaleChronicleError' });
    });
});
