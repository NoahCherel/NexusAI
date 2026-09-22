import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { Conversation, Message } from '@/types';
import { resolveConversationPersona, resolvePersonaId } from '@/lib/conversation-persona';
import {
    initDB,
    saveConversation,
    patchConversation,
    getConversation,
    getConversationMessages,
    commitUserMessage,
    patchStoredMessage,
    saveMessage,
} from '@/lib/db';
import { useChatStore, __resetChatLoadFences } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { createGlobalBackup, parseGlobalBackup } from '@/lib/global-backup';
import { unpackBackupValue } from '@/lib/backup-codec';

const conversation = (id = 'A', extra: Partial<Conversation> = {}): Conversation => ({
    id,
    characterId: 'character',
    title: id,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
});
const message = (id: string, personaId?: string, time = 1): Message => ({
    id,
    conversationId: 'A',
    role: 'user',
    content: 'Bonjour',
    parentId: null,
    createdAt: new Date(time),
    isActiveBranch: true,
    messageOrder: time,
    regenerationIndex: 0,
    speaker: { kind: 'user', name: 'Même nom', personaId },
});
const personas = [
    { id: 'p1', name: 'Un', bio: '' },
    { id: 'p2', name: 'Deux', bio: '' },
];

beforeAll(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
beforeEach(async () => {
    const db = await initDB();
    await db.clear('conversations');
    await db.clear('messages');
    __resetChatLoadFences();
    useChatStore.setState({
        conversations: [],
        activeConversationId: null,
        messages: [],
        isLoading: false,
    });
    useSettingsStore.setState({ personas, activePersonaId: 'p1' });
});

describe('conversation persona identity', () => {
    it('keeps an explicit none even if the global selection and history have a persona', () => {
        expect(
            resolvePersonaId(conversation('A', { lastPersonaId: null }), [message('m', 'p1')], 'p2')
        ).toBeNull();
    });
    it('uses the latest usable attribution, never a name match', () => {
        expect(
            resolvePersonaId(
                conversation(),
                [message('new', 'p2', 9), message('old', 'p1', 2)],
                'p1'
            )
        ).toBe('p2');
        expect(
            resolvePersonaId(
                conversation(),
                [message('old', 'p1', 2), message('new', undefined, 9)],
                'p2'
            )
        ).toBe('p1');
        expect(
            resolvePersonaId(conversation(), [{ ...message('legacy'), speaker: undefined }], 'p2')
        ).toBe('p2');
    });
    it('retains a missing reference and resolves it automatically when the persona returns', () => {
        const conv = conversation('A', { lastPersonaId: 'missing' });
        expect(resolveConversationPersona(conv, [], personas, 'p1')).toEqual({
            id: 'missing',
            persona: undefined,
            unavailable: true,
        });
        expect(
            resolveConversationPersona(
                conv,
                [],
                [...personas, { id: 'missing', name: 'Revenu', bio: '' }],
                'p1'
            ).persona?.name
        ).toBe('Revenu');
    });
    it('persists selection without sending, isolates A and B, and preserves message attribution', async () => {
        await saveConversation(conversation());
        await saveConversation(conversation('B', { lastPersonaId: 'p2' }));
        await useChatStore.getState().loadConversations('character');
        await useChatStore.getState().setConversationPersona('A', 'p1');
        await commitUserMessage(message('m', 'p1'));
        await useChatStore.getState().setConversationPersona('A', null);
        await useChatStore.getState().loadConversations('character');
        expect((await getConversation('A'))?.lastPersonaId).toBeNull();
        expect((await getConversation('B'))?.lastPersonaId).toBe('p2');
        expect((await getConversationMessages('A'))[0].speaker?.personaId).toBe('p1');
        expect(useSettingsStore.getState().activePersonaId).toBe('p1');
    });
    it('initializes legacy associations only once and never overwrites an explicit choice', async () => {
        await saveConversation(conversation());
        useChatStore.setState({ conversations: [conversation()] });
        await useChatStore.getState().initializePersona('A', [message('m', 'missing')]);
        useSettingsStore.setState({ activePersonaId: 'p2' });
        await useChatStore.getState().initializePersona('A', []);
        expect((await getConversation('A'))?.lastPersonaId).toBe('missing');
        await patchConversation('A', { lastPersonaId: null });
        await patchConversation('A', { lastPersonaId: 'p1' }, true);
        expect((await getConversation('A'))?.lastPersonaId).toBeNull();
    });
});

describe('draft and metadata durability', () => {
    it('does not roll back independent fields when a background snapshot is saved', async () => {
        const old = conversation('A', {
            lastPersonaId: 'p1',
            draftText: 'Ancien',
            notes: ['Note'],
            sceneRoster: ['Anna'],
        });
        await saveConversation(old);
        await Promise.all([
            patchConversation('A', { lastPersonaId: 'p2' }),
            patchConversation('A', { draftText: 'Nouveau' }),
        ]);
        await saveConversation({ ...old, scratchpad: 'Mémoire actualisée' });
        expect(await getConversation('A')).toMatchObject({
            lastPersonaId: 'p2',
            draftText: 'Nouveau',
            notes: ['Note'],
            sceneRoster: ['Anna'],
            scratchpad: 'Mémoire actualisée',
        });
    });
    it('commits the message and clears only its matching draft in the same transaction', async () => {
        await saveConversation(conversation('A', { draftText: ' Bonjour ', lastPersonaId: 'p1' }));
        await commitUserMessage(message('m', 'p1'));
        expect((await getConversation('A'))?.draftText).toBe('');
        await patchConversation('A', { draftText: 'Un nouveau brouillon' });
        await commitUserMessage(message('m2', 'p1'));
        expect((await getConversation('A'))?.draftText).toBe('Un nouveau brouillon');
    });
    it('keeps the draft when the message write is rejected', async () => {
        await saveConversation(conversation('A', { draftText: 'Bonjour' }));
        await expect(
            commitUserMessage({ ...message('invalid'), id: undefined } as unknown as Message)
        ).rejects.toThrow();
        expect((await getConversation('A'))?.draftText).toBe('Bonjour');
        expect(await getConversationMessages('A')).toEqual([]);
    });
    it('survives rapid A → B → A with separate drafts and immediate persona changes', async () => {
        await saveConversation(conversation('A', { lastPersonaId: 'p1' }));
        await saveConversation(conversation('B', { lastPersonaId: 'p2' }));
        await useChatStore.getState().loadConversations('character');
        const store = useChatStore.getState();
        store.setActiveConversation('A');
        const draftA = store.setDraft('A', 'Brouillon A');
        store.setActiveConversation('B');
        const draftB = store.setDraft('B', 'Brouillon B');
        store.setActiveConversation('A');
        await Promise.all([draftA, draftB, store.setConversationPersona('A', null)]);
        await store.loadMessages('A');
        expect(useChatStore.getState().activeConversationId).toBe('A');
        expect(await getConversation('A')).toMatchObject({
            draftText: 'Brouillon A',
            lastPersonaId: null,
        });
        expect(await getConversation('B')).toMatchObject({
            draftText: 'Brouillon B',
            lastPersonaId: 'p2',
        });
    });
    it('persists a late response only in its original conversation and never resurrects deletions', async () => {
        await saveConversation(conversation());
        await saveConversation(conversation('B', { draftText: 'B' }));
        await saveMessage({ ...message('reply'), role: 'assistant', content: '' });
        useChatStore.setState({
            activeConversationId: 'B',
            messages: [],
            conversations: [conversation('B')],
        });
        useChatStore.getState().updateMessage('reply', { content: 'Réponse pour A' });
        await vi.waitFor(async () =>
            expect((await getConversationMessages('A'))[0].content).toBe('Réponse pour A')
        );
        expect(useChatStore.getState().messages).toEqual([]);
        expect((await getConversation('B'))?.draftText).toBe('B');
        await (await initDB()).delete('messages', 'reply');
        await patchStoredMessage('reply', { content: 'Fin tardive' });
        expect(await getConversationMessages('A')).toEqual([]);
    });
    it('inherits the current conversation persona when creating a new independent conversation', async () => {
        await saveConversation(conversation('A', { lastPersonaId: null }));
        useChatStore.setState({
            activeConversationId: 'A',
            conversations: [conversation('A', { lastPersonaId: null })],
        });
        const id = await useChatStore.getState().createConversation('character', 'Nouvelle');
        expect((await getConversation(id))?.lastPersonaId).toBeNull();
        await useChatStore.getState().setConversationPersona(id, 'p2');
        expect((await getConversation('A'))?.lastPersonaId).toBeNull();
    });
    it('includes associations, drafts and existing metadata in downloadable backups', async () => {
        const conv = conversation('A', {
            lastPersonaId: 'missing',
            draftText: '“Texte”\n星',
            notes: ['Note'],
            sceneRoster: ['Anna'],
        });
        await saveConversation(conv);
        const storage = { length: 0, key: () => null } as unknown as Storage;
        const backup = parseGlobalBackup(JSON.stringify(await createGlobalBackup(storage, 'test')));
        const row = backup.database!.stores.find((s) => s.name === 'conversations')!.entries[0];
        expect(unpackBackupValue(row.value)).toEqual(conv);
    });
});
