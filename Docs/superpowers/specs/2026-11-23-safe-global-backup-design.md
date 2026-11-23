# Safe global backup for large data — short design

Date: 2026-11-23. Replaces the abandoned Supabase online backup.

## Intent

The user plays only in the iPhone home-screen PWA, with 100+ conversations of 300+ messages of
1–2k tokens each (~30 000 messages, est. 150–300 MB of text). The current « Télécharger une
sauvegarde globale » reads every store in one transaction with `getAll()` and builds one JSON
string in memory: on that volume it spins for minutes or crashes Safari's IndexedDB backend
(observed with the online backup, which used the same reader). Goal: a backup that works on
that volume and lands outside the phone, and a restore that can read it back.

## Decisions (approved by the user)

- No Supabase / no online service. The file goes wherever the user saves it (iOS Files / iCloud
  Drive via the share sheet).
- Approach: same manual button, rebuilt to stream.

## How it works

- **Backup file v2**: gzip-compressed NDJSON, one JSON object per line: a header line (format,
  `version: 2`, createdAt, origin, settings without API keys, `nexusai*` localStorage copies,
  database version), then per store a store line (name, keyPath, autoIncrement, indexes, count)
  followed by its record lines (`{ s, k, v }`, packed with `packBackupValue`), then an end line
  with the total record count (detects truncated files).
- **Reading**: one store at a time, pages of 25 records (`getAllKeys`/`getAll` with a key range
  and a count, one short transaction per page), streamed into a `CompressionStream`. The whole
  database is never in memory; only the compressed output is. Legacy stores `facts` and
  `vectors` (unread since DB v8, heaviest data) are skipped.
- **Progress**: record counts come first (`count()`, cheap), then « 12 400 / 31 000 éléments ».
- **Saving**: when the file is ready, a button « Enregistrer le fichier (xx Mo) » calls the Web
  Share API with the file (iOS share sheet → « Enregistrer dans Fichiers »); browsers without
  file sharing fall back to a normal download. A user tap is required (share needs a gesture).
- **Last backup**: the date and size of the last saved backup are shown in the section.
- **Restore**: a `.gz` file is read twice as a stream — first to validate everything and count
  (nothing written; a truncated or malformed file is refused), then, after confirmation, to add
  missing records in batches (never deletes, never overwrites). Settings are merged exactly like
  today. Old `.json` (v1) backup files keep working through the existing path.

## Non-goals

No automatic schedule, no online upload, no change to the database schema or settings format.

## Done when

Unit tests prove: pages never exceed 25 records, legacy stores are skipped, API keys are
stripped, a streamed backup round-trips onto a fresh device, a second restore adds nothing, a
truncated file is refused before any write, v1 files still restore. A local run with ~30 000
fake messages completes with bounded memory. Then the user's first real backup on the phone.
