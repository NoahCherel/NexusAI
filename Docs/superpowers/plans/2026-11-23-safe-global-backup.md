# Safe Global Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make « Télécharger une sauvegarde globale » and its restore work on ~30 000 messages on an iPhone PWA, without ever loading the whole database in memory.

**Architecture:** A v2 backup file = gzip NDJSON written page by page from IndexedDB into a `CompressionStream`; restore streams it back twice (validate, then write in batches). The v1 JSON path stays for old files. UI saves through the Web Share API.

**Tech Stack:** IndexedDB (raw API, as in `global-backup.ts`), `CompressionStream`/`DecompressionStream`, `TextDecoderStream`, Web Share API, vitest + fake-indexeddb.

**Spec:** `Docs/superpowers/specs/2026-11-23-safe-global-backup-design.md`

## Global Constraints

- Branch `feat/safe-global-backup`. Commit after each task. No push without the user's OK.
- No new dependency. No database version or settings format change.
- Page size: 25 records per IndexedDB request. Skipped stores: `facts`, `vectors`.
- Restore never deletes and never overwrites existing records (same rule as v1).
- UI copy in French.

## Review Focus

- A file cut short (interrupted save, partial copy) must be refused before anything is written → test in Task 2.
- Restoring the same file twice must add nothing the second time → test in Task 2.
- Stores with out-of-line keys (`canon`, `arcOutlines`) must keep their keys → tests in Tasks 1 and 2.
- An old v1 `.json` backup must still restore → existing tests in `global-backup.test.ts` stay green.
- The share sheet needs a tap: the save button must not be called after a long await → Task 3 flow.

---

### Task 1: Streamed backup writer

**Files:** Modify `src/lib/global-backup.ts`; Test `src/lib/__tests__/global-backup-stream.test.ts`

**Interfaces — Produces:**

- `BACKUP_PAGE_SIZE = 25`, `LEGACY_STORES = ['facts', 'vectors']`
- `createGlobalBackupFile(storage: Storage, origin: string, liveSettings?: SettingsEnvelope, onProgress?: (done: number, total: number) => void): Promise<Blob>` — lines: header `{ format: 'nexusai-global-backup', version: 2, createdAt, origin, apiKeys: 'reenter-on-restore', settings, localStorage, database: { version } | null }`, then per store `{ store: { name, keyPath, autoIncrement, indexes, count } }` + its `{ s, k, v }` lines, then `{ end: true, records }`.

- [ ] Step 1: failing tests — (a) 60 messages + 1 canon (out-of-line key) + 1 vectors record: lines list stores without `vectors`, 60 message lines, canon key `'mixed case::élodie'`, end line `records: 61`; (b) every `getAll`/`getAllKeys` call gets a count of 25 (spy on `IDBObjectStore.prototype`); (c) header settings have `apiKeys: []`; (d) progress ends at `(61, 61)`.
- [ ] Step 2: run → FAIL (not exported).
- [ ] Step 3: implement; extract the settings/localStorage part of `createGlobalBackup` into a shared helper so both writers agree.
- [ ] Step 4: `npx vitest run src/lib/__tests__/global-backup-stream.test.ts src/lib/__tests__/global-backup.test.ts` → PASS.
- [ ] Step 5: commit.

### Task 2: Streamed inspect and restore

**Files:** Modify `src/lib/global-backup.ts`; Test same file as Task 1.

**Interfaces — Produces:**

- `isGzipFile(file: Blob): Promise<boolean>` (magic bytes `1f 8b`)
- `interface BackupFileSummary { createdAt: string; settings: SettingsEnvelope | null; counts: Record<string, number>; total: number }`
- `inspectGlobalBackupFile(file: Blob, onProgress?): Promise<BackupFileSummary>` — validates every line (header, store declared before its records, key valid, inline key matches keyPath, end line present and count matches); writes nothing.
- `restoreGlobalBackupFile(file: Blob, storage: Storage, onProgress?): Promise<number>` — validates first (calls `inspectGlobalBackupFile`), then adds missing records in batches of 200, then restores settings like v1. Shares the settings and open-or-create-database code with `restoreGlobalBackup`.

- [ ] Step 1: failing tests — round-trip onto a fresh `IDBFactory` returns 61 and the records read back equal (dates, canon key); second restore returns 0; a file without its end line (rebuilt from the first lines) throws and leaves the fresh database empty; existing records are not overwritten.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: full `npm test` → PASS (v1 tests included).
- [ ] Step 5: commit.

### Task 3: Backup UI

**Files:** Modify `src/components/settings/GlobalBackupControls.tsx`

- [ ] Step 1: backup button → `createGlobalBackupFile` with live settings and a progress line « Lecture… N / T éléments »; when done, show « Enregistrer le fichier (xx Mo) ». That button (a fresh tap) calls `navigator.share({ files: [file] })` when `navigator.canShare?.({ files })`, else downloads via an object URL. On success store `{ at, size }` in localStorage `nexusai-last-global-backup` and show « Dernière sauvegarde enregistrée : date (taille) ». A cancelled share (AbortError) changes nothing.
- [ ] Step 2: restore input accepts `.gz` and `.json`; gzip → `inspectGlobalBackupFile` with progress, summary from `counts`, confirm → `restoreGlobalBackupFile`; otherwise the existing v1 path.
- [ ] Step 3: `npm run type-check && npm run lint` → PASS; commit.

### Task 4: Load check, cleanup, verification

- [ ] Step 1: one-off script (not committed): fake-indexeddb with 30 000 messages of ~6 KB French text; time and peak memory of `createGlobalBackupFile`, compressed size, then restore into a fresh database. Expected: completes, peak heap far below the raw data size.
- [ ] Step 2: delete the local `.env.local` and the abandoned Supabase spec/plan docs; commit.
- [ ] Step 3: `npm run lint && npm run type-check && npm test && npm run build` → PASS.
