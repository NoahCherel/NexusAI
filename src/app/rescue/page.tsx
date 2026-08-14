'use client';

/**
 * Backup & restore page — the safety net that should have existed before any schema change.
 *
 * Opens whatever IndexedDB databases this browser holds for the current origin WITHOUT ever
 * triggering a version upgrade, reports what is actually stored, dumps it to JSON, and can put
 * a dump back.
 *
 * Three rules this page must never break:
 *  - never call `indexedDB.open(name, version)` with a version → that would run a migration
 *  - never delete anything: restore is `put`-only, so it adds and overwrites by key, and a
 *    record present in the database but absent from the backup is left alone
 *  - always show what will be written before writing it
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type StoreCounts = Record<string, number | string>;

interface DbReport {
    name: string;
    version: number | null;
    stores: string[];
    counts: StoreCounts;
    error?: string;
}

interface PendingRestore {
    dbName: string;
    fileName: string;
    counts: Record<string, number>;
    data: Record<string, unknown[]>;
    /** Stores in the backup that don't exist in the live database — cannot be restored here. */
    missingStores: string[];
}

export default function RescuePage() {
    const [reports, setReports] = useState<DbReport[] | null>(null);
    const [origin, setOrigin] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    const [pending, setPending] = useState<PendingRestore | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const scan = useCallback(async () => {
        setBusy(true);
        setNote('');
        try {
            setOrigin(window.location.origin);
            const listed =
                typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
            // Fall back to the known name when the browser doesn't support databases().
            const names = listed.length
                ? listed.map((d) => d.name).filter((n): n is string => !!n)
                : ['nexusai-db'];

            const out: DbReport[] = [];
            for (const name of names) {
                out.push(
                    await new Promise<DbReport>((resolve) => {
                        // No version argument: opens at the CURRENT version, never upgrades.
                        const req = indexedDB.open(name);
                        req.onerror = () =>
                            resolve({
                                name,
                                version: null,
                                stores: [],
                                counts: {},
                                error: String(req.error),
                            });
                        req.onblocked = () =>
                            resolve({
                                name,
                                version: null,
                                stores: [],
                                counts: {},
                                error: 'blocked — close the app’s other tabs and retry',
                            });
                        req.onsuccess = async () => {
                            const db = req.result;
                            const stores = [...db.objectStoreNames];
                            const counts: StoreCounts = {};
                            for (const s of stores) {
                                counts[s] = await new Promise<number | string>((res) => {
                                    try {
                                        const c = db.transaction(s, 'readonly').objectStore(s).count();
                                        c.onsuccess = () => res(c.result);
                                        c.onerror = () => res('unreadable');
                                    } catch {
                                        res('unreadable');
                                    }
                                });
                            }
                            const v = db.version;
                            db.close();
                            resolve({ name, version: v, stores, counts });
                        };
                    })
                );
            }
            setReports(out);
        } catch (e) {
            setNote(`Scan impossible : ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => {
        void scan();
    }, [scan]);

    const dump = async (dbName: string) => {
        setBusy(true);
        setNote('Lecture en cours…');
        try {
            const data = await new Promise<Record<string, unknown[]>>((resolve, reject) => {
                const req = indexedDB.open(dbName);
                req.onerror = () => reject(req.error);
                req.onsuccess = async () => {
                    const db = req.result;
                    const result: Record<string, unknown[]> = {};
                    for (const s of [...db.objectStoreNames]) {
                        result[s] = await new Promise<unknown[]>((res) => {
                            try {
                                const g = db.transaction(s, 'readonly').objectStore(s).getAll();
                                g.onsuccess = () => res(g.result);
                                g.onerror = () => res([]);
                            } catch {
                                res([]);
                            }
                        });
                    }
                    db.close();
                    resolve(result);
                };
            });

            const blob = new Blob([JSON.stringify({ dbName, origin, data }, null, 2)], {
                type: 'application/json',
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `nexusai-sauvegarde-${dbName}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            setNote('Sauvegarde téléchargée. Gardez ce fichier avant toute autre manipulation.');
        } catch (e) {
            setNote(`Export échoué : ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    /** Parse a backup file and show what it holds. Nothing is written at this stage. */
    const stageRestore = async (file: File) => {
        setBusy(true);
        setNote('');
        setPending(null);
        try {
            const parsed = JSON.parse(await file.text()) as {
                dbName?: string;
                data?: Record<string, unknown[]>;
            };
            const dbName = parsed.dbName || 'nexusai-db';
            const data = parsed.data;
            if (!data || typeof data !== 'object') {
                setNote('Ce fichier n’est pas une sauvegarde valide (champ « data » absent).');
                return;
            }

            const liveStores = await new Promise<string[]>((resolve) => {
                const req = indexedDB.open(dbName);
                req.onerror = () => resolve([]);
                req.onsuccess = () => {
                    const db = req.result;
                    const s = [...db.objectStoreNames];
                    db.close();
                    resolve(s);
                };
            });

            const counts: Record<string, number> = {};
            const missingStores: string[] = [];
            for (const [store, rows] of Object.entries(data)) {
                if (!Array.isArray(rows)) continue;
                counts[store] = rows.length;
                if (!liveStores.includes(store)) missingStores.push(store);
            }
            setPending({ dbName, fileName: file.name, counts, data, missingStores });
        } catch (e) {
            setNote(`Lecture du fichier impossible : ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    /** put-only restore. Never clears a store, never deletes a record. */
    const commitRestore = async () => {
        if (!pending) return;
        setBusy(true);
        setNote('Restauration en cours…');
        try {
            const written = await new Promise<number>((resolve, reject) => {
                const req = indexedDB.open(pending.dbName);
                req.onerror = () => reject(req.error);
                req.onsuccess = async () => {
                    const db = req.result;
                    const live = [...db.objectStoreNames];
                    let n = 0;
                    for (const [store, rows] of Object.entries(pending.data)) {
                        if (!Array.isArray(rows) || !live.includes(store) || rows.length === 0)
                            continue;
                        await new Promise<void>((res, rej) => {
                            const tx = db.transaction(store, 'readwrite');
                            const os = tx.objectStore(store);
                            for (const row of rows) {
                                try {
                                    // Out-of-line key stores (canon, arcOutlines) need their key.
                                    if (os.keyPath === null) {
                                        const r = row as { id?: string; work?: string };
                                        const key = r.id ?? r.work;
                                        if (key === undefined) continue;
                                        os.put(row, key);
                                    } else {
                                        os.put(row);
                                    }
                                    n++;
                                } catch {
                                    /* skip a malformed row rather than abort the whole store */
                                }
                            }
                            tx.oncomplete = () => res();
                            tx.onerror = () => rej(tx.error);
                            tx.onabort = () => rej(tx.error);
                        });
                    }
                    db.close();
                    resolve(n);
                };
            });
            setNote(
                `${written} enregistrement(s) restaurés. Rechargez l’application pour les voir.`
            );
            setPending(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
            await scan();
        } catch (e) {
            setNote(`Restauration échouée : ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="min-h-dvh bg-background text-foreground p-4 space-y-4">
            <header className="space-y-1">
                <h1 className="text-xl font-bold">Sauvegarde & restauration</h1>
                <p className="text-sm text-muted-foreground">
                    Cette page ne supprime jamais rien. La restauration ajoute et met à jour par
                    identifiant ; ce qui existe déjà et n&apos;est pas dans la sauvegarde reste
                    en place.
                </p>
                <p className="text-xs font-mono text-muted-foreground break-all">
                    Origine : {origin || '…'}
                </p>
                <p className="text-xs text-amber-400">
                    L&apos;origine compte : les données d&apos;une adresse ne sont pas visibles
                    depuis une autre. Ouvrez cette page à l&apos;adresse EXACTE que vous
                    utilisiez d&apos;habitude.
                </p>
            </header>

            <div className="flex gap-2">
                <button
                    onClick={() => void scan()}
                    disabled={busy}
                    className="px-3 py-2 rounded-lg border border-white/15 bg-white/5 text-sm disabled:opacity-50"
                >
                    {busy ? 'Analyse…' : 'Réanalyser'}
                </button>
            </div>

            {note && <p className="text-sm text-amber-400">{note}</p>}

            {/* Restore. Deliberately below the scan: read the state first, then decide. */}
            <section className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-2">
                <h2 className="font-semibold text-sm">Restaurer une sauvegarde</h2>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    disabled={busy}
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void stageRestore(f);
                    }}
                    className="block w-full text-sm file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-white/10 file:text-sm"
                />

                {pending && (
                    <div className="space-y-2 pt-1">
                        <p className="text-sm">
                            <span className="font-mono break-all">{pending.fileName}</span> →{' '}
                            <span className="font-mono">{pending.dbName}</span>
                        </p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                            {Object.entries(pending.counts).map(([store, n]) => (
                                <div key={store} className="flex justify-between gap-2">
                                    <span className="text-muted-foreground truncate">{store}</span>
                                    <span className="font-mono">{n}</span>
                                </div>
                            ))}
                        </div>
                        {pending.missingStores.length > 0 && (
                            <p className="text-xs text-amber-400">
                                Non restaurables (absents de la base actuelle) :{' '}
                                {pending.missingStores.join(', ')}
                            </p>
                        )}
                        <div className="flex gap-2">
                            <button
                                onClick={() => {
                                    setPending(null);
                                    if (fileInputRef.current) fileInputRef.current.value = '';
                                }}
                                disabled={busy}
                                className="flex-1 px-3 py-2 rounded-lg border border-white/15 text-sm disabled:opacity-50"
                            >
                                Annuler
                            </button>
                            <button
                                onClick={() => void commitRestore()}
                                disabled={busy}
                                className="flex-1 px-3 py-2 rounded-lg border border-green-500/40 bg-green-500/15 text-sm disabled:opacity-50"
                            >
                                {busy ? 'Restauration…' : 'Écrire dans la base'}
                            </button>
                        </div>
                    </div>
                )}
            </section>

            {reports === null ? (
                <p className="text-sm text-muted-foreground">Analyse…</p>
            ) : reports.length === 0 ? (
                <p className="text-sm">Aucune base de données pour cette origine.</p>
            ) : (
                <div className="space-y-3">
                    {reports.map((r) => {
                        const conv = typeof r.counts.conversations === 'number' ? r.counts.conversations : 0;
                        const msgs = typeof r.counts.messages === 'number' ? r.counts.messages : 0;
                        const hasData = conv > 0 || msgs > 0;
                        return (
                            <section
                                key={r.name}
                                className={`rounded-xl border p-3 space-y-2 ${
                                    hasData
                                        ? 'border-green-500/40 bg-green-500/5'
                                        : 'border-white/10 bg-white/5'
                                }`}
                            >
                                <div className="flex items-baseline justify-between gap-2">
                                    <h2 className="font-semibold font-mono text-sm break-all">
                                        {r.name}
                                    </h2>
                                    <span className="text-xs text-muted-foreground">
                                        v{r.version ?? '?'}
                                    </span>
                                </div>

                                {r.error ? (
                                    <p className="text-sm text-red-400 break-words">
                                        Erreur : {r.error}
                                    </p>
                                ) : (
                                    <>
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                                            {Object.entries(r.counts).map(([store, n]) => (
                                                <div key={store} className="flex justify-between gap-2">
                                                    <span className="text-muted-foreground truncate">
                                                        {store}
                                                    </span>
                                                    <span className="font-mono">{String(n)}</span>
                                                </div>
                                            ))}
                                        </div>

                                        {hasData ? (
                                            <p className="text-sm text-green-400">
                                                Vos données sont là : {conv} conversation(s),{' '}
                                                {msgs} message(s).
                                            </p>
                                        ) : (
                                            <p className="text-sm text-muted-foreground">
                                                Rien dans cette base pour cette origine.
                                            </p>
                                        )}

                                        <button
                                            onClick={() => void dump(r.name)}
                                            disabled={busy}
                                            className="w-full px-3 py-2 rounded-lg border border-white/15 bg-white/10 text-sm disabled:opacity-50"
                                        >
                                            Sauvegarder cette base en JSON
                                        </button>
                                    </>
                                )}
                            </section>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
