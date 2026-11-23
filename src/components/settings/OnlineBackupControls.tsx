'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CloudUpload, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
    listOnlineBackups,
    readOnlineBackupState,
    restoreOnlineBackup,
    runOnlineBackup,
    type OnlineBackupState,
} from '@/lib/online-backup';
import type { SettingsEnvelope } from '@/lib/settings-storage';
import { getSupabase } from '@/lib/supabase';

/** `2026-11-23T10-15-30-123Z.json.gz` → the moment it was taken. */
function dateFromName(name: string): Date {
    return new Date(
        `${name.slice(0, 10)}T${name.slice(11, 19).replaceAll('-', ':')}.${name.slice(20, 23)}Z`
    );
}

function formatSize(bytes = 0): string {
    return bytes < 1024 * 1024
        ? `${Math.max(1, Math.round(bytes / 1024))} Ko`
        : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export function OnlineBackupControls({
    getLiveSettings,
}: {
    getLiveSettings?: () => SettingsEnvelope;
}) {
    const client = getSupabase();
    const [userEmail, setUserEmail] = useState<string | null>(null);
    const [emailInput, setEmailInput] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    const [last, setLast] = useState<OnlineBackupState>({});
    const [backups, setBackups] = useState<{ name: string; size: number }[]>([]);
    const [emptyDevice, setEmptyDevice] = useState(false);
    const [restoreTarget, setRestoreTarget] = useState<string | null>(null);

    useEffect(() => {
        if (!client) return;
        void client.auth
            .getSession()
            .then(({ data }) => setUserEmail(data.session?.user.email ?? null));
        const { data } = client.auth.onAuthStateChange((_event, session) =>
            setUserEmail(session?.user.email ?? null)
        );
        return () => data.subscription.unsubscribe();
    }, [client]);

    const refresh = useCallback(
        async (force: boolean) => {
            setBusy(true);
            const result = await runOnlineBackup({ force, getLiveSettings });
            setBackups(await listOnlineBackups().catch(() => []));
            setLast(readOnlineBackupState());
            setEmptyDevice(result.status === 'empty');
            setNote(
                result.status === 'uploaded'
                    ? 'Sauvegarde envoyée.'
                    : result.status === 'unchanged'
                      ? 'Rien n’a changé depuis la dernière sauvegarde.'
                      : ''
            );
            setBusy(false);
        },
        [getLiveSettings]
    );

    // Right after sign-in, and on opening while signed in: back up, or offer a restore.
    useEffect(() => {
        if (userEmail) void refresh(false);
    }, [userEmail, refresh]);

    if (!client) {
        return (
            <p className="text-sm text-muted-foreground">
                Sauvegarde en ligne non configurée (variables Supabase absentes).
            </p>
        );
    }

    async function signIn(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setNote('');
        const { error } = await client!.auth.signInWithPassword({
            email: emailInput.trim(),
            password,
        });
        setBusy(false);
        if (error) setNote(`Connexion impossible : ${error.message}`);
        else setPassword('');
    }

    async function signOut() {
        await client!.auth.signOut();
        setBackups([]);
        setEmptyDevice(false);
        setNote('');
    }

    async function restore(name: string) {
        setBusy(true);
        try {
            await restoreOnlineBackup(name);
            setEmptyDevice(false);
            setNote('Restauration terminée : rechargez l’application.');
        } catch (error) {
            setNote(
                `Restauration interrompue : ${error instanceof Error ? error.message : 'erreur inconnue'}`
            );
        } finally {
            setBusy(false);
        }
    }

    if (!userEmail) {
        return (
            <form onSubmit={(event) => void signIn(event)} className="space-y-3 text-left">
                <label className="block space-y-1 text-sm">
                    <span>E-mail</span>
                    <Input
                        type="email"
                        autoComplete="email"
                        required
                        value={emailInput}
                        onChange={(event) => setEmailInput(event.target.value)}
                    />
                </label>
                <label className="block space-y-1 text-sm">
                    <span>Mot de passe</span>
                    <Input
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                    />
                </label>
                <Button type="submit" disabled={busy} className="pointer-coarse:h-10">
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    Se connecter
                </Button>
                {note && <p className="text-sm text-amber-400">{note}</p>}
                <p className="text-xs text-muted-foreground">
                    Une fois connecté, l’application envoie une copie de vos données toutes les 10
                    minutes quand quelque chose a changé. Les clés API ne sont jamais envoyées en
                    clair.
                </p>
            </form>
        );
    }

    return (
        <div className="space-y-3 text-left">
            <p className="text-sm">
                Connecté : <span className="font-medium">{userEmail}</span>
            </p>
            <p className="text-sm text-muted-foreground">
                {last.lastUploadAt
                    ? `Dernière sauvegarde : ${new Date(last.lastUploadAt).toLocaleString()} (${formatSize(last.lastSize)})`
                    : 'Aucune sauvegarde en ligne depuis cet appareil.'}
            </p>
            {last.lastError && (
                <p className="text-sm text-amber-400">Dernier échec : {last.lastError}</p>
            )}
            {emptyDevice && backups.length > 0 && (
                <div className="rounded-lg border border-amber-400/40 p-3 text-sm space-y-2">
                    <p>
                        Cet appareil n’a aucune conversation. Restaurer la sauvegarde en ligne la
                        plus récente ?
                    </p>
                    <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => setRestoreTarget(backups[0].name)}
                        className="pointer-coarse:h-10"
                    >
                        Restaurer
                    </Button>
                </div>
            )}
            <div className="flex flex-wrap gap-3">
                <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void refresh(true)}
                    className="gap-2 pointer-coarse:h-10"
                >
                    {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <CloudUpload className="h-4 w-4" />
                    )}
                    Sauvegarder maintenant
                </Button>
                <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void signOut()}
                    className="pointer-coarse:h-10"
                >
                    Se déconnecter
                </Button>
            </div>
            {note && <p className="text-sm text-amber-400">{note}</p>}
            {backups.length > 0 ? (
                <ul className="divide-y divide-border/50 rounded-lg border border-border/50 text-sm">
                    {backups.map((backup) => (
                        <li
                            key={backup.name}
                            className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                            <span>
                                {dateFromName(backup.name).toLocaleString()}
                                <span className="text-muted-foreground">
                                    {' '}
                                    · {formatSize(backup.size)}
                                </span>
                            </span>
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => setRestoreTarget(backup.name)}
                                className="pointer-coarse:h-10"
                            >
                                Restaurer
                            </Button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-muted-foreground">Aucune sauvegarde en ligne.</p>
            )}
            <ConfirmDialog
                open={!!restoreTarget}
                onOpenChange={(open) => {
                    if (!open) setRestoreTarget(null);
                }}
                title="Restaurer cette sauvegarde ?"
                description="Les éléments absents de cet appareil seront ajoutés ; rien n’est supprimé."
                confirmLabel="Restaurer"
                onConfirm={() => {
                    if (restoreTarget) void restore(restoreTarget);
                }}
            />
        </div>
    );
}
