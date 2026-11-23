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

/** The `nexusai*` localStorage copies and the settings to restore, API keys removed. */
function snapshotLocalState(
    storage: Storage,
    liveSettings?: SettingsEnvelope
): { settings: SettingsEnvelope | null; localStorage: Record<string, string> } {
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
    return { settings, localStorage: local };
}

function storeMetadata(store: IDBObjectStore): Omit<StoreSnapshot, 'entries'> {
    return {
        name: store.name,
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
}

// ============ v2: streamed backup file (gzip NDJSON) ============
// v1 files (one JSON object, written by an earlier version that read every store at once)
// are only read now — see `parseGlobalBackup` / `restoreGlobalBackup`.

/** Records per IndexedDB request: keeps every read small enough for iOS Safari. */
const BACKUP_PAGE_SIZE = 25;
/** Unread and unwritten since DB v8, and the heaviest data on old devices. */
const LEGACY_STORES = ['facts', 'vectors'];

type BackupProgress = (done: number, total: number) => void;

function readPage(
    db: IDBDatabase,
    name: string,
    after: IDBValidKey | undefined
): Promise<[IDBValidKey[], unknown[]]> {
    const store = db.transaction(name, 'readonly').objectStore(name);
    const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
    return Promise.all([
        request(store.getAllKeys(range, BACKUP_PAGE_SIZE)),
        request(store.getAll(range, BACKUP_PAGE_SIZE)),
    ]);
}

/**
 * The full backup as a gzip NDJSON file: a header line, then per store a `{ store }` line
 * followed by its `{ s, k, v }` record lines, then `{ end, records }`. Read one page at a
 * time; only the compressed output is ever held in memory.
 */
export async function createGlobalBackupFile(
    storage: Storage,
    origin: string,
    liveSettings?: SettingsEnvelope,
    onProgress?: BackupProgress
): Promise<Blob> {
    const { settings, localStorage: local } = snapshotLocalState(storage, liveSettings);
    const gzip = new CompressionStream('gzip');
    const output = new Response(gzip.readable).blob();
    const writer = gzip.writable.getWriter();
    const encoder = new TextEncoder();
    // One line at a time: a page of 25 large avatars joined into one string would hold
    // several copies of the page in memory at once.
    const write = async (lines: unknown[]) => {
        for (const line of lines) await writer.write(encoder.encode(`${JSON.stringify(line)}\n`));
    };
    try {
        const db = await openExisting();
        try {
            await write([
                {
                    format: 'nexusai-global-backup',
                    version: 2,
                    createdAt: new Date().toISOString(),
                    origin,
                    apiKeys: 'reenter-on-restore',
                    settings,
                    localStorage: local,
                    database: db ? { version: db.version } : null,
                },
            ]);
            let done = 0;
            if (db) {
                const names = [...db.objectStoreNames].filter(
                    (name) => !LEGACY_STORES.includes(name)
                );
                const counts = await Promise.all(
                    names.map((name) =>
                        request(db.transaction(name, 'readonly').objectStore(name).count())
                    )
                );
                const total = counts.reduce((sum, count) => sum + count, 0);
                onProgress?.(0, total);
                for (const name of names) {
                    const meta = storeMetadata(db.transaction(name, 'readonly').objectStore(name));
                    await write([{ store: meta }]);
                    let after: IDBValidKey | undefined;
                    for (;;) {
                        const [keys, values] = await readPage(db, name, after);
                        if (!keys.length) break;
                        await write(
                            keys.map((key, i) => ({
                                s: name,
                                k: packBackupValue(key),
                                v: packBackupValue(values[i]),
                            }))
                        );
                        done += keys.length;
                        onProgress?.(done, Math.max(total, done));
                        if (keys.length < BACKUP_PAGE_SIZE) break;
                        after = keys[keys.length - 1];
                    }
                }
            }
            await write([{ end: true, records: done }]);
        } finally {
            db?.close();
        }
        await writer.close();
    } catch (error) {
        output.catch(() => {});
        await writer.abort(error).catch(() => {});
        throw error;
    }
    return output;
}

type StoreMeta = Omit<StoreSnapshot, 'entries'>;
const MAX_DB_VERSION = 9;
const NOT_A_BACKUP = 'Ce fichier n’est pas une sauvegarde globale NexusAI compatible.';

function checkHeader(backup: Partial<GlobalBackup> | null, version: 1 | 2): void {
    if (
        !backup ||
        backup.format !== 'nexusai-global-backup' ||
        (backup.version as number) !== version ||
        !backup.localStorage ||
        typeof backup.localStorage !== 'object' ||
        Array.isArray(backup.localStorage) ||
        !Object.entries(backup.localStorage).every(
            ([k, v]) => k.startsWith('nexusai') && typeof v === 'string'
        )
    ) {
        throw new Error(NOT_A_BACKUP);
    }
    if (backup.settings !== null) parseSettings(JSON.stringify(backup.settings));
    const db = backup.database;
    if (
        db !== null &&
        (!db || !Number.isInteger(db.version) || db.version < 1 || db.version > MAX_DB_VERSION)
    )
        throw new Error('Version de base incompatible.');
}

function checkStoreMeta(store: StoreMeta | null, seen: Set<string>): void {
    if (
        !store ||
        typeof store.name !== 'string' ||
        seen.has(store.name) ||
        !(
            store.keyPath === null ||
            typeof store.keyPath === 'string' ||
            (Array.isArray(store.keyPath) && store.keyPath.every((key) => typeof key === 'string'))
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
    seen.add(store.name);
}

/** Validate one record before anything is written; returns it unpacked. */
function checkEntry(
    store: StoreMeta,
    packedKey: unknown,
    packedValue: unknown
): { key: IDBValidKey; value: unknown } {
    const key = unpackBackupValue(packedKey) as IDBValidKey;
    indexedDB.cmp(key, key); // throws on a value that is not a valid IndexedDB key
    const value = unpackBackupValue(packedValue);
    if (store.keyPath !== null) {
        const readPath = (path: string) =>
            path
                .split('.')
                .reduce<unknown>((v, part) => (v as Record<string, unknown>)?.[part], value);
        const inlineKey = Array.isArray(store.keyPath)
            ? store.keyPath.map(readPath)
            : readPath(store.keyPath);
        if (indexedDB.cmp(key, inlineKey as IDBValidKey) !== 0)
            throw new Error('Identifiant de sauvegarde incohérent.');
    }
    return { key, value };
}

export function parseGlobalBackup(raw: string): GlobalBackup {
    const backup = JSON.parse(raw) as GlobalBackup;
    checkHeader(backup, 1);
    if (backup.database !== null) {
        if (!Array.isArray(backup.database.stores))
            throw new Error('Version de base incompatible.');
        const names = new Set<string>();
        for (const store of backup.database.stores) {
            checkStoreMeta(store, names);
            if (!Array.isArray(store.entries)) throw new Error('Structure de base invalide.');
            for (const entry of store.entries) checkEntry(store, entry.key, entry.value);
        }
    }
    return backup;
}

// ============ Restore (v1 object and v2 file share these steps) ============

/**
 * Read the current settings first (a read failure aborts before any write), merge the
 * backup's authored collections in, and return the step that applies them at the end.
 */
function prepareSettingsRestore(
    storage: Storage,
    backupSettings: SettingsEnvelope | null
): (count: number, localCopies: Record<string, string>) => void {
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
    if (backupSettings) {
        const merged = mergeMissingSettings(current, backupSettings);
        restoredSettings = {
            version: Math.min(current.version ?? 0, backupSettings.version ?? 0),
            state: {
                ...current.state,
                ...backupSettings.state,
                presets: merged.state.presets,
                personas: merged.state.personas,
                customModels: merged.state.customModels,
                customEngines: merged.state.customEngines,
                apiKeys: current.state.apiKeys ?? [],
            },
        };
    }
    return (count, localCopies) => {
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
        for (const [key, value] of Object.entries(localCopies)) {
            if (key.startsWith('nexusai_active_') && storage.getItem(key) === null)
                storage.setItem(key, value);
        }
    };
}

/** The existing database, or one created from the backup's layout; checked before writing. */
async function openRestoreTarget(version: number, stores: StoreMeta[]): Promise<IDBDatabase> {
    let db = await openExisting();
    if (!db) {
        db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, version);
            req.onupgradeneeded = () => {
                for (const store of stores) {
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
        for (const store of stores) {
            if (!db.objectStoreNames.contains(store.name))
                throw new Error(
                    `La base actuelle ne contient pas « ${store.name} ». Restauration interrompue avant écriture ; le fichier conserve ces données.`
                );
            const target = db.transaction(store.name, 'readonly').objectStore(store.name);
            if (JSON.stringify(target.keyPath) !== JSON.stringify(store.keyPath))
                throw new Error('Structure de base différente.');
        }
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

type RestoreEntry = { store: string; key: IDBValidKey; value: unknown };

/** Add the records this device lacks, in one transaction. Never overwrites. */
async function addMissing(db: IDBDatabase, entries: RestoreEntry[]): Promise<number> {
    if (!entries.length) return 0;
    const tx = db.transaction([...new Set(entries.map((entry) => entry.store))], 'readwrite');
    const done = completed(tx);
    let added = 0;
    for (const { store, key, value } of entries) {
        const target = tx.objectStore(store);
        const check = target.getKey(key);
        check.onsuccess = () => {
            if (check.result !== undefined) return;
            try {
                if (target.keyPath === null) target.add(value, key);
                else target.add(value);
                added++;
            } catch {
                tx.abort();
            }
        };
    }
    await done;
    return added;
}

/** Add missing DB records, then apply settings with a checkpoint. Never clear stores.
 * IndexedDB and localStorage cannot share a transaction; retries are idempotent if
 * the second phase fails, and the caller gets an explicit partial-restore error.
 */
export async function restoreGlobalBackup(backup: GlobalBackup, storage: Storage): Promise<number> {
    parseGlobalBackup(JSON.stringify(backup));
    const finish = prepareSettingsRestore(storage, backup.settings);
    let count = 0;
    if (backup.database?.stores.length) {
        const snapshot = backup.database;
        const db = await openRestoreTarget(snapshot.version, snapshot.stores);
        try {
            count = await addMissing(
                db,
                snapshot.stores.flatMap((store) =>
                    store.entries.map((entry) => ({
                        store: store.name,
                        key: unpackBackupValue(entry.key) as IDBValidKey,
                        value: unpackBackupValue(entry.value),
                    }))
                )
            );
        } finally {
            db.close();
        }
    }
    finish(count, backup.localStorage);
    return count;
}

/** True for a v2 backup file (gzip), false for a v1 `.json` one. */
export async function isGzipFile(file: Blob): Promise<boolean> {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return head[0] === 0x1f && head[1] === 0x8b;
}

/** The lines of a v2 file, decompressed and parsed one at a time. */
async function* backupLines(file: Blob): AsyncGenerator<Record<string, unknown>> {
    const reader = file
        .stream()
        .pipeThrough(new DecompressionStream('gzip'))
        .pipeThrough(new TextDecoderStream())
        .getReader();
    let lineNumber = 0;
    const parse = (text: string): Record<string, unknown> => {
        lineNumber++;
        try {
            const line = JSON.parse(text);
            if (line && typeof line === 'object' && !Array.isArray(line)) return line;
        } catch {
            /* reported below */
        }
        throw new Error(`Fichier de sauvegarde illisible (ligne ${lineNumber}).`);
    };
    let rest = '';
    try {
        for (;;) {
            let chunk: ReadableStreamReadResult<string>;
            try {
                chunk = await reader.read();
            } catch {
                throw new Error('Fichier de sauvegarde incomplet ou endommagé.');
            }
            if (chunk.done) break;
            rest += chunk.value;
            let newline: number;
            while ((newline = rest.indexOf('\n')) !== -1) {
                const text = rest.slice(0, newline);
                rest = rest.slice(newline + 1);
                if (text) yield parse(text);
            }
        }
        if (rest.trim()) yield parse(rest);
    } finally {
        reader.cancel().catch(() => {});
    }
}

export interface BackupFileSummary {
    createdAt: string;
    settings: SettingsEnvelope | null;
    localStorage: Record<string, string>;
    database: { version: number } | null;
    stores: StoreMeta[];
    counts: Record<string, number>;
    total: number;
}

/** Read the whole v2 file and validate every line. Writes nothing. */
export async function inspectGlobalBackupFile(
    file: Blob,
    onProgress?: (checked: number) => void
): Promise<BackupFileSummary> {
    let summary: BackupFileSummary | null = null;
    let current: StoreMeta | null = null;
    let ended = false;
    const names = new Set<string>();
    for await (const line of backupLines(file)) {
        if (ended) throw new Error('Fichier de sauvegarde illisible : données après la fin.');
        if (!summary) {
            const header = line as unknown as Partial<GlobalBackup>;
            checkHeader(header, 2);
            summary = {
                createdAt: String(header.createdAt),
                settings: header.settings ?? null,
                localStorage: header.localStorage!,
                database: (header.database as { version: number } | null) ?? null,
                stores: [],
                counts: {},
                total: 0,
            };
        } else if ('store' in line) {
            const meta = line.store as StoreMeta;
            if (!summary.database) throw new Error('Structure de base invalide.');
            checkStoreMeta(meta, names);
            summary.stores.push(meta);
            summary.counts[meta.name] = 0;
            current = meta;
        } else if ('s' in line) {
            if (!current || line.s !== current.name) throw new Error('Structure de base invalide.');
            checkEntry(current, line.k, line.v);
            summary.counts[current.name]++;
            summary.total++;
            if (summary.total % 250 === 0) onProgress?.(summary.total);
        } else if (line.end === true && line.records === summary.total) {
            ended = true;
        } else {
            throw new Error('Fichier de sauvegarde illisible.');
        }
    }
    if (!summary) throw new Error(NOT_A_BACKUP);
    if (!ended)
        throw new Error('Fichier de sauvegarde incomplet : sa fin manque. Rien n’a été restauré.');
    onProgress?.(summary.total);
    return summary;
}

const RESTORE_BATCH = 200;

/** Validate the whole v2 file, then add the missing records batch by batch. Never deletes. */
export async function restoreGlobalBackupFile(
    file: Blob,
    storage: Storage,
    onProgress?: BackupProgress
): Promise<number> {
    const summary = await inspectGlobalBackupFile(file);
    const finish = prepareSettingsRestore(storage, summary.settings);
    let count = 0;
    if (summary.database && summary.stores.length) {
        const db = await openRestoreTarget(summary.database.version, summary.stores);
        try {
            let batch: RestoreEntry[] = [];
            let seen = 0;
            for await (const line of backupLines(file)) {
                if (!('s' in line)) continue;
                batch.push({
                    store: line.s as string,
                    key: unpackBackupValue(line.k) as IDBValidKey,
                    value: unpackBackupValue(line.v),
                });
                if (batch.length === RESTORE_BATCH) {
                    count += await addMissing(db, batch);
                    seen += batch.length;
                    batch = [];
                    onProgress?.(seen, summary.total);
                }
            }
            count += await addMissing(db, batch);
            onProgress?.(summary.total, summary.total);
        } finally {
            db.close();
        }
    }
    finish(count, summary.localStorage);
    return count;
}
