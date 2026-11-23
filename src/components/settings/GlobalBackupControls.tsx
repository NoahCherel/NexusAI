'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Download, Loader2, Share } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    createGlobalBackupFile,
    inspectGlobalBackupFile,
    isGzipFile,
    parseGlobalBackup,
    restoreGlobalBackup,
    restoreGlobalBackupFile,
    type BackupFileSummary,
    type GlobalBackup,
} from '@/lib/global-backup';
import { COLLECTIONS, type SettingsEnvelope } from '@/lib/settings-storage';
import { keepScreenOn } from '@/lib/wake-lock';

const LAST_BACKUP_KEY = 'nexusai-last-global-backup';
const STAY_AWAKE = 'gardez l’app ouverte et l’écran allumé';

// The last saved backup lives in localStorage: read it as an external store so the server
// render (no localStorage) and the device render never disagree.
const lastBackupListeners = new Set<() => void>();
function subscribeLastBackup(listener: () => void) {
    lastBackupListeners.add(listener);
    return () => {
        lastBackupListeners.delete(listener);
    };
}
function readLastBackupRaw(): string | null {
    try {
        return localStorage.getItem(LAST_BACKUP_KEY);
    } catch {
        return null;
    }
}

type Pending =
    | { kind: 'v1'; backup: GlobalBackup }
    | { kind: 'v2'; file: File; summary: BackupFileSummary };

function formatSize(bytes: number): string {
    return bytes < 1024 * 1024
        ? `${Math.max(1, Math.round(bytes / 1024))} Ko`
        : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function parseLastBackup(raw: string | null): { at: string; size: number } | null {
    try {
        return JSON.parse(raw ?? 'null');
    } catch {
        return null;
    }
}

export function GlobalBackupControls({
    getLiveSettings,
    allowRestore = false,
}: {
    getLiveSettings?: () => SettingsEnvelope;
    allowRestore?: boolean;
}) {
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    const [pending, setPending] = useState<Pending | null>(null);
    const [prepared, setPrepared] = useState<{ file: File; url: string } | null>(null);
    const last = parseLastBackup(
        useSyncExternalStore(subscribeLastBackup, readLastBackupRaw, () => null)
    );

    useEffect(() => {
        if (!prepared) return;
        return () => {
            setTimeout(() => URL.revokeObjectURL(prepared.url), 60_000);
        };
    }, [prepared]);

    async function prepare() {
        setBusy(true);
        setPrepared(null);
        setNote(`Préparation de la sauvegarde… ${STAY_AWAKE}.`);
        const release = await keepScreenOn();
        try {
            const blob = await createGlobalBackupFile(
                localStorage,
                location.origin,
                getLiveSettings?.(),
                (done, total) => setNote(`Lecture… ${done} / ${total} éléments — ${STAY_AWAKE}.`)
            );
            const name = `nexusai-sauvegarde-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;
            const file = new File([blob], name, { type: 'application/gzip' });
            setPrepared({ file, url: URL.createObjectURL(file) });
            setNote(
                `Fichier prêt (${formatSize(file.size)}). Appuyez sur « Enregistrer le fichier » et gardez-le en dehors du téléphone (Fichiers → iCloud Drive).`
            );
        } catch (error) {
            setNote(
                `Sauvegarde impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}`
            );
        } finally {
            release();
            setBusy(false);
        }
    }

    function markSaved(file: File) {
        try {
            localStorage.setItem(
                LAST_BACKUP_KEY,
                JSON.stringify({ at: new Date().toISOString(), size: file.size })
            );
        } catch {
            /* the backup itself is saved; only the reminder is lost */
        }
        lastBackupListeners.forEach((listener) => listener());
    }

    // Runs straight from the tap: the share sheet refuses to open after a long await.
    async function save() {
        if (!prepared) return;
        const files = [prepared.file];
        if (navigator.canShare?.({ files })) {
            try {
                await navigator.share({ files, title: 'Sauvegarde NexusAI' });
                markSaved(prepared.file);
                setNote('Sauvegarde enregistrée.');
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') return;
                setNote(
                    `Partage impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}`
                );
            }
            return;
        }
        const link = document.createElement('a');
        link.href = prepared.url;
        link.download = prepared.file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // No proof the download landed, so no "last backup" date here.
        setNote(
            'Téléchargement lancé : vérifiez que le fichier est bien arrivé, puis gardez-en une copie en dehors du navigateur.'
        );
    }

    async function choose(file: File) {
        setPending(null);
        setBusy(true);
        const release = await keepScreenOn();
        try {
            if (await isGzipFile(file)) {
                const summary = await inspectGlobalBackupFile(file, (checked) =>
                    setNote(`Vérification… ${checked} éléments — ${STAY_AWAKE}.`)
                );
                setPending({ kind: 'v2', file, summary });
            } else {
                setPending({ kind: 'v1', backup: parseGlobalBackup(await file.text()) });
            }
            setNote('Fichier vérifié. Aucune donnée n’a encore été écrite.');
        } catch (error) {
            setNote(error instanceof Error ? error.message : 'Fichier illisible.');
        } finally {
            release();
            setBusy(false);
        }
    }

    async function restore() {
        if (!pending) return;
        setBusy(true);
        const release = await keepScreenOn();
        try {
            const count =
                pending.kind === 'v2'
                    ? await restoreGlobalBackupFile(pending.file, localStorage, (done, total) =>
                          setNote(`Restauration… ${done} / ${total} éléments — ${STAY_AWAKE}.`)
                      )
                    : await restoreGlobalBackup(pending.backup, localStorage);
            setPending(null);
            setNote(
                `${count} enregistrement(s) ajouté(s), réglages restaurés si présents dans le fichier. Rechargez l’application après avoir exporté les modifications non enregistrées des autres onglets.`
            );
        } catch (error) {
            setNote(
                `Restauration interrompue : ${error instanceof Error ? error.message : 'erreur inconnue'}`
            );
        } finally {
            release();
            setBusy(false);
        }
    }

    const info = pending
        ? pending.kind === 'v2'
            ? {
                  createdAt: pending.summary.createdAt,
                  counts: Object.entries(pending.summary.counts),
                  hasDatabase: !!pending.summary.database,
                  settings: pending.summary.settings,
              }
            : {
                  createdAt: pending.backup.createdAt,
                  counts: (pending.backup.database?.stores ?? []).map(
                      (store) => [store.name, store.entries.length] as const
                  ),
                  hasDatabase: !!pending.backup.database,
                  settings: pending.backup.settings,
              }
        : null;

    return (
        <div className="space-y-2 text-left">
            <div className="flex flex-wrap items-center gap-3">
                <Button
                    onClick={() => void prepare()}
                    disabled={busy}
                    variant="outline"
                    className="gap-2 pointer-coarse:h-10"
                >
                    {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Download className="h-4 w-4" />
                    )}
                    {busy ? 'Opération en cours…' : 'Télécharger une sauvegarde globale'}
                </Button>
                {!allowRestore && (
                    <a
                        href="/rescue"
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs underline"
                    >
                        Restaurer une sauvegarde
                    </a>
                )}
            </div>
            <p className="text-xs text-muted-foreground">
                Presets, personas, modèles, personnages et avatars enregistrés, conversations,
                lorebooks, mémoires et réglages. Les clés API devront être ressaisies sur un autre
                appareil.
            </p>
            <p className="text-xs text-muted-foreground">
                {last
                    ? `Dernière sauvegarde enregistrée : ${new Date(last.at).toLocaleString()} (${formatSize(last.size)})`
                    : 'Aucune sauvegarde enregistrée depuis cet appareil.'}
            </p>
            {prepared && (
                <Button
                    onClick={() => void save()}
                    disabled={busy}
                    className="gap-2 pointer-coarse:h-10"
                >
                    <Share className="h-4 w-4" />
                    Enregistrer le fichier ({formatSize(prepared.file.size)})
                </Button>
            )}
            {allowRestore && (
                <label className="block space-y-2 text-sm">
                    <span>Restaurer un fichier de sauvegarde globale</span>
                    <input
                        type="file"
                        accept=".gz,.json,application/gzip,application/json"
                        disabled={busy}
                        className="block w-full"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file) void choose(file);
                        }}
                    />
                </label>
            )}
            {info && (
                <div className="rounded-lg border border-amber-400/40 p-3 text-sm space-y-2">
                    <p>Sauvegarde du {new Date(info.createdAt).toLocaleString()}.</p>
                    <p>
                        {info.hasDatabase
                            ? info.counts.map(([name, count]) => `${count} ${name}`).join(' · ')
                            : 'Aucune base de conversations.'}
                    </p>
                    <p>
                        {info.settings
                            ? COLLECTIONS.map(
                                  (key) =>
                                      `${(info.settings!.state[key] as unknown[] | undefined)?.length ?? 0} ${key}`
                              ).join(' · ')
                            : 'Réglages illisibles ou absents : seules les données de la base seront restaurées.'}
                    </p>
                    <p>
                        Les éléments déjà présents sont conservés ; les éléments manquants sont
                        ajoutés. Les préférences du fichier sont réappliquées, avec vos clés API
                        actuelles. Téléchargez d’abord une sauvegarde de cet appareil.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>
                            Annuler
                        </Button>
                        <Button disabled={busy} onClick={() => void restore()}>
                            Restaurer cette sauvegarde
                        </Button>
                    </div>
                </div>
            )}
            {note && (
                <p role="status" className="text-xs break-words">
                    {note}
                </p>
            )}
        </div>
    );
}
