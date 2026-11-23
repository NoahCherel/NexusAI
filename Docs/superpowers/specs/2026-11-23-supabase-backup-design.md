# Online backup to Supabase — short design

Date: 2026-11-23.

## Intent

The user plays only on their phone (iPhone Safari). All their data lives in that browser, which
iOS can wipe. Goal: an always-recent copy on Supabase, so a wiped Safari or a lost phone costs at
most a few minutes of play, and the data can be restored onto a new phone.

## Decisions taken with the user

- **Approach: frequent backup files** (not a live mirror, not multi-device sync).
- **No passphrase**: protection = Supabase login + private bucket + access rules.
- Phone only: no per-device folders, no conflict handling.

## Approaches considered

- **A. Frequent backup files in Supabase Storage — picked.** Reuses `createGlobalBackup` /
  `restoreGlobalBackup` (tested), ~200 lines, no database version change, keeps history.
  Cost: each upload sends the whole compressed file.
- B. Live mirror, one row per record. Seconds of loss instead of minutes, tiny uploads, but
  ~500 lines (change queue, new DB version, hooks in ~20 save functions) and no history:
  a mistaken delete is mirrored online within seconds.
- C. Backup in a database column. No gain over A; database space (500 MB free) < file
  storage (1 GB).

## How it works

- **Package**: `@supabase/supabase-js` only. The data is in the browser, so the Next server
  never talks to Supabase: no `@supabase/ssr`, no server client, no middleware, no `npx skills add`.
- **Config**: `.env.local` (already git-ignored) with `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. One browser client module.
- **Supabase setup, done by the user in the dashboard** (the publishable key cannot create
  anything): a private bucket `backups`; access rules on `storage.objects` so a signed-in user
  only reads/writes/deletes files under `backups/<their user id>/`; one user created by hand
  (email + password); public sign-ups turned off. The plan ships the exact SQL and clicks.
- **Login**: email + password form in Settings, next to the existing global backup. The
  session is stored by supabase-js under `sb-…` keys, so it is never copied into backups
  (which only copy `nexusai*` keys).
- **Upload**: `createGlobalBackup` → JSON → gzip (`CompressionStream`) →
  `backups/<user id>/<ISO timestamp>.json.gz`.
- **When**: fully automatic, the user never acts (confirmed with the user). While signed in and
  the app is visible — once shortly after opening, then every 10 minutes; plus an optional
  "Sauvegarder maintenant" button. The manual "Télécharger une sauvegarde globale" stays as is. An upload is skipped when the content
  is unchanged since the last upload (hash of the backup without its `createdAt`).
- **Empty-phone guard**: if the local database has no conversations, never upload; if online
  backups exist, offer to restore the latest instead. (A wiped Safari can never push an empty
  backup.)
- **History**: after each upload, keep the newest 10 files plus the newest file of each day for
  30 days; delete the rest. Pure function, unit-tested.
- **Restore**: list online backups (date, size) in Settings and on `/rescue`; pick one →
  download → gunzip → existing `restoreGlobalBackup` (adds missing records, never deletes).
- **Status**: last successful upload time and size, last error, shown in the section; an upload
  failure also raises one notification.
- **Limits**: free tier = 50 MB per file, 1 GB total. A compressed backup over 50 MB is refused
  with a clear message.
- **API keys**: never sent readable. The existing backup strips them from the settings it
  rebuilds; the raw `nexusai*` copies it also keeps contain them only as ciphertext whose
  decryption key never leaves the phone (separate `nexusai-crypto` database, not backed up).

## Dependencies on the audit fixes

Do audit fix #7 (service worker) first, otherwise backup downloads would be cached forever by
the current service worker.

## Non-goals

Live sync, multi-device, passphrase encryption, server-side Supabase, restoring deletions
by merging (restore stays additive).

## Left to the builder

Exact UI placement within the Settings tab, wording, where the 10-minute scheduler is mounted
(chat page or app init hook), how live settings are read for automatic uploads.

## Done when

On the phone: sign in, an upload appears in Supabase within a minute, a second unchanged check
uploads nothing, history pruning keeps the right files (unit test), and restoring a backup into a
fresh Safari profile brings back characters, conversations and settings.
