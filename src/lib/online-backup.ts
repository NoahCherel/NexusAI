/**
 * Online backup: the same snapshot as « Télécharger une sauvegarde globale », gzipped and
 * uploaded to Supabase Storage at `backups/<user id>/<timestamp>.json.gz`.
 */

import type { GlobalBackup } from '@/lib/global-backup';

const BACKUP_NAME_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json\.gz$/;
const KEEP_NEWEST = 10;
const KEEP_DAILY_FOR_MS = 30 * 86_400_000;

export async function gzipText(text: string): Promise<Blob> {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).blob();
}

export async function gunzipText(blob: Blob): Promise<string> {
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
}

/** Same content → same fingerprint, whenever the snapshot was taken. */
export async function backupFingerprint(backup: GlobalBackup): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...backup, createdAt: '' }));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function countConversations(backup: GlobalBackup): number {
    return backup.database?.stores.find((s) => s.name === 'conversations')?.entries.length ?? 0;
}

export function backupFileName(date: Date): string {
    return `${date.toISOString().replace(/[:.]/g, '-')}.json.gz`;
}

/** History: the newest 10, plus the newest of each day for 30 days. Unknown names are kept. */
export function pickBackupsToDelete(names: string[], now: Date): string[] {
    const cutoffDay = new Date(now.getTime() - KEEP_DAILY_FOR_MS).toISOString().slice(0, 10);
    const sorted = names.filter((name) => BACKUP_NAME_RE.test(name)).sort().reverse();
    const keptDays = new Set<string>();
    return sorted.filter((name, index) => {
        const day = name.slice(0, 10);
        const newestOfDay = !keptDays.has(day);
        keptDays.add(day);
        return index >= KEEP_NEWEST && !(newestOfDay && day >= cutoffDay);
    });
}
