'use client';

import { useEffect, useState } from 'react';
import {
    COLLECTIONS,
    createSafeSettingsStorage,
    LEGACY_SETTINGS_KEY,
    mergeMissingSettings,
    parseSettings,
    readSettingsHistory,
    SETTINGS_KEY,
    type SettingsEnvelope,
} from '@/lib/settings-storage';
import { downloadSettingsFile } from './SettingsStorageWarning';

const labels = {
    presets: 'presets',
    personas: 'personas',
    customModels: 'modèles ajoutés',
    customEngines: 'moteurs personnalisés',
};
const counts = (value: SettingsEnvelope) =>
    COLLECTIONS.map(
        (key) => `${(value.state[key] as unknown[] | undefined)?.length ?? 0} ${labels[key]}`
    ).join(' · ');

// Deliberately never imports the settings store: inspecting rescue must not hydrate,
// migrate, seed defaults, or write anything to the user's storage.
export function SettingsRescue() {
    const [copies, setCopies] = useState<{ label: string; raw: string }[]>([]);
    const [note, setNote] = useState('');
    const [pending, setPending] = useState<SettingsEnvelope | null>(null);
    const button = 'rounded-lg border border-white/20 px-3 py-2 text-sm';

    function scan() {
        const found: { label: string; raw: string }[] = [];
        try {
            for (const [key, label] of [
                [SETTINGS_KEY, 'Réglages actuels protégés'],
                [LEGACY_SETTINGS_KEY, 'Copie de l’ancienne application'],
            ]) {
                const raw = localStorage.getItem(key);
                if (raw !== null) found.push({ label, raw });
            }
            for (const [index, checkpoint] of readSettingsHistory(localStorage).entries()) {
                found.push({
                    label: `${index === 0 ? 'Première copie de sécurité' : 'Copie précédente'} — ${new Date(checkpoint.savedAt).toLocaleString()}`,
                    raw: checkpoint.raw,
                });
            }
        } catch {
            setNote('Lecture partielle ou impossible. Les copies lisibles restent exportables.');
        }
        setCopies(found);
    }

    useEffect(() => {
        scan();
    }, []);

    function stage(raw: string) {
        setPending(null);
        try {
            const parsed = parseSettings(raw);
            // Files intended for other backup/import flows must not appear restorable.
            if (!COLLECTIONS.some((key) => Array.isArray(parsed.state[key]))) {
                throw new Error(
                    'Ce fichier ne contient pas de presets, personas, modèles ou moteurs.'
                );
            }
            setPending(parsed);
            setNote('Vérifiez le contenu ci-dessous avant de restaurer.');
        } catch (error) {
            setNote(error instanceof Error ? error.message : 'Fichier illisible.');
        }
    }

    function restore() {
        if (!pending) return;
        try {
            const storage = createSafeSettingsStorage(
                () => localStorage,
                (message) => {
                    throw new Error(message);
                },
                { explicitRestore: true }
            );
            const loaded = storage.getItem(SETTINGS_KEY) as string | null;
            const current =
                loaded === null
                    ? { state: {}, version: pending.version ?? 0 }
                    : parseSettings(loaded);
            const merged = mergeMissingSettings(current, pending);
            // Keep the source schema version: the application will run its normal migration.
            const raw = JSON.stringify(merged);
            storage.setItem(SETTINGS_KEY, raw);
            if (localStorage.getItem(SETTINGS_KEY) !== raw)
                throw new Error('Écriture non confirmée.');
            setPending(null);
            setNote(
                'Éléments manquants restaurés. Exportez les modifications non enregistrées des autres onglets avant de les recharger.'
            );
            scan();
        } catch (error) {
            setNote(
                `Restauration interrompue : ${error instanceof Error ? error.message : 'erreur inconnue'}`
            );
        }
    }

    return (
        <section className="rounded-xl border border-white/15 bg-white/5 p-4 space-y-3">
            <h2 className="font-semibold">Presets, personas et modèles ajoutés</h2>
            <p className="text-sm text-muted-foreground">
                Ces réglages sont séparés des conversations. Téléchargez une copie pour la garder en
                dehors du navigateur. Les copies automatiques restent dans ce navigateur et ne
                survivent pas à l’effacement de toutes ses données.
            </p>
            <button className={button} onClick={scan}>
                Relire les copies disponibles
            </button>
            {copies.length === 0 && (
                <p className="text-sm">
                    Aucune copie de réglages trouvée à cette adresse dans ce navigateur.
                </p>
            )}
            {copies.map((copy, index) => {
                let summary = 'Format illisible ou plus récent — export brut disponible.';
                let valid = false;
                try {
                    summary = counts(parseSettings(copy.raw));
                    valid = true;
                } catch {
                    /* preserve raw */
                }
                return (
                    <div
                        className="rounded-lg border border-white/10 p-3 space-y-2"
                        key={`${index}-${copy.label}`}
                    >
                        <p className="text-sm font-medium">{copy.label}</p>
                        <p className="text-xs text-muted-foreground">{summary}</p>
                        <div className="flex flex-wrap gap-2">
                            <button
                                className={button}
                                onClick={() => downloadSettingsFile(copy.raw, `copie-${index + 1}`)}
                            >
                                Télécharger cette copie
                            </button>
                            {valid && (
                                <button className={button} onClick={() => stage(copy.raw)}>
                                    Préparer la restauration
                                </button>
                            )}
                        </div>
                    </div>
                );
            })}
            <label className="block text-sm space-y-2">
                <span>Ouvrir une sauvegarde de réglages</span>
                <input
                    type="file"
                    accept="application/json,.json"
                    className="block w-full"
                    onChange={async (event) => {
                        const file = event.target.files?.[0];
                        if (file) {
                            try {
                                stage(await file.text());
                            } catch {
                                setNote('Impossible de lire ce fichier.');
                            }
                        }
                        event.target.value = '';
                    }}
                />
            </label>
            {pending && (
                <div className="rounded-lg border border-amber-400/40 p-3 space-y-2">
                    <p className="text-sm">Contenu du fichier : {counts(pending)}</p>
                    <p className="text-sm">
                        Seuls les éléments dont l’identifiant est absent seront ajoutés. Les
                        éléments existants et les clés API sont conservés. Fermez les anciennes
                        versions de l’application avant de continuer.
                    </p>
                    <div className="flex gap-2">
                        <button className={button} onClick={() => setPending(null)}>
                            Annuler
                        </button>
                        <button className={button} onClick={restore}>
                            Ajouter les éléments manquants
                        </button>
                    </div>
                </div>
            )}
            {note && (
                <p role="status" className="text-sm text-amber-400">
                    {note}
                </p>
            )}
        </section>
    );
}
