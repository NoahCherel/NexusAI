'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    createGlobalBackup,
    parseGlobalBackup,
    restoreGlobalBackup,
    type GlobalBackup,
} from '@/lib/global-backup';
import { COLLECTIONS, type SettingsEnvelope } from '@/lib/settings-storage';

export function GlobalBackupControls({
    getLiveSettings,
    allowRestore = false,
}: {
    getLiveSettings?: () => SettingsEnvelope;
    allowRestore?: boolean;
}) {
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    const [pending, setPending] = useState<GlobalBackup | null>(null);
    const [prepared, setPrepared] = useState<{ url: string; name: string } | null>(null);

    useEffect(() => {
        if (!prepared) return;
        return () => {
            setTimeout(() => URL.revokeObjectURL(prepared.url), 60_000);
        };
    }, [prepared]);

    async function download() {
        setBusy(true);
        setNote('Préparation de la sauvegarde…');
        try {
            const backup = await createGlobalBackup(
                localStorage,
                location.origin,
                getLiveSettings?.()
            );
            const file = new Blob([JSON.stringify(backup)], { type: 'application/json' });
            const url = URL.createObjectURL(file);
            const name = `nexusai-sauvegarde-globale-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            setPrepared({ url, name });
            const link = document.createElement('a');
            link.href = url;
            link.download = name;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setNote(
                'Fichier prêt. Si le téléchargement ne démarre pas, utilisez « Enregistrer le fichier » ci-dessous. Gardez une copie en dehors du navigateur.'
            );
        } catch (error) {
            setNote(
                `Sauvegarde impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}`
            );
        } finally {
            setBusy(false);
        }
    }

    async function restore() {
        if (!pending) return;
        setBusy(true);
        try {
            const count = await restoreGlobalBackup(pending, localStorage);
            setPending(null);
            setNote(
                `${count} enregistrement(s) ajouté(s), réglages restaurés si présents dans le fichier. Rechargez l’application après avoir exporté les modifications non enregistrées des autres onglets.`
            );
        } catch (error) {
            setNote(
                `Restauration interrompue : ${error instanceof Error ? error.message : 'erreur inconnue'}`
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-2 text-left">
            <div className="flex flex-wrap items-center gap-3">
                <Button
                    onClick={() => void download()}
                    disabled={busy}
                    variant="outline"
                    className="gap-2"
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
            {prepared && (
                <a
                    className="inline-block text-sm underline"
                    href={prepared.url}
                    download={prepared.name}
                >
                    Enregistrer le fichier
                </a>
            )}
            {allowRestore && (
                <label className="block space-y-2 text-sm">
                    <span>Restaurer un fichier de sauvegarde globale</span>
                    <input
                        type="file"
                        accept=".json,application/json"
                        disabled={busy}
                        className="block w-full"
                        onChange={async (event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (!file) return;
                            setPending(null);
                            setBusy(true);
                            try {
                                setPending(parseGlobalBackup(await file.text()));
                                setNote('Fichier lu. Aucune donnée n’a encore été écrite.');
                            } catch (error) {
                                setNote(
                                    error instanceof Error ? error.message : 'Fichier illisible.'
                                );
                            } finally {
                                setBusy(false);
                            }
                        }}
                    />
                </label>
            )}
            {pending && (
                <div className="rounded-lg border border-amber-400/40 p-3 text-sm space-y-2">
                    <p>Sauvegarde du {new Date(pending.createdAt).toLocaleString()}.</p>
                    <p>
                        {pending.database?.stores
                            .map((store) => `${store.entries.length} ${store.name}`)
                            .join(' · ') || 'Aucune base de conversations.'}
                    </p>
                    <p>
                        {pending.settings
                            ? COLLECTIONS.map(
                                  (key) =>
                                      `${(pending.settings!.state[key] as unknown[] | undefined)?.length ?? 0} ${key}`
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
