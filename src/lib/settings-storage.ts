import type { StateStorage } from 'zustand/middleware';

// A separate destination fences off old application bundles, which still write the
// legacy key without any conflict/error protection. Never remove that original.
export const SETTINGS_KEY = 'nexusai-settings-protected';
export const LEGACY_SETTINGS_KEY = 'nexusai-settings';
export const SETTINGS_HISTORY_KEY = 'nexusai-settings-history';
export const SETTINGS_VERSION = 2;
export const COLLECTIONS = ['presets', 'personas', 'customModels', 'customEngines'] as const;

export interface SettingsEnvelope {
    state: Record<string, unknown>;
    version?: number;
}

export interface SettingsCheckpoint {
    savedAt: string;
    raw: string;
}

export function parseSettings(raw: string): SettingsEnvelope {
    const value = JSON.parse(raw);
    if (
        !value ||
        typeof value !== 'object' ||
        !value.state ||
        typeof value.state !== 'object' ||
        Array.isArray(value.state)
    ) {
        throw new Error('Sauvegarde des réglages illisible.');
    }
    if (
        value.version !== undefined &&
        (!Number.isInteger(value.version) || value.version < 0 || value.version > SETTINGS_VERSION)
    ) {
        throw new Error('Ces réglages proviennent d’une version plus récente ou inconnue.');
    }
    for (const key of COLLECTIONS) {
        const rows = value.state[key];
        if (
            rows !== undefined &&
            (!Array.isArray(rows) ||
                rows.some((row) => !row || typeof row !== 'object' || typeof row.id !== 'string'))
        ) {
            throw new Error(`La collection « ${key} » est illisible.`);
        }
    }
    return value;
}

let issue: string | null = null;
const listeners = new Set<() => void>();
export const getSettingsStorageIssue = () => issue;
export const subscribeSettingsStorageIssue = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

function reportIssue(message: string) {
    issue = message;
    listeners.forEach((listener) => listener());
}

export function readSettingsHistory(storage: Pick<Storage, 'getItem'>): SettingsCheckpoint[] {
    const raw = storage.getItem(SETTINGS_HISTORY_KEY);
    if (raw === null) return [];
    const history: unknown = JSON.parse(raw);
    if (
        !Array.isArray(history) ||
        history.some(
            (entry) => !entry || typeof entry.savedAt !== 'string' || typeof entry.raw !== 'string'
        )
    ) {
        throw new Error('Historique des réglages illisible.');
    }
    return history;
}

function collectionsFingerprint(raw: string) {
    const { state } = parseSettings(raw);
    return JSON.stringify(COLLECTIONS.map((key) => state[key]));
}

/** Synchronous hydration; failed reads must never become successful empty writes. */
export function createSafeSettingsStorage(
    getStorage: () => Storage,
    onIssue: (message: string) => void = reportIssue,
    options: { explicitRestore?: boolean } = {}
): StateStorage {
    let read = false;
    let blocked = false;
    let baseline: string | null = null;
    let legacy: string | null = null;

    const fail = (message: string) => {
        blocked = true;
        onIssue(message);
    };

    return {
        getItem: () => {
            try {
                if (blocked) throw new Error('Enregistrement suspendu dans cet onglet.');
                const storage = getStorage();
                baseline = storage.getItem(SETTINGS_KEY);
                legacy = baseline === null ? storage.getItem(LEGACY_SETTINGS_KEY) : null;
                const raw = baseline ?? legacy;
                if (raw !== null) parseSettings(raw);
                else if (
                    !options.explicitRestore &&
                    storage.getItem(SETTINGS_HISTORY_KEY) !== null
                ) {
                    throw new Error(
                        'Réglages absents, mais un historique existe. Consultez les sauvegardes.'
                    );
                }
                read = true;
                return raw;
            } catch (error) {
                fail(
                    `Lecture des réglages impossible. ${error instanceof Error ? error.message : ''}`
                );
                throw error;
            }
        },
        setItem: (_name, raw) => {
            // Zustand updates memory before persisting. Keep a permanent visible warning
            // and offer an export of that memory instead of crashing or claiming success.
            if (blocked) return;
            try {
                if (!read) throw new Error('Les réglages n’ont pas été chargés.');
                parseSettings(raw);
                const storage = getStorage();
                if (
                    storage.getItem(SETTINGS_KEY) !== baseline ||
                    (baseline === null && storage.getItem(LEGACY_SETTINGS_KEY) !== legacy)
                ) {
                    throw new Error(
                        'Un autre onglet a modifié les réglages. Exportez vos modifications avant de recharger.'
                    );
                }
                if (raw === baseline) return;
                const previous = baseline ?? legacy;
                const history = readSettingsHistory(storage);
                // Always keep the first snapshot; retain four recent collection revisions.
                // Routine model selections / usage updates do not rotate this history.
                if (
                    previous !== null &&
                    (history.length === 0 ||
                        collectionsFingerprint(previous) !== collectionsFingerprint(raw))
                ) {
                    if (history.at(-1)?.raw !== previous) {
                        const next = [
                            ...history,
                            { savedAt: new Date().toISOString(), raw: previous },
                        ];
                        const bounded = next.length > 5 ? [next[0], ...next.slice(-4)] : next;
                        storage.setItem(SETTINGS_HISTORY_KEY, JSON.stringify(bounded));
                    }
                }
                // A quota error above aborts BEFORE overwriting the only current copy.
                storage.setItem(SETTINGS_KEY, raw);
                baseline = raw;
                legacy = null;
            } catch (error) {
                fail(
                    `Enregistrement des réglages suspendu. ${error instanceof Error ? error.message : ''}`
                );
            }
        },
        removeItem: () => {
            fail('La suppression globale des réglages est bloquée pour protéger vos données.');
        },
    };
}

/** Restore missing authored records only; keep existing records and other settings. */
export function mergeMissingSettings(
    current: SettingsEnvelope,
    backup: SettingsEnvelope
): SettingsEnvelope {
    const state = { ...current.state };
    for (const key of COLLECTIONS) {
        const existing = (state[key] ?? []) as { id: string }[];
        const ids = new Set(existing.map((row) => row.id));
        const additions = ((backup.state[key] ?? []) as { id: string }[]).filter((row) => {
            if (ids.has(row.id)) return false;
            ids.add(row.id);
            return true;
        });
        state[key] = [...existing, ...additions];
    }
    return { ...current, state };
}
