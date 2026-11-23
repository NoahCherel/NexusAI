import { beforeEach, describe, expect, it, vi } from 'vitest';
import { packBackupValue } from '@/lib/backup-codec';
import type { GlobalBackup } from '@/lib/global-backup';
import { useNotificationStore } from '@/components/ui/api-notification';
import {
    listOnlineBackups,
    readOnlineBackupState,
    restoreOnlineBackup,
    runOnlineBackup,
} from '@/lib/online-backup';

const h = vi.hoisted(() => ({
    files: new Map<string, Blob>(),
    session: null as { user: { id: string } } | null,
    uploadError: false,
    fixture: null as unknown as GlobalBackup,
    restore: vi.fn(async () => 7),
}));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        auth: { getSession: async () => ({ data: { session: h.session }, error: null }) },
        storage: {
            from: () => ({
                upload: async (path: string, blob: Blob) => {
                    if (h.uploadError) return { data: null, error: { message: 'network' } };
                    h.files.set(path, blob);
                    return { data: { path }, error: null };
                },
                list: async (prefix: string) => ({
                    data: [...h.files.entries()]
                        .filter(([path]) => path.startsWith(`${prefix}/`))
                        .map(([path, blob]) => ({
                            name: path.slice(prefix.length + 1),
                            metadata: { size: blob.size },
                        })),
                    error: null,
                }),
                download: async (path: string) => {
                    const blob = h.files.get(path);
                    return blob
                        ? { data: blob, error: null }
                        : { data: null, error: { message: 'not found' } };
                },
                remove: async (paths: string[]) => {
                    paths.forEach((path) => h.files.delete(path));
                    return { data: [], error: null };
                },
            }),
        },
    }),
}));

vi.mock('@/lib/global-backup', () => ({
    createGlobalBackup: async () => h.fixture,
    parseGlobalBackup: (raw: string) => JSON.parse(raw),
    restoreGlobalBackup: h.restore,
}));

const conversations = (ids: string[]) => ({
    name: 'conversations',
    keyPath: 'id',
    autoIncrement: false,
    indexes: [],
    entries: ids.map((id) => ({ key: packBackupValue(id), value: packBackupValue({ id }) })),
});
const backupWith = (ids: string[]): GlobalBackup => ({
    format: 'nexusai-global-backup',
    version: 1,
    createdAt: '2026-11-23T10:00:00.000Z',
    origin: 'https://phone.local',
    apiKeys: 'reenter-on-restore',
    settings: null,
    localStorage: { nexusai_active_char: 'c1' },
    database: { version: 9, stores: [conversations(ids)] },
});

let stored: Map<string, string>;
function storage(): Storage {
    stored = new Map();
    return {
        get length() {
            return stored.size;
        },
        key: (i) => [...stored.keys()][i] ?? null,
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => {
            stored.set(key, value);
        },
        removeItem: (key) => {
            stored.delete(key);
        },
        clear: () => stored.clear(),
    };
}

beforeEach(() => {
    h.files.clear();
    h.session = { user: { id: 'u1' } };
    h.uploadError = false;
    h.fixture = backupWith(['v1', 'v2']);
    h.restore.mockClear();
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('location', { origin: 'https://phone.local' });
});

describe('online backup sync', () => {
    it('uploads once, then reports unchanged', async () => {
        expect((await runOnlineBackup()).status).toBe('uploaded');
        expect((await runOnlineBackup()).status).toBe('unchanged');
        expect(h.files.size).toBe(1);
    });

    it('keeps its own state out of what gets backed up', async () => {
        await runOnlineBackup();
        expect(stored.size).toBeGreaterThan(0);
        expect([...stored.keys()].filter((key) => key.startsWith('nexusai'))).toEqual([]);
    });

    it('never uploads from a device with no conversations', async () => {
        h.fixture = backupWith([]);
        expect((await runOnlineBackup({ force: true })).status).toBe('empty');
        expect(h.files.size).toBe(0);
    });

    it('does nothing when signed out', async () => {
        h.session = null;
        expect((await runOnlineBackup()).status).toBe('signed-out');
        expect(h.files.size).toBe(0);
    });

    it('records a failed upload and notifies once per page load', async () => {
        h.uploadError = true;
        expect((await runOnlineBackup()).status).toBe('error');
        expect((await runOnlineBackup()).status).toBe('error');
        expect(readOnlineBackupState().lastError).toBe('network');
        expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it('prunes history after an upload', async () => {
        for (let i = 0; i < 12; i++)
            h.files.set(
                `u1/2026-11-23T0${i % 10}-0${Math.floor(i / 10)}-00-000Z.json.gz`,
                new Blob(['x'])
            );
        await runOnlineBackup();
        expect(h.files.size).toBe(10);
    });

    it('restores the chosen backup through the existing restore', async () => {
        await runOnlineBackup();
        const [{ name }] = await listOnlineBackups();
        expect(await restoreOnlineBackup(name)).toBe(7);
        expect(h.restore).toHaveBeenCalledWith(h.fixture, localStorage);
    });
});
