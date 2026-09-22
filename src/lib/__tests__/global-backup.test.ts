import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createGlobalBackup, parseGlobalBackup, restoreGlobalBackup } from '@/lib/global-backup';
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
async function seed() {
    await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('nexusai-db', 9);
        req.onupgradeneeded = () => {
            const chars = req.result.createObjectStore('characters', { keyPath: 'id' });
            chars.createIndex('by-name', 'name');
            chars.put({
                id: 'c',
                name: 'Éléonore “星”',
                avatar: 'data:image/png;base64,AA==',
                description: '"Bonjour" 🐉',
                createdAt: new Date(0),
            });
            req.result
                .createObjectStore('messages', { keyPath: 'id' })
                .put({ id: 'm', content: 'private story', createdAt: new Date(1234) });
            req.result
                .createObjectStore('canon')
                .put({ work: 'Mixed CASE', character: 'Élodie' }, 'mixed case::élodie');
            req.result
                .createObjectStore('vectors')
                .put({ embedding: new Float32Array([0.1, 0.2]), unused: undefined }, [
                    'compound',
                    3,
                ]);
            req.result
                .createObjectStore('summaries', { keyPath: 'id' })
                .put({ id: 's', content: 'Long-term memory' });
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
            req.result.close();
            resolve();
        };
    });
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

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

describe('global backup', () => {
    it('exports every store with exact keys, original settings/history and no unrelated storage', async () => {
        await seed();
        const local = storage();
        local.setItem(SETTINGS_KEY, JSON.stringify(settings));
        local.setItem(SETTINGS_HISTORY_KEY, '[original history]');
        local.setItem('unrelated', 'other app');
        const backup = await createGlobalBackup(local, 'https://example.test');
        expect(backup.database?.stores.map((s) => s.name)).toEqual([
            'canon',
            'characters',
            'messages',
            'summaries',
            'vectors',
        ]);
        const canon = backup.database!.stores.find((s) => s.name === 'canon')!;
        expect(unpackBackupValue(canon.entries[0].key)).toBe('mixed case::élodie');
        expect(backup.settings!.state.apiKeys).toEqual([]);
        expect(backup.localStorage[SETTINGS_KEY]).toBe(JSON.stringify(settings));
        expect(backup.localStorage[SETTINGS_HISTORY_KEY]).toBe('[original history]');
        expect(backup.localStorage).not.toHaveProperty('unrelated');
    });

    it('round-trips the downloadable JSON onto a fresh device without losing dates, binary data, or settings', async () => {
        await seed();
        const local = storage();
        local.setItem(SETTINGS_KEY, JSON.stringify(settings));
        const backup = parseGlobalBackup(JSON.stringify(await createGlobalBackup(local, 'origin')));
        vi.stubGlobal('indexedDB', new IDBFactory());
        const destination = storage();
        expect(await restoreGlobalBackup(backup, destination)).toBe(5);
        const restored = await createGlobalBackup(destination, 'new-origin');
        expect(restored.database).toEqual(backup.database);
        expect(restored.settings?.state.personas).toEqual(settings.state.personas);
        expect(restored.settings?.state.temperature).toBe(0.42);
        expect(restored.settings?.state.apiKeys).toEqual([]);
        expect(await restoreGlobalBackup(backup, destination)).toBe(0);
    });

    it('keeps existing records and device API keys, with a pre-restore settings checkpoint', async () => {
        await seed();
        const local = storage();
        local.setItem(SETTINGS_KEY, JSON.stringify(settings));
        const backup = await createGlobalBackup(local, 'origin');
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
        expect(await restoreGlobalBackup(backup, local)).toBe(0);
        const state = JSON.parse(local.getItem(SETTINGS_KEY)!).state;
        expect(state.personas).toEqual([{ id: 'u', name: 'Edited here' }]);
        expect(state.apiKeys).toEqual(settings.state.apiKeys);
        expect(local.getItem(SETTINGS_HISTORY_KEY)).not.toBeNull();
    });

    it('rescues raw corrupt settings alongside the database instead of replacing them with defaults', async () => {
        await seed();
        const local = storage();
        local.setItem(SETTINGS_KEY, '{broken');
        const backup = await createGlobalBackup(local, 'origin');
        expect(backup.settings).toBeNull();
        expect(backup.localStorage[SETTINGS_KEY]).toBe('{broken');
        expect(backup.database?.stores).toHaveLength(5);
        expect(local.getItem(SETTINGS_KEY)).toBe('{broken');
    });

    it('includes unsaved settings from the current tab and the different disk copy', async () => {
        const local = storage();
        local.setItem(SETTINGS_KEY, JSON.stringify(settings));
        const live = { ...settings, state: { ...settings.state, personas: [{ id: 'unsaved' }] } };
        const backup = await createGlobalBackup(local, 'origin', live);
        expect(backup.settings?.state.personas).toEqual([{ id: 'unsaved' }]);
        expect(backup.localStorage[SETTINGS_KEY]).toBe(JSON.stringify(settings));
        expect(backup.database).toBeNull();
        expect(await indexedDB.databases()).toEqual([]);
    });

    it('rejects malformed records and unsupported versions before restoration', async () => {
        await seed();
        const backup = await createGlobalBackup(storage(), 'origin');
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
