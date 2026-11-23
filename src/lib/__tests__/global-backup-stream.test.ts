import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import {
    createGlobalBackupFile,
    inspectGlobalBackupFile,
    isGzipFile,
    restoreGlobalBackupFile,
} from '@/lib/global-backup';
import { unpackBackupValue } from '@/lib/backup-codec';
import { SETTINGS_KEY } from '@/lib/settings-storage';

function storage(): Storage {
    const data = new Map<string, string>();
    return {
        get length() {
            return data.size;
        },
        key: (i) => [...data.keys()][i] ?? null,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value);
        },
        removeItem: (key) => {
            data.delete(key);
        },
        clear: () => data.clear(),
    };
}

async function seed(messageCount = 60) {
    await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('nexusai-db', 9);
        req.onupgradeneeded = () => {
            const db = req.result;
            const messages = db.createObjectStore('messages', { keyPath: 'id' });
            messages.createIndex('by-conversation', 'conversationId');
            for (let i = 0; i < messageCount; i++)
                messages.put({
                    id: `m${String(i).padStart(3, '0')}`,
                    conversationId: 'v1',
                    content: `Réplique ${i} — « bonjour »`,
                    createdAt: new Date(1000 + i),
                });
            db.createObjectStore('canon').put(
                { work: 'mixed case', character: 'Élodie' },
                'mixed case::élodie'
            );
            db.createObjectStore('vectors').put({ embedding: new Float32Array([0.1]) }, 'v');
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
            req.result.close();
            resolve();
        };
    });
}

async function lines(blob: Blob): Promise<Record<string, unknown>[]> {
    const text = await new Response(
        blob.stream().pipeThrough(new DecompressionStream('gzip'))
    ).text();
    return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

const settings = {
    version: 2,
    state: { presets: [], personas: [{ id: 'u' }], apiKeys: [{ encryptedKey: 'device' }] },
};

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => vi.restoreAllMocks());

describe('streamed global backup (v2)', () => {
    it('writes every store page by page, skipping the legacy stores', async () => {
        await seed();
        const all = await lines(await createGlobalBackupFile(storage(), 'origin'));
        const header = all[0] as { version: number; database: { version: number } };
        expect(header.version).toBe(2);
        expect(header.database.version).toBe(9);
        const stores = all
            .filter((line) => 'store' in line)
            .map((line) => (line.store as { name: string }).name);
        expect(stores).toEqual(['canon', 'messages']);
        const records = all.filter((line) => 's' in line);
        expect(records.filter((line) => line.s === 'messages')).toHaveLength(60);
        const canon = records.find((line) => line.s === 'canon')!;
        expect(unpackBackupValue(canon.k)).toBe('mixed case::élodie');
        expect(all.at(-1)).toEqual({ end: true, records: 61 });
    });

    it('never asks IndexedDB for more than 25 records at once', async () => {
        await seed();
        const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
        const getAllKeys = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys');
        await createGlobalBackupFile(storage(), 'origin');
        expect(getAll.mock.calls.length).toBeGreaterThanOrEqual(3);
        for (const call of [...getAll.mock.calls, ...getAllKeys.mock.calls])
            expect(call[1]).toBe(25);
    });

    it('strips API keys from the settings it rebuilds', async () => {
        await seed(1);
        const local = storage();
        local.setItem(SETTINGS_KEY, JSON.stringify(settings));
        const [header] = await lines(await createGlobalBackupFile(local, 'origin'));
        const state = (header.settings as { state: Record<string, unknown> }).state;
        expect(state.apiKeys).toEqual([]);
        expect(state.personas).toEqual([{ id: 'u' }]);
    });

    it('reports progress up to the full record count', async () => {
        await seed();
        const progress: [number, number][] = [];
        await createGlobalBackupFile(storage(), 'origin', undefined, (done, total) =>
            progress.push([done, total])
        );
        expect(progress.at(-1)).toEqual([61, 61]);
    });
});

function withStore<T>(
    name: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open('nexusai-db');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const req = run(open.result.transaction(name, mode).objectStore(name));
            req.onsuccess = () => {
                open.result.close();
                resolve(req.result);
            };
            req.onerror = () => reject(req.error);
        };
    });
}

async function gzipLines(lines: unknown[]): Promise<Blob> {
    const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
    return new Response(
        new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
    ).blob();
}

describe('streamed restore (v2)', () => {
    it('round-trips onto a fresh device, then adds nothing the second time', async () => {
        await seed();
        const local = storage();
        local.setItem(SETTINGS_KEY, JSON.stringify(settings));
        const file = await createGlobalBackupFile(local, 'origin');
        expect(await isGzipFile(file)).toBe(true);
        expect(await isGzipFile(new Blob(['{"format":"nexusai-global-backup"}']))).toBe(false);

        vi.stubGlobal('indexedDB', new IDBFactory());
        const destination = storage();
        expect(await restoreGlobalBackupFile(file, destination)).toBe(61);
        const messages = await withStore('messages', 'readonly', (s) => s.getAll());
        expect(messages).toHaveLength(60);
        expect((messages[0] as { createdAt: Date }).createdAt).toEqual(new Date(1000));
        expect(await withStore('canon', 'readonly', (s) => s.get('mixed case::élodie'))).toEqual({
            work: 'mixed case',
            character: 'Élodie',
        });
        expect(JSON.parse(destination.getItem(SETTINGS_KEY)!).state.personas).toEqual([
            { id: 'u' },
        ]);
        expect(await restoreGlobalBackupFile(file, destination)).toBe(0);
    });

    it('refuses a file cut short before writing anything', async () => {
        await seed();
        const complete = await lines(await createGlobalBackupFile(storage(), 'origin'));
        const cut = await gzipLines(complete.slice(0, -1));
        vi.stubGlobal('indexedDB', new IDBFactory());
        await expect(restoreGlobalBackupFile(cut, storage())).rejects.toThrow(/incomplet/);
        expect(await indexedDB.databases()).toEqual([]);
    });

    it('never overwrites a record that already exists', async () => {
        await seed();
        const file = await createGlobalBackupFile(storage(), 'origin');
        await withStore('messages', 'readwrite', (s) =>
            s.put({
                id: 'm000',
                conversationId: 'v1',
                content: 'édité ici',
                createdAt: new Date(1),
            })
        );
        expect(await restoreGlobalBackupFile(file, storage())).toBe(0);
        expect(
            ((await withStore('messages', 'readonly', (s) => s.get('m000'))) as { content: string })
                .content
        ).toBe('édité ici');
    });

    it('summarises a file without writing to the database', async () => {
        await seed();
        const file = await createGlobalBackupFile(storage(), 'origin');
        vi.stubGlobal('indexedDB', new IDBFactory());
        const summary = await inspectGlobalBackupFile(file);
        expect(summary.counts).toEqual({ canon: 1, messages: 60 });
        expect(summary.total).toBe(61);
        expect(await indexedDB.databases()).toEqual([]);
    });
});
