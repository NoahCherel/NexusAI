import { describe, expect, it } from 'vitest';
import { packBackupValue } from '@/lib/backup-codec';
import type { GlobalBackup } from '@/lib/global-backup';
import {
    backupFileName,
    backupFingerprint,
    countConversations,
    gunzipText,
    gzipText,
    pickBackupsToDelete,
} from '@/lib/online-backup';

const store = (name: string, ids: string[]) => ({
    name,
    keyPath: 'id',
    autoIncrement: false,
    indexes: [],
    entries: ids.map((id) => ({ key: packBackupValue(id), value: packBackupValue({ id }) })),
});

const fixture: GlobalBackup = {
    format: 'nexusai-global-backup',
    version: 1,
    createdAt: '2026-11-23T10:00:00.000Z',
    origin: 'https://phone.local',
    apiKeys: 'reenter-on-restore',
    settings: null,
    localStorage: {},
    database: {
        version: 9,
        stores: [store('characters', ['c1']), store('conversations', ['v1', 'v2'])],
    },
};

const day = (d: string, h: string) => `${d}T${h}-00-00-000Z.json.gz`;

describe('online backup helpers', () => {
    it('round-trips text through gzip', async () => {
        const text = 'é'.repeat(2000) + '{"a":1}';
        expect(await gunzipText(await gzipText(text))).toBe(text);
    });

    it('fingerprints content, not the creation time', async () => {
        const a = { ...fixture, createdAt: '2026-01-01' };
        expect(await backupFingerprint(a)).toBe(
            await backupFingerprint({ ...a, createdAt: '2026-02-02' })
        );
        expect(await backupFingerprint(a)).not.toBe(await backupFingerprint({ ...a, origin: 'x' }));
    });

    it('counts conversations in the snapshot', () => {
        expect(countConversations(fixture)).toBe(2);
        expect(countConversations({ ...fixture, database: null })).toBe(0);
    });

    it('names files so they sort by time', () => {
        expect(backupFileName(new Date('2026-11-23T10:15:30.123Z'))).toBe(
            '2026-11-23T10-15-30-123Z.json.gz'
        );
    });

    it('keeps the newest 10, one per day for 30 days, and unknown files', () => {
        const today = Array.from({ length: 10 }, (_, i) =>
            day('2026-11-23', String(i).padStart(2, '0'))
        );
        const names = [
            ...today,
            day('2026-11-21', '08'),
            day('2026-11-21', '12'),
            day('2026-11-21', '20'),
            day('2026-10-25', '10'), // 29 days old, only one that day → kept
            day('2026-10-23', '10'), // 31 days old → deleted
            'notes.txt',
        ];
        expect(pickBackupsToDelete(names, new Date('2026-11-23T21:00:00Z')).sort()).toEqual(
            [day('2026-10-23', '10'), day('2026-11-21', '08'), day('2026-11-21', '12')].sort()
        );
    });
});
