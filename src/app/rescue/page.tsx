'use client';

/**
 * READ-ONLY rescue page.
 *
 * Opens whatever IndexedDB databases this browser holds for the current origin, WITHOUT ever
 * triggering a version upgrade, and reports what is actually stored. Then lets you dump
 * everything to a JSON file.
 *
 * Two rules this page must never break:
 *  - never call `indexedDB.open(name, version)` with a version → that would run a migration
 *  - never write, never delete
 */

import { useCallback, useEffect, useState } from 'react';

type StoreCounts = Record<string, number | string>;

interface DbReport {
    name: string;
    version: number | null;
    stores: string[];
    counts: StoreCounts;
    error?: string;
}

export default function RescuePage() {
    const [reports, setReports] = useState<DbReport[] | null>(null);
    const [origin, setOrigin] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');

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

    return (
        <div className="min-h-dvh bg-background text-foreground p-4 space-y-4">
            <header className="space-y-1">
                <h1 className="text-xl font-bold">Page de secours — lecture seule</h1>
                <p className="text-sm text-muted-foreground">
                    Cette page n&apos;écrit rien et ne supprime rien. Elle montre ce que ce
                    navigateur contient vraiment, et permet de tout sauvegarder.
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
