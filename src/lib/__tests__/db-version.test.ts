import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { DB_NAME, DB_VERSION, initDB } from '@/lib/db';
import { parseGlobalBackup } from '@/lib/global-backup';

it('lets a newer tab upgrade instead of blocking it', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    await initDB();
    const outcome = await new Promise<string>((resolve) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION + 1);
        req.onblocked = () => resolve('blocked');
        req.onsuccess = () => {
            req.result.close();
            resolve('opened');
        };
    });
    expect(outcome).toBe('opened');
});

it('accepts a backup at the current version and refuses a newer one', () => {
    const backup = (version: number) =>
        JSON.stringify({
            format: 'nexusai-global-backup',
            version: 1,
            createdAt: '',
            origin: '',
            apiKeys: 'reenter-on-restore',
            settings: null,
            localStorage: {},
            database: { version, stores: [] },
        });
    expect(() => parseGlobalBackup(backup(DB_VERSION))).not.toThrow();
    expect(() => parseGlobalBackup(backup(DB_VERSION + 1))).toThrow(
        'Version de base incompatible.'
    );
});
