import { packBackupValue, unpackBackupValue } from './backup-codec';
import {
    createSafeSettingsStorage,
    LEGACY_SETTINGS_KEY,
    mergeMissingSettings,
    parseSettings,
    SETTINGS_KEY,
    SETTINGS_VERSION,
    type SettingsEnvelope,
} from './settings-storage';

const DB_NAME = 'nexusai-db';
interface StoreSnapshot {
    name: string;
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
    entries: {
        key: ReturnType<typeof packBackupValue>;
        value: ReturnType<typeof packBackupValue>;
    }[];
}
export interface GlobalBackup {
    format: 'nexusai-global-backup';
    version: 1;
    createdAt: string;
    origin: string;
    apiKeys: 'reenter-on-restore';
    settings: SettingsEnvelope | null;
    // Includes the original/settings history even if one raw copy is corrupt.
    localStorage: Record<string, string>;
    database: { version: number; stores: StoreSnapshot[] } | null;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function completed(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('Transaction interrompue.'));
        tx.onerror = () => reject(tx.error ?? new Error('Lecture/écriture impossible.'));
    });
}

/** Never creates or upgrades a database just to export it. */
async function openExisting(): Promise<IDBDatabase | null> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME);
        let absent = false;
        req.onupgradeneeded = () => {
            absent = true;
            req.transaction!.abort();
        };
        req.onerror = () => (absent ? resolve(null) : reject(req.error));
        req.onblocked = () =>
            reject(
                new Error('La base est occupée. Réessayez après la fin des opérations en cours.')
            );
        req.onsuccess = () => resolve(req.result);
    });
}

export async function createGlobalBackup(
    storage: Storage,
    origin: string,
    liveSettings?: SettingsEnvelope
): Promise<GlobalBackup> {
    const local: Record<string, string> = {};
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith('nexusai')) {
            const raw = storage.getItem(key);
            if (raw !== null) local[key] = raw;
        }
    }
    let settings = liveSettings ?? null;
    if (!settings) {
        const raw = local[SETTINGS_KEY] ?? local[LEGACY_SETTINGS_KEY];
        // Preserve malformed raw settings in the archive; they must not prevent
        // rescuing the conversations. They cannot be applied automatically.
        if (raw) {
            try {
                settings = parseSettings(raw);
            } catch {
                /* raw copy retained */
            }
        }
    }
    if (settings)
        settings = JSON.parse(
            JSON.stringify({ ...settings, state: { ...settings.state, apiKeys: [] } })
        );
    const backup: GlobalBackup = {
        format: 'nexusai-global-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        origin,
        apiKeys: 'reenter-on-restore',
        settings,
        localStorage: local,
        database: null,
    };
    const db = await openExisting();
    if (!db) return backup;
    try {
        const names = [...db.objectStoreNames];
        if (!names.length) {
            backup.database = { version: db.version, stores: [] };
            return backup;
        }
        const tx = db.transaction(names, 'readonly');
        const done = completed(tx);
        // Queue ALL reads in one transaction before awaiting any of them.
        const reads = names.map(async (name): Promise<StoreSnapshot> => {
            const store = tx.objectStore(name);
            const metadata = {
                name,
                keyPath: store.keyPath,
                autoIncrement: store.autoIncrement,
                indexes: [...store.indexNames].map((indexName) => {
                    const index = store.index(indexName);
                    return {
                        name: index.name,
                        keyPath: index.keyPath,
                        unique: index.unique,
                        multiEntry: index.multiEntry,
                    };
                }),
            };
            const [keys, values] = await Promise.all([
                request(store.getAllKeys()),
                request(store.getAll()),
            ]);
            return {
                ...metadata,
                entries: keys.map((key, i) => ({
                    key: packBackupValue(key),
                    value: packBackupValue(values[i]),
                })),
            };
        });
        const [stores] = await Promise.all([Promise.all(reads), done]);
        backup.database = { version: db.version, stores };
        return backup;
    } finally {
        db.close();
    }
}

export function parseGlobalBackup(raw: string): GlobalBackup {
    const backup = JSON.parse(raw) as GlobalBackup;
    if (
        !backup ||
        backup.format !== 'nexusai-global-backup' ||
        backup.version !== 1 ||
        !backup.localStorage ||
        typeof backup.localStorage !== 'object' ||
        Array.isArray(backup.localStorage) ||
        !Object.entries(backup.localStorage).every(
            ([k, v]) => k.startsWith('nexusai') && typeof v === 'string'
        )
    ) {
        throw new Error('Ce fichier n’est pas une sauvegarde globale NexusAI compatible.');
    }
    if (backup.settings !== null) parseSettings(JSON.stringify(backup.settings));
    if (backup.database !== null) {
        const db = backup.database;
        if (
            !db ||
            !Number.isInteger(db.version) ||
            db.version < 1 ||
            db.version > 9 ||
            !Array.isArray(db.stores)
        )
            throw new Error('Version de base incompatible.');
        const names = new Set<string>();
        for (const store of db.stores) {
            if (
                !store ||
                typeof store.name !== 'string' ||
                names.has(store.name) ||
                !Array.isArray(store.entries) ||
                !(
                    store.keyPath === null ||
                    typeof store.keyPath === 'string' ||
                    (Array.isArray(store.keyPath) &&
                        store.keyPath.every((key) => typeof key === 'string'))
                ) ||
                typeof store.autoIncrement !== 'boolean' ||
                !Array.isArray(store.indexes) ||
                store.indexes.some(
                    (index) =>
                        !index ||
                        typeof index.name !== 'string' ||
                        !(
                            typeof index.keyPath === 'string' ||
                            (Array.isArray(index.keyPath) &&
                                index.keyPath.every((key) => typeof key === 'string'))
                        ) ||
                        typeof index.unique !== 'boolean' ||
                        typeof index.multiEntry !== 'boolean'
                )
            )
                throw new Error('Structure de base invalide.');
            names.add(store.name);
            for (const entry of store.entries) {
                const key = unpackBackupValue(entry.key) as IDBValidKey;
                indexedDB.cmp(key, key); // validate keys before writing anything
                const value = unpackBackupValue(entry.value);
                if (store.keyPath !== null) {
                    const readPath = (path: string) =>
                        path
                            .split('.')
                            .reduce<unknown>(
                                (v, part) => (v as Record<string, unknown>)?.[part],
                                value
                            );
                    const inlineKey = Array.isArray(store.keyPath)
                        ? store.keyPath.map(readPath)
                        : readPath(store.keyPath);
                    if (indexedDB.cmp(key, inlineKey as IDBValidKey) !== 0)
                        throw new Error('Identifiant de sauvegarde incohérent.');
                }
            }
        }
    }
    return backup;
}

/** Add missing DB records, then apply settings with a checkpoint. Never clear stores.
 * IndexedDB and localStorage cannot share a transaction; retries are idempotent if
 * the second phase fails, and the caller gets an explicit partial-restore error.
 */
export async function restoreGlobalBackup(backup: GlobalBackup, storage: Storage): Promise<number> {
    parseGlobalBackup(JSON.stringify(backup));
    let settingsError: string | null = null;
    const safe = createSafeSettingsStorage(
        () => storage,
        (message) => {
            settingsError = message;
        },
        { explicitRestore: true }
    );
    const before = safe.getItem(SETTINGS_KEY) as string | null;
    const current = before ? parseSettings(before) : { state: {}, version: SETTINGS_VERSION };
    let restoredSettings: SettingsEnvelope | null = null;
    if (backup.settings) {
        const merged = mergeMissingSettings(current, backup.settings);
        restoredSettings = {
            version: Math.min(current.version ?? 0, backup.settings.version ?? 0),
            state: {
                ...current.state,
                ...backup.settings.state,
                presets: merged.state.presets,
                personas: merged.state.personas,
                customModels: merged.state.customModels,
                customEngines: merged.state.customEngines,
                apiKeys: current.state.apiKeys ?? [],
            },
        };
    }
    let count = 0;
    if (backup.database?.stores.length) {
        const snapshot = backup.database;
        let db = await openExisting();
        if (!db) {
            db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, snapshot.version);
                req.onupgradeneeded = () => {
                    for (const store of snapshot.stores) {
                        const target = req.result.createObjectStore(store.name, {
                            keyPath: store.keyPath,
                            autoIncrement: store.autoIncrement,
                        });
                        for (const index of store.indexes)
                            target.createIndex(index.name, index.keyPath, {
                                unique: index.unique,
                                multiEntry: index.multiEntry,
                            });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                req.onblocked = () =>
                    reject(new Error('Fermez les autres onglets avant la restauration.'));
            });
        }
        try {
            for (const store of snapshot.stores) {
                if (!db.objectStoreNames.contains(store.name))
                    throw new Error(
                        `La base actuelle ne contient pas « ${store.name} ». Restauration interrompue avant écriture ; le fichier conserve ces données.`
                    );
            }
            const tx = db.transaction(
                snapshot.stores.map((store) => store.name),
                'readwrite'
            );
            const done = completed(tx);
            try {
                for (const source of snapshot.stores) {
                    const target = tx.objectStore(source.name);
                    if (JSON.stringify(target.keyPath) !== JSON.stringify(source.keyPath))
                        throw new Error('Structure de base différente.');
                    for (const entry of source.entries) {
                        const key = unpackBackupValue(entry.key) as IDBValidKey;
                        const value = unpackBackupValue(entry.value);
                        const check = target.getKey(key);
                        check.onsuccess = () => {
                            if (check.result === undefined) {
                                try {
                                    if (target.keyPath === null) target.add(value, key);
                                    else target.add(value);
                                    count++;
                                } catch {
                                    tx.abort();
                                }
                            }
                        };
                    }
                }
            } catch (error) {
                tx.abort();
                await done.catch(() => {});
                throw error;
            }
            await done;
        } finally {
            db.close();
        }
    }
    if (restoredSettings) {
        const raw = JSON.stringify(restoredSettings);
        safe.setItem(SETTINGS_KEY, raw);
        if (settingsError || storage.getItem(SETTINGS_KEY) !== raw) {
            throw new Error(
                `${count} données de la base ont été ajoutées, mais les réglages n’ont pas été restaurés : ${settingsError ?? 'écriture non confirmée'}. Gardez le fichier et réessayez après avoir résolu le problème.`
            );
        }
    }
    // Navigation preferences only; don't replay legacy settings over the protected
    // save, nor overwrite this device's backup history. Original raw copies remain in file.
    for (const [key, value] of Object.entries(backup.localStorage)) {
        if (key.startsWith('nexusai_active_') && storage.getItem(key) === null)
            storage.setItem(key, value);
    }
    return count;
}
