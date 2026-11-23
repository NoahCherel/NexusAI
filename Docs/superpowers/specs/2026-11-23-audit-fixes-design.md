# Audit fixes — short design

Date: 2026-11-23. Source: the repo audit of the same day, re-challenged point by point.

## Intent

Make the app trustworthy before adding live sync: CI that actually runs, no corrupted replies,
no broken visible features, no silent data loss, no dead code. Points 4, 5 and 8 are also
prerequisites for sync (sync needs reliable deletes, visible write failures, and a safe
database version bump).

## Decisions taken with the user

- Anthropic provider: **remove it** (Claude stays reachable through OpenRouter).
- Conversation search: **delete it** (no screen since `25a64dc`).
- `paygo` branch: **keep** (deliberate guard, covered by a test). Point withdrawn.

## Fixes (audit numbering)

1. **CI**: run Prettier on the files CI rejects; CI on Node 22 (Node 20 is end-of-life).
2. **`<think>` leak**: the streaming loop keeps the raw text and parses the whole accumulated
   text (what `parseStreamingChunk` expects, and what the impersonation path already does).
   Usage sentinel extracted from the raw text first. One test with tags split across chunks.
3. **Anthropic**: delete it from the `Provider` type, settings UI, chat and validate routes,
   budget badge and prefill check. A stored Anthropic key / active provider is cleaned on load.
4. **Orphans**: `removeCharacter` deletes the character's conversations (cascade lives in the
   store, both delete buttons use it); the duplicated loop in `page.tsx` goes. Test with
   fake-indexeddb.
5. **Silent write errors**: one shared handler in the stores notifies the user (once per
   session) instead of only `console.error`.
6. **Persistent storage**: request `navigator.storage.persist()` once at startup.
7. **Service worker**: cache only same-origin page navigations; bump the cache name so the
   bloated cache is deleted on activation.
8. **DB version traps**: export `DB_VERSION` and use it in the backup validator; `initDB`
   closes its connection when another tab needs to upgrade (and tells the user to reload).
9. **Conversation search**: delete `src/lib/conversation-search.ts`.
10. **Dead code**: delete the unused UI components and functions listed in the audit (each
    verified to appear only at its own definition). The unused `settings` IndexedDB store
    stays (dropping stores in a migration is unsafe — see the comment in `db.ts`).
11. **Dependencies**: uninstall `react-markdown`, `rehype-raw`, `remark-gfm`, `sonner`,
    `@types/minimatch`.
12. **README**: rewrite for what the app is (local-first, how to run, where data lives,
    `/rescue` and backups).
13. Remove the committed `grep.exe.stackdump`.
15. Replace the three `window.alert` in `page.tsx` with the notification store. The
    `confirm()` in `conversation-transfer.ts` stays (a real yes/no in an async import flow).

## Non-goals

No refactor of `useChatGeneration.ts` / `page.tsx`, no `.gitattributes` line-ending change,
no new features.

## Done when

`format:check`, `lint`, `type-check`, `test` and `build` pass locally, and the CI run on the
pushed branch is green.
