'use client';

import { useSyncExternalStore } from 'react';
import {
    getSettingsStorageIssue,
    subscribeSettingsStorageIssue,
    SETTINGS_VERSION,
} from '@/lib/settings-storage';

export function downloadSettingsFile(raw: string, label: string) {
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `nexusai-reglages-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function SettingsStorageWarning() {
    const issue = useSyncExternalStore(
        subscribeSettingsStorageIssue,
        getSettingsStorageIssue,
        () => null
    );
    if (!issue) return null;

    return (
        <aside
            role="alert"
            className="fixed bottom-3 left-3 right-3 z-[100] rounded-xl border border-amber-400 bg-background p-4 text-sm shadow-xl"
        >
            <p className="font-semibold text-amber-400">
                Attention : vos modifications de réglages ne sont pas enregistrées.
            </p>
            <p className="mt-1">{issue}</p>
            <p className="mt-1">
                La copie sur disque est conservée. Exportez les réglages de cet onglet avant de le
                fermer.
            </p>
            <div className="mt-3 flex flex-wrap gap-4">
                <button
                    className="underline"
                    onClick={async () => {
                        const { useSettingsStore } = await import('@/stores/settings-store');
                        downloadSettingsFile(
                            JSON.stringify(
                                { state: useSettingsStore.getState(), version: SETTINGS_VERSION },
                                null,
                                2
                            ),
                            'cet-onglet'
                        );
                    }}
                >
                    Exporter les réglages de cet onglet
                </button>
                <a className="underline" href="/rescue" target="_blank" rel="noreferrer">
                    Ouvrir les sauvegardes
                </a>
            </div>
        </aside>
    );
}
