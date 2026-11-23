# Online Backup (Supabase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the app is open on the phone, automatically keep a recent compressed copy of all data in Supabase Storage, and restore it on a wiped or new phone.

**Architecture:** Browser-only. `createGlobalBackup` (existing) → gzip → Supabase Storage `backups/<user id>/<timestamp>.json.gz`, every 10 minutes when something changed, with history pruning. Restore = download → gunzip → existing `restoreGlobalBackup`. Login with Supabase Auth (email + password), access limited by storage policies.

**Tech Stack:** `@supabase/supabase-js` v2, Web `CompressionStream`, `crypto.subtle`, zustand, vitest.

**Spec:** `Docs/superpowers/specs/2026-11-23-supabase-backup-design.md`

## Global Constraints

- Run **after** `Docs/superpowers/plans/2026-11-23-audit-fixes.md` (its Task 6 stops the service worker caching backup downloads; its Task 5 provides `notifyError`).
- Branch `feat/online-backup`, never `main`. Commit after each task.
- Only new dependency: `@supabase/supabase-js`. No `@supabase/ssr`, no server client, no middleware, no `npx skills add`.
- Env vars, exact names: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, in `.env.local` only (git-ignored by `.env*`; never committed).
- Bucket `backups`; object path `<user id>/<name>`; name = `new Date().toISOString().replace(/[:.]/g, '-') + '.json.gz'`.
- Schedule: first check 30 s after the chat page opens, then every 10 min; only when `document.visibilityState === 'visible'` and signed in.
- History: keep the newest 10 files + the newest file of each UTC day not older than 30 days; never delete a name that does not match the pattern.
- Max compressed size: 52 428 800 bytes (Supabase free tier per-file limit).
- Upload state lives in localStorage key `online-backup-state`. It must **not** start with `nexusai`: `createGlobalBackup` copies every `nexusai*` key, so a prefixed key would make every backup look changed.
- UI copy in French.

## Review Focus

- Phone offline at a scheduled check → the error is recorded, one notice per page load, the next check retries → test in Task 3.
- Wiped Safari: signed out → nothing happens; signed in with zero conversations → never uploads, offers to restore → tests in Task 3 (+ banner in Task 4).
- Nothing changed since the last upload → nothing is sent → test in Task 3.
- The module's own saved state must not make the next backup look different → test in Task 3.
- Fresh clone or CI without env vars → the app still builds and Settings says the online backup isn't configured → test in Task 1.

---

### Task 1: Supabase project setup and browser client

**Files:**

- Create: `src/lib/supabase.ts`
- Create: `Docs/supabase-backup-setup.sql` (committed; exact SQL below)
- Create: `.env.local` (not committed) with the two values the user pasted
- Modify: `package.json`, `package-lock.json`
- Test: `src/lib/__tests__/supabase-client.test.ts`

**Interfaces:**

- Produces: `getSupabase(): SupabaseClient | null` — `null` when either env var is empty; one memoized client otherwise. Read `process.env.NEXT_PUBLIC_SUPABASE_URL` / `..._PUBLISHABLE_KEY` literally inside the function (Next inlines them at build).

- [ ] **Step 1: Write the failing test**

```ts
afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

it('is null when the Supabase env vars are missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    const { getSupabase } = await import('@/lib/supabase');
    expect(getSupabase()).toBeNull();
});

it('returns one shared client when configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const { getSupabase } = await import('@/lib/supabase');
    expect(getSupabase()).not.toBeNull();
    expect(getSupabase()).toBe(getSupabase());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/supabase-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`npm install @supabase/supabase-js`, then `getSupabase` with `createClient(url, key)` (default auth: session persisted in localStorage under `sb-…` keys, which backups never copy). Write `.env.local`. Write `Docs/supabase-backup-setup.sql`:

```sql
-- NexusAI online backup: a private bucket, each user only touches backups/<their id>/…
insert into storage.buckets (id, name, public, file_size_limit)
values ('backups', 'backups', false, 52428800)
on conflict (id) do nothing;

create policy "backups: read own" on storage.objects for select to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "backups: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'backups' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "backups: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = (select auth.uid()::text));
```

- [ ] **Step 4: USER STEP — Supabase dashboard (the publishable key cannot do this)**

1. SQL Editor → run `Docs/supabase-backup-setup.sql`.
2. Authentication → Users → Add user → email + password, "Auto Confirm User" checked.
3. Authentication → Sign In / Providers → turn **off** "Allow new users to sign up".
4. Restart the dev server so it reads `.env.local`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/__tests__/supabase-client.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase.ts src/lib/__tests__/supabase-client.test.ts Docs/supabase-backup-setup.sql package.json package-lock.json
git commit -m "feat(backup): Supabase browser client and bucket setup SQL"
```

---

### Task 2: Pure backup helpers

**Files:**

- Create: `src/lib/online-backup.ts`
- Test: `src/lib/__tests__/online-backup.test.ts`

**Interfaces:**

- Consumes: `GlobalBackup` type from `@/lib/global-backup`.
- Produces:
    - `gzipText(text: string): Promise<Blob>` / `gunzipText(blob: Blob): Promise<string>` (`CompressionStream` / `DecompressionStream`, `'gzip'`)
    - `backupFingerprint(backup: GlobalBackup): Promise<string>` — SHA-256 hex of the JSON with `createdAt` blanked
    - `countConversations(backup: GlobalBackup): number` — entries of the `conversations` store, 0 when `database` is null
    - `backupFileName(date: Date): string`
    - `pickBackupsToDelete(names: string[], now: Date): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
const day = (d: string, h: string) => `${d}T${h}-00-00-000Z.json.gz`;

it('round-trips text through gzip', async () => {
    const text = 'é'.repeat(2000) + '{"a":1}';
    expect(await gunzipText(await gzipText(text))).toBe(text);
});

it('fingerprints content, not the creation time', async () => {
    const a = { ...fixture, createdAt: '2026-01-01' };
    expect(await backupFingerprint(a)).toBe(
        await backupFingerprint({ ...a, createdAt: '2026-02-02' })
    );
    expect(await backupFingerprint(a)).not.toBe(await backupFingerprint({ ...a, origin: 'x' }));
});

it('counts conversations in the snapshot', () => {
    expect(countConversations(fixture)).toBe(2); // fixture: a `conversations` store with 2 entries
    expect(countConversations({ ...fixture, database: null })).toBe(0);
});

it('names files so they sort by time', () => {
    expect(backupFileName(new Date('2026-11-23T10:15:30.123Z'))).toBe(
        '2026-11-23T10-15-30-123Z.json.gz'
    );
});

it('keeps the newest 10, one per day for 30 days, and unknown files', () => {
    const today = Array.from({ length: 10 }, (_, i) =>
        day('2026-11-23', String(i).padStart(2, '0'))
    );
    const names = [
        ...today,
        day('2026-11-21', '08'),
        day('2026-11-21', '12'),
        day('2026-11-21', '20'),
        day('2026-10-25', '10'), // 29 days old, only one that day → kept
        day('2026-10-23', '10'), // 31 days old → deleted
        'notes.txt',
    ];
    expect(pickBackupsToDelete(names, new Date('2026-11-23T21:00:00Z')).sort()).toEqual(
        [day('2026-10-23', '10'), day('2026-11-21', '08'), day('2026-11-21', '12')].sort()
    );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/__tests__/online-backup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the five helpers in `src/lib/online-backup.ts`**

`pickBackupsToDelete`: consider only names matching `/^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json\.gz$/`; sort descending; keep the first 10; keep the first name seen for each `name.slice(0, 10)` day that is `>=` `new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)`; return the rest.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/online-backup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/online-backup.ts src/lib/__tests__/online-backup.test.ts
git commit -m "feat(backup): gzip, fingerprint and history-pruning helpers"
```

---

### Task 3: Upload, list and restore

**Files:**

- Modify: `src/lib/online-backup.ts`
- Modify: `src/stores/settings-store.ts` (add `getLiveSettingsEnvelope`), `src/components/layout/SettingsPanel.tsx:969-975` (use it)
- Test: `src/lib/__tests__/online-backup-sync.test.ts`

**Interfaces:**

- Consumes: `getSupabase()` (Task 1); Task 2 helpers; `createGlobalBackup`, `parseGlobalBackup`, `restoreGlobalBackup` from `@/lib/global-backup`; `notifyError(title, detail)` from `@/components/ui/api-notification`.
- Produces:
    - `type OnlineBackupResult = { status: 'uploaded'; size: number; at: string } | { status: 'unchanged' | 'empty' | 'signed-out' | 'not-configured' } | { status: 'error'; message: string }`
    - `interface OnlineBackupState { fingerprint?: string; lastUploadAt?: string; lastSize?: number; lastError?: string }` and `readOnlineBackupState(): OnlineBackupState`
    - `runOnlineBackup(options?: { force?: boolean; getLiveSettings?: () => SettingsEnvelope }): Promise<OnlineBackupResult>` — single-flight (a call while one runs returns the same promise)
    - `listOnlineBackups(): Promise<{ name: string; size: number }[]>` — newest first
    - `restoreOnlineBackup(name: string): Promise<number>` — records added
    - `getLiveSettingsEnvelope(): SettingsEnvelope` in `settings-store.ts` = `{ state: { ...useSettingsStore.getState() }, version: SETTINGS_VERSION }`

- [ ] **Step 1: Write the failing tests**

Mocks: `vi.mock('@/lib/supabase')` → a fake client: `auth.getSession()` returns a session for user `u1` (or `null` per test); `storage.from('backups')` with `upload`, `list`, `download`, `remove` over an in-memory `Map<string, Blob>` (an `uploadError` switch makes `upload` return `{ error: { message: 'network' } }`). `vi.mock('@/lib/global-backup')` → `createGlobalBackup` returns a mutable `fixture` (2 conversations), `parseGlobalBackup` = `JSON.parse`, `restoreGlobalBackup` = `vi.fn(async () => 7)`. Stub `localStorage` (Map-backed, as in `global-backup.test.ts`) and `location.origin`.

```ts
it('uploads once, then reports unchanged', async () => {
    expect((await runOnlineBackup()).status).toBe('uploaded');
    expect((await runOnlineBackup()).status).toBe('unchanged');
    expect(files.size).toBe(1);
});

it('keeps its own state out of what gets backed up', async () => {
    await runOnlineBackup();
    expect(Object.keys(storedKeys()).filter((k) => k.startsWith('nexusai'))).toEqual([]);
});

it('never uploads from a device with no conversations', async () => {
    fixture = emptyFixture; // conversations store with 0 entries
    expect((await runOnlineBackup({ force: true })).status).toBe('empty');
    expect(files.size).toBe(0);
});

it('does nothing when signed out', async () => {
    session = null;
    expect((await runOnlineBackup()).status).toBe('signed-out');
});

it('records a failed upload and notifies once per page load', async () => {
    uploadError = true;
    expect((await runOnlineBackup()).status).toBe('error');
    expect((await runOnlineBackup()).status).toBe('error');
    expect(readOnlineBackupState().lastError).toBe('network');
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
});

it('prunes history after an upload', async () => {
    for (let i = 0; i < 12; i++)
        files.set(
            `u1/2026-11-23T0${i % 10}-0${Math.floor(i / 10)}-00-000Z.json.gz`,
            new Blob(['x'])
        );
    await runOnlineBackup();
    expect(files.size).toBe(10);
});

it('restores the chosen backup through the existing restore', async () => {
    await runOnlineBackup();
    const [{ name }] = await listOnlineBackups();
    expect(await restoreOnlineBackup(name)).toBe(7);
    expect(restoreGlobalBackup).toHaveBeenCalledWith(fixture, localStorage);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/__tests__/online-backup-sync.test.ts`
Expected: FAIL — `runOnlineBackup` is not exported.

- [ ] **Step 3: Implement**

`runOnlineBackup` order: no client → `not-configured`; no session → `signed-out`; `createGlobalBackup(localStorage, location.origin, getLiveSettings?.())`; `countConversations === 0` → `empty`; fingerprint equal to the saved one and not `force` → `unchanged`; gzip; over 52 428 800 bytes → error `Sauvegarde trop volumineuse pour l’offre gratuite (50 Mo).`; upload to `${userId}/${backupFileName(new Date())}` with `contentType: 'application/gzip'`; save `{ fingerprint, lastUploadAt, lastSize }` (clear `lastError`); prune with `pickBackupsToDelete` over the folder listing (`list(userId, { limit: 100 })`) and `remove`. Any failure → save `lastError`, first failure of the page load calls `notifyError('Sauvegarde en ligne impossible', message)`, return `error`. Replace the inline lambda in `SettingsPanel.tsx` with `getLiveSettingsEnvelope`.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/online-backup.ts src/lib/__tests__/online-backup-sync.test.ts src/stores/settings-store.ts src/components/layout/SettingsPanel.tsx
git commit -m "feat(backup): upload, prune, list and restore online backups"
```

---

### Task 4: Settings and rescue UI

**Files:**

- Create: `src/components/settings/OnlineBackupControls.tsx`
- Modify: `src/components/settings/index.ts` (export), `src/components/layout/SettingsPanel.tsx` (backups tab, under `GlobalBackupControls`, `getLiveSettings={getLiveSettingsEnvelope}`), `src/app/rescue/page.tsx:297-300` (new section "Sauvegarde en ligne", no `getLiveSettings` — the rescue page never loads the stores)

**Interfaces:**

- Consumes: everything Task 3 produces; `getSupabase()`; `ConfirmDialog` from `@/components/ui/confirm-dialog`.
- Produces: `OnlineBackupControls({ getLiveSettings }: { getLiveSettings?: () => SettingsEnvelope })`.

- [ ] **Step 1: Implement the three states**

- Not configured (`getSupabase()` null): `Sauvegarde en ligne non configurée (variables Supabase absentes).`
- Signed out: email + password inputs, button `Se connecter` (`auth.signInWithPassword`), error shown inline.
- Signed in: email; `Dernière sauvegarde : <date locale> (<taille>)` or `Aucune sauvegarde en ligne`; `lastError` in amber; `Sauvegarder maintenant` (`runOnlineBackup({ force: true, getLiveSettings })`); list from `listOnlineBackups()` with date (from the name) + size and a `Restaurer` button behind a `ConfirmDialog` (`Restaurer cette sauvegarde ?` / `Les éléments absents de cet appareil seront ajoutés ; rien n’est supprimé.`), then the note `Restauration terminée : rechargez l’application.`; `Se déconnecter`.
- Right after sign-in and on mount while signed in, call `runOnlineBackup({ getLiveSettings })`. If it returns `empty` and the list is not empty, show the banner `Cet appareil n’a aucune conversation. Restaurer la sauvegarde en ligne la plus récente ?` with a button restoring the newest file.

- [ ] **Step 2: Verify**

Run: `npm run type-check && npm run lint`
Expected: PASS.
Manual (dev server, signed in with the user created in Task 1): Settings → Sauvegardes shows the section; `Sauvegarder maintenant` adds a file in Supabase → Storage → `backups/<id>/`; the list shows it; `/rescue` shows the same section.

- [ ] **Step 3: Commit**

```bash
git add src/components/settings src/components/layout/SettingsPanel.tsx src/app/rescue/page.tsx
git commit -m "feat(backup): online backup section in Settings and /rescue"
```

---

### Task 5: Automatic schedule

**Files:**

- Create: `src/hooks/useOnlineBackup.ts`
- Modify: `src/app/chat/page.tsx:125` (call it next to `useAppInitialization()`)

**Interfaces:**

- Consumes: `runOnlineBackup`, `readOnlineBackupState` (Task 3), `getLiveSettingsEnvelope`.
- Produces: `useOnlineBackup(): void`.

- [ ] **Step 1: Implement**

On mount: a 30 000 ms timeout and a 600 000 ms interval, both calling `tick`. `tick` returns early unless `document.visibilityState === 'visible'`, then calls `runOnlineBackup({ getLiveSettings: getLiveSettingsEnvelope })`. On `visibilitychange` to visible, `tick` if `lastUploadAt` is missing or older than 10 minutes (iOS pauses timers in the background). Clear everything on unmount. Single-flight in `runOnlineBackup` prevents overlaps.

- [ ] **Step 2: Verify**

Run: `npm run type-check && npm run lint && npm test`
Expected: PASS.
Manual: open `/chat` signed in; within ~30 s a new file appears in Supabase; reload and wait — no second file if nothing changed; send a message, then switch away and back after 10 min — a new file appears.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useOnlineBackup.ts src/app/chat/page.tsx
git commit -m "feat(backup): automatic online backup every 10 minutes while the app is open"
```

---

### Task 6: End-to-end check on the phone

- [ ] **Step 1: Full local checks**

Run: `npm run format:check && npm run lint && npm run type-check && npm test && npm run build`
Expected: all PASS (build works without `.env.local` too — rename it temporarily to confirm, then restore it).

- [ ] **Step 2: USER STEP — on the iPhone**

1. Réglages → Sauvegardes → sign in. Within a minute a file appears in Supabase Storage.
2. In a **private Safari tab** (empty storage), open the app, sign in: the "aucune conversation" banner appears; restore; reload: characters, conversations and settings are back (API keys must be re-entered).
3. Close the private tab. Check Storage still holds the normal phone's latest file (the empty tab never uploaded).
