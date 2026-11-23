import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
    createGlobalBackupFile,
    parseGlobalBackup,
    restoreGlobalBackup,
    restoreGlobalBackupFile,
    type GlobalBackup,
} from '@/lib/global-backup';
import { packBackupValue, unpackBackupValue } from '@/lib/backup-codec';
import { SETTINGS_KEY, SETTINGS_HISTORY_KEY } from '@/lib/settings-storage';

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

const records = {
    character: {
        id: 'c',
        name: 'Éléonore “星”',
        avatar: 'data:image/png;base64,AA==',
        description: '"Bonjour" 🐉',
        createdAt: new Date(0),
    },
    message: { id: 'm', content: 'private story', createdAt: new Date(1234) },
    canon: { work: 'Mixed CASE', character: 'Élodie' },
    vector: { embedding: new Float32Array([0.1, 0.2]), unused: undefined },
    summary: { id: 's', content: 'Long-term memory' },
};

async function seed() {
    await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('nexusai-db', 9);
        req.onupgradeneeded = () => {
            const chars = req.result.createObjectStore('characters', { keyPath: 'id' });
            chars.createIndex('by-name', 'name');
            chars.put(records.character);
            req.result.createObjectStore('messages', { keyPath: 'id' }).put(records.message);
            req.result.createObjectStore('canon').put(records.canon, 'mixed case::élodie');
            req.result.createObjectStore('vectors').put(records.vector, ['compound', 3]);
            req.result.createObjectStore('summaries', { keyPath: 'id' }).put(records.summary);
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
            req.result.close();
            resolve();
        };
    });
}

function read(name: string, key: IDBValidKey): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open('nexusai-db');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const req = open.result.transaction(name).objectStore(name).get(key);
            req.onsuccess = () => {
                open.result.close();
                resolve(req.result);
            };
            req.onerror = () => reject(req.error);
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
    state: {
        presets: [{ id: 'p' }],
        personas: [{ id: 'u' }],
        customModels: [{ id: 'model' }],
        customEngines: [],
        temperature: 0.42,
        apiKeys: [{ encryptedKey: 'device-bound' }],
    },
};

const store = (
    name: string,
    keyPath: string | null,
    entries: [IDBValidKey, unknown][],
    indexes: { name: string; keyPath: string; unique: boolean; multiEntry: boolean }[] = []
) => ({
    name,
    keyPath,
    autoIncrement: false,
    indexes,
    entries: entries.map(([key, value]) => ({
        key: packBackupValue(key),
        value: packBackupValue(value),
    })),
});

/** An old v1 file, written by hand: the format that existing backup files use. */
const v1File = (): GlobalBackup => ({
    format: 'nexusai-global-backup',
    version: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    origin: 'origin',
    apiKeys: 'reenter-on-restore',
    settings: { ...settings, state: { ...settings.state, apiKeys: [] } },
    localStorage: { [SETTINGS_KEY]: JSON.stringify(settings) },
    database: {
        version: 9,
        stores: [
            store('canon', null, [['mixed case::élodie', records.canon]]),
            store(
                'characters',
                'id',
                [['c', records.character]],
                [{ name: 'by-name', keyPath: 'name', unique: false, multiEntry: false }]
            ),
            store('messages', 'id', [['m', records.message]]),
            store('summaries', 'id', [['s', records.summary]]),
            store('vectors', null, [[['compound', 3], records.vector]]),
        ],
    },
});

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

describe('global backup file (v2)', () => {
    it('exports every store with exact keys, original settings/history and no unrelated storage', async () => {
        await seed();
        const local = storage();
        local.setItem(SETTINGS_KEY, JSON.stringify(settings));
        local.setItem(SETTINGS_HISTORY_KEY, '[original history]');
        local.setItem('unrelated', 'other app');
        const all = await lines(await createGlobalBackupFile(local, 'https://example.test'));
        const header = all[0] as {
            settings: { state: Record<string, unknown> };
            localStorage: Record<string, string>;
        };
        expect(
            all
                .filter((line) => 'store' in line)
                .map((line) => (line.store as { name: string }).name)
        ).toEqual(['canon', 'characters', 'messages', 'summaries']);
        const canon = all.find((line) => line.s === 'canon')!;
        expect(unpackBackupValue(canon.k)).toBe('mixed case::élodie');
        expect(header.settings.state.apiKeys).toEqual([]);
        expect(header.localStorage[SETTINGS_KEY]).toBe(JSON.stringify(settings));
        expect(header.localStorage[SETTINGS_HISTORY_KEY]).toBe('[original history]');
        expect(header.localStorage).not.toHaveProperty('unrelated');
    });

    it('rescues raw corrupt settings alongside the database instead of replacing them with defaults', async () => {
        await seed();
        const local = storage();
        local.setItem(SETTINGS_KEY, '{broken');
        const all = await lines(await createGlobalBackupFile(local, 'origin'));
        const header = all[0] as { settings: unknown; localStorage: Record<string, string> };
        expect(header.settings).toBeNull();
        expect(header.localStorage[SETTINGS_KEY]).toBe('{broken');
        expect(all.filter((line) => 'store' in line)).toHaveLength(4);
        expect(local.getItem(SETTINGS_KEY)).toBe('{broken');
    });

    it('includes unsaved settings from the current tab and the different disk copy', async () => {
        const local = storage();
        local.setItem(SETTINGS_KEY, JSON.stringify(settings));
        const live = { ...settings, state: { ...settings.state, personas: [{ id: 'unsaved' }] } };
        const [header] = await lines(await createGlobalBackupFile(local, 'origin', live));
        expect((header.settings as { state: { personas: unknown } }).state.personas).toEqual([
            { id: 'unsaved' },
        ]);
        expect((header.localStorage as Record<string, string>)[SETTINGS_KEY]).toBe(
            JSON.stringify(settings)
        );
        expect(header.database).toBeNull();
        expect(await indexedDB.databases()).toEqual([]);
    });

    it('refuses a file whose stores this device lacks, before writing anything', async () => {
        await seed();
        const file = await createGlobalBackupFile(storage(), 'origin');
        vi.stubGlobal('indexedDB', new IDBFactory());
        await new Promise<void>((resolve) => {
            const req = indexedDB.open('nexusai-db', 9);
            req.onupgradeneeded = () => req.result.createObjectStore('messages', { keyPath: 'id' });
            req.onsuccess = () => {
                req.result.close();
                resolve();
            };
        });
        await expect(restoreGlobalBackupFile(file, storage())).rejects.toThrow(/ne contient pas/);
        expect(await read('messages', 'm')).toBeUndefined();
    });

    it('refuses a file whose store keys differ from this device, before writing anything', async () => {
        await seed();
        const file = await createGlobalBackupFile(storage(), 'origin');
        vi.stubGlobal('indexedDB', new IDBFactory());
        await new Promise<void>((resolve) => {
            const req = indexedDB.open('nexusai-db', 9);
            req.onupgradeneeded = () => {
                for (const name of ['characters', 'messages', 'summaries'])
                    req.result.createObjectStore(name, { keyPath: 'id' });
                req.result.createObjectStore('canon', { keyPath: 'work' });
            };
            req.onsuccess = () => {
                req.result.close();
                resolve();
            };
        });
        await expect(restoreGlobalBackupFile(file, storage())).rejects.toThrow(
            /Structure de base différente/
        );
        expect(await read('messages', 'm')).toBeUndefined();
    });
});

describe('old global backup files (v1)', () => {
    it('restores onto a fresh device without losing dates, binary data, or settings', async () => {
        const backup = parseGlobalBackup(JSON.stringify(v1File()));
        const destination = storage();
        expect(await restoreGlobalBackup(backup, destination)).toBe(5);
        expect(await read('characters', 'c')).toEqual(records.character);
        expect(await read('messages', 'm')).toEqual(records.message);
        expect(await read('vectors', ['compound', 3])).toEqual(records.vector);
        const state = JSON.parse(destination.getItem(SETTINGS_KEY)!).state;
        expect(state.personas).toEqual(settings.state.personas);
        expect(state.temperature).toBe(0.42);
        expect(state.apiKeys).toEqual([]);
        expect(await restoreGlobalBackup(backup, destination)).toBe(0);
    });

    it('keeps existing records and device API keys, with a pre-restore settings checkpoint', async () => {
        await seed();
        const local = storage();
        local.setItem(
            SETTINGS_KEY,
            JSON.stringify({
                ...settings,
                state: {
                    ...settings.state,
                    temperature: 0.1,
                    personas: [{ id: 'u', name: 'Edited here' }],
                },
            })
        );
        expect(await restoreGlobalBackup(v1File(), local)).toBe(0);
        const state = JSON.parse(local.getItem(SETTINGS_KEY)!).state;
        expect(state.personas).toEqual([{ id: 'u', name: 'Edited here' }]);
        expect(state.apiKeys).toEqual(settings.state.apiKeys);
        expect(local.getItem(SETTINGS_HISTORY_KEY)).not.toBeNull();
    });

    it('rejects malformed records and unsupported versions before restoration', () => {
        const backup = v1File();
        expect(() => parseGlobalBackup(JSON.stringify({ ...backup, version: 2 }))).toThrow();
        backup.database!.stores[0].entries[0].key = packBackupValue({ not: 'an IDB key' });
        expect(() => parseGlobalBackup(JSON.stringify(backup))).toThrow();
    });
});

describe('lossless backup values', () => {
    it('preserves binary views, dates, nested objects, sets, maps and special numbers', () => {
        const value = {
            type: 'date',
            value: 'ordinary text',
            date: new Date(0),
            n: NaN,
            negativeZero: -0,
            big: BigInt(12),
            nested: [undefined, Infinity, new Set(['a']), new Map([['key', 'value']])],
            view: new Uint16Array([2, 65535]),
            vector: new Float32Array([0.1, 2]),
            binary: new Uint8Array([0, 255]).buffer,
        };
        expect(unpackBackupValue(JSON.parse(JSON.stringify(packBackupValue(value))))).toEqual(
            value
        );
    });
    it('fails explicitly for unsupported values instead of silently saving an empty object', () => {
        expect(() => packBackupValue(new Blob(['private']))).toThrow();
    });
});
