/**
 * The v9 upgrade must be purely additive. This replays what a real user's browser holds
 * after v8 — including the two legacy stores v8 deliberately stopped dropping — then opens
 * the database through `initDB()` and checks every row back, byte for byte.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { initDB, markRunningSceneBeatsInterrupted } from '@/lib/db';

const DB_NAME = 'nexusai-db';

const seed = {
    character: {
        id: 'char-1',
        name: 'Alice',
        description: 'Une carte importée avant la v9.',
        personality: 'Directe',
        scenario: '',
        first_mes: 'Bonjour.',
        mes_example: '',
        longTermMemory: ['souvenir'],
        createdAt: new Date(1_700_000_000_000),
    },
    conversation: {
        id: 'conv-1',
        characterId: 'char-1',
        title: 'Discussion v8',
        sceneMode: true,
        sceneRoster: ['Alice', 'Bob'],
        sceneStyle: 'turns',
        relationships: [{ from: 'Alice', to: '__user__', axes: { trust: 3 }, ledger: [] }],
        arc: { work: 'Œuvre', currentPosition: 'Chapitre 2' },
        createdAt: new Date(1_700_000_000_000),
        updatedAt: new Date(1_700_000_500_000),
    },
    messages: [
        {
            id: 'msg-1',
            conversationId: 'conv-1',
            parentId: null,
            role: 'user',
            content: 'Salut Alice.',
            isActiveBranch: true,
            createdAt: new Date(1_700_000_100_000),
            messageOrder: 1,
            regenerationIndex: 0,
        },
        {
            id: 'msg-2',
            conversationId: 'conv-1',
            parentId: 'msg-1',
            role: 'assistant',
            content: 'Salut.',
            isActiveBranch: true,
            createdAt: new Date(1_700_000_200_000),
            messageOrder: 2,
            regenerationIndex: 0,
            speaker: { kind: 'character', name: 'Alice' },
        },
    ],
    summary: {
        id: 'sum-1',
        conversationId: 'conv-1',
        level: 0,
        content: 'Ils se saluent.',
        messageRange: [0, 2],
        childIds: [],
        createdAt: 1_700_000_300_000,
    },
    lorebookHistory: {
        id: 'lore-1',
        characterId: 'char-1',
        timestamp: 1_700_000_400_000,
        action: 'add',
        entry: { keys: ['clé'], content: 'Une entrée.' },
    },
    setting: { key: 'theme', value: 'dark' },
    canon: {
        key: 'œuvre::alice',
        value: { work: 'œuvre', character: 'Alice', identity: 'Héroïne', stub: false },
    },
    arcOutline: { key: 'œuvre', value: { work: 'œuvre', outline: 'Trois actes.', sources: [] } },
    legacyFact: { id: 'fact-1', conversationId: 'conv-1', text: 'Un fait v7.' },
    legacyVector: { id: 'vec-1', conversationId: 'conv-1', embedding: [0.1, 0.2] },
};

function createV8Database(): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 8);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore('characters', { keyPath: 'id' }).createIndex('by-name', 'name');
            db.createObjectStore('conversations', { keyPath: 'id' }).createIndex(
                'by-character',
                'characterId'
            );
            db.createObjectStore('messages', { keyPath: 'id' }).createIndex(
                'by-conversation',
                'conversationId'
            );
            const lore = db.createObjectStore('lorebookHistory', { keyPath: 'id' });
            lore.createIndex('by-character', 'characterId');
            lore.createIndex('by-timestamp', 'timestamp');
            db.createObjectStore('settings', { keyPath: 'key' });
            const summaries = db.createObjectStore('summaries', { keyPath: 'id' });
            summaries.createIndex('by-conversation', 'conversationId');
            summaries.createIndex('by-level', 'level');
            db.createObjectStore('canon').createIndex('by-work', 'work');
            db.createObjectStore('arcOutlines');
            // Left behind by v7 and intentionally never dropped since.
            db.createObjectStore('facts', { keyPath: 'id' });
            db.createObjectStore('vectors', { keyPath: 'id' });
        };
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(
                [
                    'characters',
                    'conversations',
                    'messages',
                    'lorebookHistory',
                    'settings',
                    'summaries',
                    'canon',
                    'arcOutlines',
                    'facts',
                    'vectors',
                ],
                'readwrite'
            );
            tx.objectStore('characters').put(seed.character);
            tx.objectStore('conversations').put(seed.conversation);
            for (const message of seed.messages) tx.objectStore('messages').put(message);
            tx.objectStore('lorebookHistory').put(seed.lorebookHistory);
            tx.objectStore('settings').put(seed.setting);
            tx.objectStore('summaries').put(seed.summary);
            tx.objectStore('canon').put(seed.canon.value, seed.canon.key);
            tx.objectStore('arcOutlines').put(seed.arcOutline.value, seed.arcOutline.key);
            tx.objectStore('facts').put(seed.legacyFact);
            tx.objectStore('vectors').put(seed.legacyVector);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        };
    });
}

describe('IndexedDB v8 → v9 upgrade', () => {
    it('keeps every existing row and store intact and only adds the two new stores', async () => {
        await createV8Database();

        const db = await initDB();
        expect(db.version).toBe(9);

        // Additive: the two new stores exist and are empty.
        expect(db.objectStoreNames.contains('storyStates')).toBe(true);
        expect(db.objectStoreNames.contains('sceneBeats')).toBe(true);
        expect(await db.count('storyStates')).toBe(0);
        expect(await db.count('sceneBeats')).toBe(0);

        // Nothing dropped, not even the legacy v7 stores.
        const storeNames = Array.from(db.objectStoreNames as unknown as ArrayLike<string>);
        for (const store of [
            'characters',
            'conversations',
            'messages',
            'lorebookHistory',
            'settings',
            'summaries',
            'canon',
            'arcOutlines',
            'facts',
            'vectors',
        ]) {
            expect(storeNames.includes(store), `store ${store} missing`).toBe(true);
        }

        // Every row reads back exactly as written.
        expect(await db.get('characters', 'char-1')).toEqual(seed.character);
        expect(await db.get('conversations', 'conv-1')).toEqual(seed.conversation);
        expect(await db.getAllFromIndex('messages', 'by-conversation', 'conv-1')).toEqual(
            seed.messages
        );
        expect(await db.get('lorebookHistory', 'lore-1')).toEqual(seed.lorebookHistory);
        expect(await db.get('settings', 'theme')).toEqual(seed.setting);
        expect(await db.get('summaries', 'sum-1')).toEqual(seed.summary);
        expect(await db.get('canon', seed.canon.key)).toEqual(seed.canon.value);
        expect(await db.get('arcOutlines', seed.arcOutline.key)).toEqual(seed.arcOutline.value);

        // The startup sweep only touches in-flight beats; a v8 database has none.
        await markRunningSceneBeatsInterrupted();
        expect(await db.count('messages')).toBe(2);
        expect(await db.count('conversations')).toBe(1);
        expect(await db.count('characters')).toBe(1);

        // Raw check on the untyped legacy stores: still there, still readable.
        const raw = await new Promise<{ fact: unknown; vector: unknown }>((resolve, reject) => {
            const request = indexedDB.open(DB_NAME);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const rawDb = request.result;
                const tx = rawDb.transaction(['facts', 'vectors'], 'readonly');
                const fact = tx.objectStore('facts').get('fact-1');
                const vector = tx.objectStore('vectors').get('vec-1');
                tx.oncomplete = () => {
                    rawDb.close();
                    resolve({ fact: fact.result, vector: vector.result });
                };
                tx.onerror = () => reject(tx.error);
            };
        });
        expect(raw.fact).toEqual(seed.legacyFact);
        expect(raw.vector).toEqual(seed.legacyVector);
    });
});
