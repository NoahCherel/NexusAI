/**
 * Online backup: the same snapshot as « Télécharger une sauvegarde globale », gzipped and
 * uploaded to Supabase Storage at `backups/<user id>/<timestamp>.json.gz`.
 */

import { notifyError } from '@/components/ui/api-notification';
import {
    createGlobalBackup,
    parseGlobalBackup,
    restoreGlobalBackup,
    type GlobalBackup,
} from '@/lib/global-backup';
import type { SettingsEnvelope } from '@/lib/settings-storage';
import { getSupabase } from '@/lib/supabase';

const BUCKET = 'backups';
const BACKUP_NAME_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json\.gz$/;
const KEEP_NEWEST = 10;
const KEEP_DAILY_FOR_MS = 30 * 86_400_000;
const MAX_BACKUP_BYTES = 52_428_800; // Supabase free tier, per file
// Must NOT start with `nexusai`: global backups copy every `nexusai*` key, so a prefixed key
// would make each snapshot differ from the last one and upload forever.
const STATE_KEY = 'online-backup-state';

export type OnlineBackupResult =
    | { status: 'uploaded'; size: number; at: string }
    | { status: 'unchanged' | 'empty' | 'signed-out' | 'not-configured' }
    | { status: 'error'; message: string };

export interface OnlineBackupState {
    fingerprint?: string;
    lastUploadAt?: string;
    lastSize?: number;
    lastError?: string;
}

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
    const sorted = names
        .filter((name) => BACKUP_NAME_RE.test(name))
        .sort()
        .reverse();
    const keptDays = new Set<string>();
    return sorted.filter((name, index) => {
        const day = name.slice(0, 10);
        const newestOfDay = !keptDays.has(day);
        keptDays.add(day);
        return index >= KEEP_NEWEST && !(newestOfDay && day >= cutoffDay);
    });
}

export function readOnlineBackupState(): OnlineBackupState {
    try {
        return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as OnlineBackupState;
    } catch {
        return {};
    }
}

function writeOnlineBackupState(state: OnlineBackupState): void {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

type Bucket = ReturnType<NonNullable<ReturnType<typeof getSupabase>>['storage']['from']>;

/** The signed-in user's id and their storage folder handle, or a status explaining why not. */
async function openFolder(): Promise<
    { userId: string; bucket: Bucket } | { status: 'not-configured' | 'signed-out' }
> {
    const client = getSupabase();
    if (!client) return { status: 'not-configured' as const };
    const { data, error } = await client.auth.getSession();
    if (error) throw new Error(error.message);
    const userId = data.session?.user.id;
    if (!userId) return { status: 'signed-out' as const };
    return { userId, bucket: client.storage.from(BUCKET) };
}

let errorNotified = false;
let running: Promise<OnlineBackupResult> | null = null;

/** Upload the current snapshot when it changed. Concurrent calls share one run. */
export function runOnlineBackup(
    options: { force?: boolean; getLiveSettings?: () => SettingsEnvelope } = {}
): Promise<OnlineBackupResult> {
    running ??= backUp(options).finally(() => {
        running = null;
    });
    return running;
}

async function backUp(options: {
    force?: boolean;
    getLiveSettings?: () => SettingsEnvelope;
}): Promise<OnlineBackupResult> {
    const state = readOnlineBackupState();
    try {
        const folder = await openFolder();
        if ('status' in folder) return folder;
        const backup = await createGlobalBackup(
            localStorage,
            location.origin,
            options.getLiveSettings?.()
        );
        // A wiped device must never push an empty snapshot over the good ones.
        if (countConversations(backup) === 0) return { status: 'empty' };
        const fingerprint = await backupFingerprint(backup);
        if (!options.force && fingerprint === state.fingerprint) return { status: 'unchanged' };
        const blob = await gzipText(JSON.stringify(backup));
        if (blob.size > MAX_BACKUP_BYTES) {
            throw new Error('Sauvegarde trop volumineuse pour l’offre gratuite (50 Mo).');
        }
        const at = new Date();
        const { error } = await folder.bucket.upload(
            `${folder.userId}/${backupFileName(at)}`,
            blob,
            { contentType: 'application/gzip', upsert: false }
        );
        if (error) throw new Error(error.message);
        writeOnlineBackupState({
            fingerprint,
            lastUploadAt: at.toISOString(),
            lastSize: blob.size,
        });
        await prune(folder.bucket, folder.userId, at);
        return { status: 'uploaded', size: blob.size, at: at.toISOString() };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeOnlineBackupState({ ...state, lastError: message });
        if (!errorNotified) {
            errorNotified = true;
            notifyError('Sauvegarde en ligne impossible', message);
        }
        return { status: 'error', message };
    }
}

/** History pruning never fails the upload that preceded it; the next upload retries it. */
async function prune(bucket: Bucket, userId: string, now: Date): Promise<void> {
    try {
        const { data, error } = await bucket.list(userId, { limit: 100 });
        if (error) throw new Error(error.message);
        const doomed = pickBackupsToDelete(
            (data ?? []).map((file) => file.name),
            now
        );
        if (doomed.length === 0) return;
        const removed = await bucket.remove(doomed.map((name) => `${userId}/${name}`));
        if (removed.error) throw new Error(removed.error.message);
    } catch (error) {
        console.warn('[OnlineBackup] history pruning failed:', error);
    }
}

/** Online backups of the signed-in user, newest first. */
export async function listOnlineBackups(): Promise<{ name: string; size: number }[]> {
    const folder = await openFolder();
    if ('status' in folder) return [];
    const { data, error } = await folder.bucket.list(folder.userId, { limit: 100 });
    if (error) throw new Error(error.message);
    return (data ?? [])
        .filter((file) => BACKUP_NAME_RE.test(file.name))
        .map((file) => ({ name: file.name, size: Number(file.metadata?.size ?? 0) }))
        .sort((a, b) => b.name.localeCompare(a.name));
}

/** Download one online backup and add what this device lacks (never deletes). */
export async function restoreOnlineBackup(name: string): Promise<number> {
    const folder = await openFolder();
    if ('status' in folder) throw new Error('Connectez-vous pour restaurer une sauvegarde.');
    const { data, error } = await folder.bucket.download(`${folder.userId}/${name}`);
    if (error || !data) throw new Error(error?.message ?? 'Téléchargement impossible.');
    const backup = parseGlobalBackup(await gunzipText(data));
    return restoreGlobalBackup(backup, localStorage);
}
