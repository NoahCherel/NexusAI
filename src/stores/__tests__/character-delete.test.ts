import 'fake-indexeddb/auto';
import { beforeAll, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { CharacterWithMemory } from '@/lib/db';
import {
    getAllCharacters,
    getConversationMessages,
    getConversationsByCharacter,
    getSummariesByConversation,
    saveCharacter,
    saveConversation,
    saveMessage,
    saveSummary,
} from '@/lib/db';
import { useCharacterStore } from '@/stores/character-store';

beforeAll(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

it('removes the character, its conversations, messages and Chronicle', async () => {
    await saveCharacter({
        id: 'c1',
        name: 'C',
        longTermMemory: [],
    } as unknown as CharacterWithMemory);
    await saveConversation({
        id: 'v1',
        characterId: 'c1',
        title: 't',
        createdAt: new Date(0),
        updatedAt: new Date(0),
    });
    await saveMessage({
        id: 'm1',
        conversationId: 'v1',
        role: 'user',
        content: 'Bonjour',
        parentId: null,
        createdAt: new Date(0),
        isActiveBranch: true,
        messageOrder: 1,
        regenerationIndex: 0,
    });
    await saveSummary({
        id: 's1',
        conversationId: 'v1',
        level: 0,
        messageRange: [0, 1],
        content: 'Résumé',
        keyFacts: [],
        childIds: [],
        createdAt: 0,
    });

    await useCharacterStore.getState().removeCharacter('c1');

    expect(await getAllCharacters()).toEqual([]);
    expect(await getConversationsByCharacter('c1')).toEqual([]);
    expect(await getConversationMessages('v1')).toEqual([]);
    expect(await getSummariesByConversation('v1')).toEqual([]);
});
