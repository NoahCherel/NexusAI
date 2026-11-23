# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every confirmed point of the 2026-11-23 audit so CI runs, replies are clean, no visible feature is broken and no data is lost silently.

**Architecture:** Small, independent fixes in place. No refactor of `useChatGeneration.ts` or `page.tsx`. Every IndexedDB write still goes through `src/lib/db.ts`; user-facing notices go through the existing notification store in `src/components/ui/api-notification.tsx`.

**Tech Stack:** Next.js 16, React 19, TypeScript, zustand, idb, vitest + fake-indexeddb.

**Spec:** `Docs/superpowers/specs/2026-11-23-audit-fixes-design.md`

## Global Constraints

- Work on branch `fix/audit-2026-11-23`, never on `main`. Commit after each task.
- UI copy in French.
- No new dependency.
- Prettier: 4 spaces, single quotes, `printWidth` 100, `trailingComma: es5` (`.prettierrc`).
- Never drop an IndexedDB object store in a migration (see the v8 comment in `src/lib/db.ts`).
- CI Node version: `22.x`.
- `paygo` in `src/app/api/chat/route.ts` stays untouched.

## Review Focus

- Stopping a reply while the model is still inside `<think>` must save no thought text in the message → test in Task 2.
- A phone whose saved settings still say `activeProvider: 'anthropic'` must come back on OpenRouter with the Anthropic key gone → test in Task 3.
- A tab left open on the old app version must not freeze a newer tab's database upgrade → test in Task 7.
- Fifty failed saves in a row must show one notice, not fifty → test in Task 5.
- Deleting a character must also remove its messages and Chronicle, not only its conversations list → test in Task 4.

---

### Task 1: Make CI green

**Files:**
- Modify: `.github/workflows/ci.yml:15`
- Create: `.prettierignore`
- Reformat: `src/components/character/CharacterCard.tsx`, `src/components/chat/ContextPreviewPanel.tsx`, `src/components/chat/MemoryPanel.tsx`, `src/components/chat/TreeVisualization.tsx`, `src/stores/settings-store.ts` (the files CI rejects)

- [ ] **Step 1: Reproduce the failure**

Run: `npm run format:check`
Expected: FAIL, listing the files above (plus local-only noise: `.impeccable/hook.cache.json` and files with Windows line endings).

- [ ] **Step 2: Fix**

`.prettierignore` contains one line: `.impeccable/` (a local tool cache, absent on CI). Run `npx prettier --write src`. In `ci.yml`, `node-version: [20.x]` → `[22.x]`.

- [ ] **Step 3: Verify**

Run: `npm run format:check`
Expected: `All matched files use Prettier code style!`
Run: `git diff --stat` — only the 5 files above, `ci.yml` and `.prettierignore` show changes (line-ending-only files show none with `core.autocrlf=true`).

- [ ] **Step 4: Commit**

```bash
git add .prettierignore .github/workflows/ci.yml src
git commit -m "ci: fix formatting that kept CI red, move CI to Node 22"
```

---

### Task 2: Stop `<think>` text leaking into saved replies

**Files:**
- Modify: `src/lib/ai/cot-middleware.ts` (add `splitStreamedReply`)
- Modify: `src/hooks/useChatGeneration.ts:752-791` (streaming loop)
- Test: `src/lib/__tests__/cot-middleware.test.ts`

**Interfaces:**
- Produces: `splitStreamedReply(raw: string, provider?: string): { visible: string; thought: string; usage?: ProviderUsage }` — `ProviderUsage` from `@/lib/ai/usage-sentinel`.

- [ ] **Step 1: Write the failing tests** (append to `cot-middleware.test.ts`)

```ts
describe('splitStreamedReply', () => {
    it('never shows thought text when <think> spans several chunks', () => {
        let raw = '';
        for (const chunk of ['<think>I should be', ' sneaky here', '</think>Hello there.']) {
            raw += chunk;
            expect(splitStreamedReply(raw, 'openrouter').visible).not.toContain('sneaky');
        }
        const done = splitStreamedReply(raw, 'openrouter');
        expect(done.visible).toBe('Hello there.');
        expect(done.thought).toContain('I should be sneaky here');
    });

    it('keeps no thought text when the stream stops inside <think>', () => {
        const stopped = splitStreamedReply('Intro. <think>half a thought', 'openrouter');
        expect(stopped.visible).toBe('Intro. ');
        expect(stopped.thought).toBe('half a thought');
    });

    it('extracts the usage sentinel even after an unclosed thought', () => {
        const raw = '<think>all thought\n<|nexus_usage|>{"promptTokens":10,"completionTokens":2}';
        const result = splitStreamedReply(raw, 'openrouter');
        expect(result.usage?.promptTokens).toBe(10);
        expect(result.thought).not.toContain('nexus_usage');
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/__tests__/cot-middleware.test.ts`
Expected: FAIL — `splitStreamedReply` is not exported.

- [ ] **Step 3: Implement `splitStreamedReply` in `cot-middleware.ts`**

Strip the sentinel with `extractUsageSentinel(raw)` first, then `parseStreamingChunk(clean, provider)`; return its `visibleContent`, `thoughtContent` and the sentinel's `usage`.

- [ ] **Step 4: Use it in the streaming loop of `useChatGeneration.ts`**

Keep `let raw = ''`; each chunk does `raw += decoder.decode(value, { stream: true })`, then `const split = splitStreamedReply(raw, activeProvider)`, `fullContent = initialContent + split.visible`, `assistantThought = split.thought`, `usage = split.usage`, then `flushStreamed()` (store flush stays throttled). Drop the now-unused `parseStreamingChunk` import. The later `extractUsageSentinel(fullContent)` / `usage = usage ?? sentinel.usage` lines stay (batch path).

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/__tests__/cot-middleware.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/cot-middleware.ts src/hooks/useChatGeneration.ts src/lib/__tests__/cot-middleware.test.ts
git commit -m "fix(chat): parse the accumulated stream so <think> never leaks into replies"
```

---

### Task 3: Remove the broken Anthropic provider

**Files:**
- Modify: `src/lib/ai/providers.ts:5`, `src/app/api/chat/route.ts:71,111-131`, `src/app/api/validate/route.ts` (anthropic endpoint, header, branch at :60), `src/components/layout/SettingsPanel.tsx:309-333`, `src/components/layout/OpenRouterBudget.tsx:69`, `src/hooks/useChatGeneration.ts:1775`, `src/stores/settings-store.ts:200` (`migrateSettings`), `src/lib/settings-storage.ts:8`
- Test: `src/stores/__tests__/settings-migration.test.ts`

**Interfaces:**
- Produces: `Provider = 'openrouter' | 'openai' | 'nanogpt'`; `SETTINGS_VERSION = 3`.

- [ ] **Step 1: Write the failing test** (add to `settings-migration.test.ts`)

```ts
it('drops the removed Anthropic provider (v2 → v3)', () => {
    const migrated = migrateSettings(
        {
            activeProvider: 'anthropic',
            apiKeys: [
                { provider: 'anthropic', encryptedKey: 'a' },
                { provider: 'openrouter', encryptedKey: 'o' },
            ],
        },
        2
    ) as Record<string, unknown>;
    expect(migrated.activeProvider).toBe('openrouter');
    expect(migrated.apiKeys).toEqual([{ provider: 'openrouter', encryptedKey: 'o' }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/stores/__tests__/settings-migration.test.ts`
Expected: FAIL — `activeProvider` is still `'anthropic'`.

- [ ] **Step 3: Implement**

`migrateSettings`: add a `version < 3` block that maps `activeProvider === 'anthropic'` to `'openrouter'` and filters `apiKeys` entries with `provider === 'anthropic'` (touch neither key when absent, so the existing "v2 store left alone" test keeps passing). Bump `SETTINGS_VERSION` to `3`. Remove `'anthropic'` from the `Provider` type, then delete every branch the compiler flags: the chat-route branch and its `|| provider === 'anthropic'`, the validate-route Anthropic call (keep the generic GET path), the settings button, the budget-badge condition (`activeProvider === 'openrouter'` only), and the prefill check (`activeProvider === 'openrouter' && !/gemini/i.test(activeModel)`). Leave `isAnthropicModel` in `openrouter-request.ts` (it checks model names, not the provider).

- [ ] **Step 4: Verify**

Run: `npm run type-check && npx vitest run src/stores src/lib/__tests__/settings-storage.test.ts src/lib/__tests__/validate-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "fix(providers): remove the Anthropic provider that could never work"
```

---

### Task 4: Deleting a character deletes its conversations everywhere

**Files:**
- Modify: `src/stores/character-store.ts:75-84` (`removeCharacter`)
- Modify: `src/app/chat/page.tsx:727-740` (`confirmDeleteCharacter`)
- Test: `src/stores/__tests__/character-delete.test.ts` (new)

**Interfaces:**
- Consumes: `getConversationsByCharacter(characterId)`, `deleteConversation(id)` from `src/lib/db.ts` (the latter already removes messages, summaries, storyStates, sceneBeats).

- [ ] **Step 1: Write the failing test**

Setup like `conversation-persona.test.ts`: `import 'fake-indexeddb/auto'`, `vi.stubGlobal('indexedDB', new IDBFactory())` and `IDBKeyRange` in `beforeAll`. Seed with `saveCharacter({ id: 'c1', name: 'C', longTermMemory: [] } as never)`, `saveConversation({ id: 'v1', characterId: 'c1', title: 't', createdAt: new Date(0), updatedAt: new Date(0) })`, `saveMessage(...)` for `v1`, `saveSummary(...)` for `v1`.

```ts
it('removes the character, its conversations, messages and Chronicle', async () => {
    await useCharacterStore.getState().removeCharacter('c1');
    expect(await getAllCharacters()).toEqual([]);
    expect(await getConversationsByCharacter('c1')).toEqual([]);
    expect(await getConversationMessages('v1')).toEqual([]);
    expect(await getSummariesByConversation('v1')).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/stores/__tests__/character-delete.test.ts`
Expected: FAIL — conversation and messages are still there.

- [ ] **Step 3: Implement**

`removeCharacter`: delete each conversation from `getConversationsByCharacter(id)` with `deleteConversation`, then the character. Read `const wasActive = get().activeCharacterId === id` **before** `set(...)` and use it for `localStorage.removeItem('nexusai_active_char')` (today the check runs after the reset and is always false). `confirmDeleteCharacter` in `page.tsx` becomes a single `await removeCharacter(character.id)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/stores && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/character-store.ts src/app/chat/page.tsx src/stores/__tests__/character-delete.test.ts
git commit -m "fix(characters): deleting a character also deletes its conversations from the side panel"
```

---

### Task 5: Tell the user when saving fails; no blocking alerts

**Files:**
- Modify: `src/components/ui/api-notification.tsx` (add two helpers)
- Modify: `src/hooks/useChatGeneration.ts:214-217` (use the shared `notifyError`)
- Modify: `src/stores/chat-store.ts` (23 × `.catch(console.error)`), `src/stores/lorebook-store.ts:107,138`
- Modify: `src/app/chat/page.tsx:1024,1086,1135` (`window.alert`)
- Test: `src/lib/__tests__/write-error-notice.test.ts` (new)

**Interfaces:**
- Produces: `notifyError(title: string, detail: string): void` (moved from `useChatGeneration.ts`), `notifyWriteError(error: unknown): void` — logs every call, shows one error notice per page load: title `Enregistrement impossible`, detail `Vos derniers changements ne sont peut-être pas sauvegardés. Téléchargez une sauvegarde globale.`

- [ ] **Step 1: Write the failing test**

```ts
import { notifyWriteError, useNotificationStore } from '@/components/ui/api-notification';

it('shows one notice however many saves fail, and logs each failure', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 50; i++) notifyWriteError(new Error('QuotaExceededError'));
    const notices = useNotificationStore.getState().notifications;
    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe('error');
    expect(log).toHaveBeenCalledTimes(50);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/write-error-notice.test.ts`
Expected: FAIL — `notifyWriteError` is not exported.

- [ ] **Step 3: Implement**

Move `notifyError` into `api-notification.tsx` (same body), import it in `useChatGeneration.ts`. Add `notifyWriteError` with a module-level "already shown" flag. Replace every `.catch(console.error)` in both stores with `.catch(notifyWriteError)`. Replace the three `window.alert(msg)` in `page.tsx` with `notifyError('Action impossible', msg)`. The `confirm()` in `conversation-transfer.ts` stays.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "fix(storage): notify once when saving fails instead of only logging"
```

---

### Task 6: Ask for persistent storage; stop the service worker hoarding

**Files:**
- Modify: `src/hooks/useAppInitialization.ts:22-31`
- Modify: `public/sw.js`

- [ ] **Step 1: Implement**

In `init()`, after `await initDB()`: `void navigator.storage?.persist?.().catch(() => {})`. In `sw.js`: `CACHE_NAME = 'nexusai-v2'` (the existing `activate` handler then deletes the bloated `nexusai-v1`), and the fetch handler returns early unless `request.method === 'GET' && request.mode === 'navigate' && new URL(request.url).origin === self.location.origin` (replaces the `/api/` check).

- [ ] **Step 2: Verify manually** (no unit harness for service workers)

`npm run dev`, open `/chat`, reload twice. DevTools → Application → Cache Storage: only `nexusai-v2`, holding page URLs only (no `/_next/static/…`, no `huggingface.co`). Application → Storage: "persistent" shown as granted or denied without a console error.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAppInitialization.ts public/sw.js
git commit -m "fix(storage): request persistent storage, cache only same-origin pages"
```

---

### Task 7: Make the next database version bump safe

**Files:**
- Modify: `src/lib/db.ts:14-15,90` (export constants; `blocking`/`terminated` handlers)
- Modify: `src/lib/global-backup.ts:12,177` (use the exported constants)
- Test: `src/lib/__tests__/db-version.test.ts` (new)

**Interfaces:**
- Produces: `export const DB_VERSION = 9`, `export const DB_NAME = 'nexusai-db'` from `src/lib/db.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it('lets a newer tab upgrade instead of blocking it', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    await initDB();
    const outcome = await new Promise<string>((resolve) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION + 1);
        req.onblocked = () => resolve('blocked');
        req.onsuccess = () => {
            req.result.close();
            resolve('opened');
        };
    });
    expect(outcome).toBe('opened');
});

it('accepts a backup at the current version and refuses a newer one', () => {
    const backup = (version: number) =>
        JSON.stringify({
            format: 'nexusai-global-backup', version: 1, createdAt: '', origin: '',
            apiKeys: 'reenter-on-restore', settings: null, localStorage: {},
            database: { version, stores: [] },
        });
    expect(() => parseGlobalBackup(backup(DB_VERSION))).not.toThrow();
    expect(() => parseGlobalBackup(backup(DB_VERSION + 1))).toThrow('Version de base incompatible.');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/__tests__/db-version.test.ts`
Expected: FAIL — constants not exported; the first test resolves `'blocked'`.

- [ ] **Step 3: Implement**

Export both constants. In `initDB`'s `openDB` options: `blocking() { dbInstance?.close(); dbInstance = null; }` and `terminated() { dbInstance = null; }` (the old tab's next write then fails visibly through Task 5's notice). `global-backup.ts` imports `DB_NAME`, `DB_VERSION` from `./db` and checks `db.version > DB_VERSION`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/db-version.test.ts src/lib/__tests__/global-backup.test.ts src/lib/__tests__/db-migration-preserves-data.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/global-backup.ts src/lib/__tests__/db-version.test.ts
git commit -m "fix(db): one DB_VERSION for app and backups, never block another tab's upgrade"
```

---

### Task 8: Delete dead code, the dead search feature and unused dependencies

**Files:**
- Delete: `src/lib/conversation-search.ts`, `src/components/ui/badge.tsx`, `src/components/ui/card.tsx`, `src/components/ui/select.tsx`, `src/components/ui/slider.tsx`, `grep.exe.stackdump`
- Modify (delete one symbol each): `src/lib/db.ts` (`getCharacter`, `saveSetting`, `getSetting`, `exportAllData`), `src/lib/ai/embedding-service.ts` (`getEmbeddingModelSignature`, `isCurrentSpace`, `embedTexts`, `isEmbedderReady`, `getEmbedderStatus`), `src/lib/ai/cot-middleware.ts` (`formatThoughtForDisplay`, `supportsReasoning`), `src/lib/ai/message-quality.ts` (`scoreMessageChunk`, `filterQualityMessages`), `src/components/ui/api-notification.tsx` (`notifyAPIStart`, `notifyAPISuccess`, `notifyAPIError`), `src/lib/ai/background-scheduler.ts` (`getBackgroundSchedulerSnapshot`; keep the class's `snapshot()`, tests use it), `src/lib/ai/nanogpt-usage.ts` (`invalidateNanoGPTUsage`), `src/lib/import/url-detector.ts` (`SUPPORTED_IMPORT_HOSTS`), `src/lib/lorebook-extractor.ts` (`LOREBOOK_AUTO_EXTRACT_KEY`), `src/types/chat.ts` (`ChatSettings` and its now-unused `Provider` import)
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Re-confirm nothing uses them**

Run, for each symbol: `grep -rnw <symbol> src public` — expected: only its own definition. Stop and report if any other hit appears.

- [ ] **Step 2: Delete**

Delete the files and symbols, then `npm uninstall react-markdown rehype-raw remark-gfm sonner @types/minimatch` and `git rm grep.exe.stackdump`. The `settings` IndexedDB store stays declared (unused, never dropped).

- [ ] **Step 3: Verify**

Run: `npm run type-check && npm run lint && npm test`
Expected: PASS. Remove any import or variable lint reports as newly unused.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete dead code, the orphaned conversation search and 5 unused dependencies"
```

---

### Task 9: Rewrite the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write it**

Replace the create-next-app text. Sections, short: **What it is** (local-first RP front-end; all data in the browser — IndexedDB + localStorage; the Next server only proxies AI providers and card sites); **Run** (`npm install`, `npm run dev`, or `npm run build && npm start`); **Data & backups** (Réglages → Sauvegardes, the `/rescue` page; API keys must be re-entered on another device); **Do not deploy to a datacenter host** (card imports are blocked by Cloudflare from cloud IPs, and API keys transit the server); **Checks** (`format:check`, `lint`, `type-check`, `test`, `build`, all run by CI). Stack line: Next.js 16, React 19, Tailwind 4, zustand, IndexedDB schema v9.

- [ ] **Step 2: Verify**

Run: `npx prettier --check README.md`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README describing the app as it is"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run every CI check locally**

Run: `npm run format:check && npm run lint && npm run type-check && npm test && npm run build`
Expected: all PASS, build ends with the route list.

- [ ] **Step 2: Push only when the user asks, then confirm CI**

Run: `gh run list --branch fix/audit-2026-11-23 --limit 1`
Expected: `completed success`.
