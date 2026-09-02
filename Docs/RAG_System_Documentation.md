# NexusAI — Memory & Context System

How the app decides what the model sees on every turn: the prompt's three zones, the
**Chronicle** (long-term memory), the **history window** (verbatim messages), and the budget
that arbitrates between them.

> **Naming note.** This file used to describe a "RAG memory system" with three competing
> stores — atomic facts, hierarchical summaries, and vector-searched message chunks. Facts and
> vector chunks were removed entirely (their IndexedDB stores are dropped at DB v8). Long-term
> memory is now the Chronicle alone. Section 12 explains why.

## Table of Contents

1. [Overview](#1-overview)
2. [The three prompt zones](#2-the-three-prompt-zones)
3. [The Chronicle](#3-the-chronicle)
4. [The injected format](#4-the-injected-format)
5. [The history window](#5-the-history-window)
6. [Budget arbitration](#6-budget-arbitration)
7. [Data layer (IndexedDB)](#7-data-layer-indexeddb)
8. [Embeddings, tokenizer, lorebook](#8-embeddings-tokenizer-lorebook)
9. [Settings](#9-settings)
10. [UI surfaces](#10-ui-surfaces)
11. [Export / import](#11-export--import)
12. [What was removed, and why](#12-what-was-removed-and-why)
13. [Tests](#13-tests)
14. [Tuning & troubleshooting](#14-tuning--troubleshooting)
15. [File reference](#15-file-reference)

---

## 1. Overview

A roleplay conversation outgrows any context window. Two mechanisms keep it coherent:

- **The history window** — the most recent messages, verbatim. Truth, but finite.
- **The Chronicle** — a hierarchical summary of everything that fell out of that window.
  Compressed, and the _only_ thing that remembers it.

Both compete for the same budget, so the arbitration between them is the heart of this
document. The design constraint throughout is **prompt caching**: providers only cache a
byte-identical prefix, so the front of the prompt must stay still across turns. Filling the
context to the brim on every turn and caching well are in direct tension; §5 and §6 describe
how that tension is resolved and where the dial sits.

**Key files**

| Concern                               | File                                    |
| ------------------------------------- | --------------------------------------- |
| Prompt assembly (single entry point)  | `src/lib/ai/payload-builder.ts`         |
| Zones, history window, dynamic block  | `src/lib/ai/context-builder.ts`         |
| Chronicle: levels, prompts, rendering | `src/lib/ai/hierarchical-summarizer.ts` |
| Budget fitting helper                 | `src/lib/ai/rag-budget.ts`              |
| Background summarization              | `src/hooks/useBackgroundPipeline.ts`    |
| Lorebook + context preview            | `src/lib/ai/rag-service.ts`             |
| Storage                               | `src/lib/db.ts`                         |

---

## 2. The three prompt zones

`buildConversationPayload` assembles every request — generation, preview and impersonation —
so the three call sites cannot drift apart or double-inject.

```
┌─ STABLE (cache prefix) ─────────────────────────────────────┐
│ system: card, engine block, canon dossiers, arc map,        │
│         mes_example, learned ban list                       │
├─ HISTORY (cache prefix, moves rarely) ──────────────────────┤
│ user/assistant … the verbatim window                        │
├─ DYNAMIC (never cached, re-rendered every turn) ────────────┤
│ [CURRENT CONTEXT]: Chronicle, lorebook, RP journal,         │
│   relationships, [ARC], momentum nudge, scratchpad          │
│ engine contract, preset + card post-history,                │
│ Scene Mode contracts, continue instruction                  │
└─────────────────────────────────────────────────────────────┘
```

`stablePrefixLength` (system + included history) is the `cache_control` anchor sent to the API.
Everything after it is expected to change every turn; everything before it must not.

The dynamic block is built by `buildDynamicContextBlock` and opens with an authority line:

```
Priority of truth: CANON > IN THIS RP > Chronique > Lorebook. On conflict, the higher source wins.
```

---

## 3. The Chronicle

Three levels, each compressing the one below.

| Level | Name (UI)     | Covers                        | Built from   | Threshold               |
| ----- | ------------- | ----------------------------- | ------------ | ----------------------- |
| 0     | Fragment (L0) | ~10 messages (6–15, adaptive) | raw messages | `shouldCreateL0Summary` |
| 1     | Section (L1)  | 5 Fragments ≈ 50 messages     | its L0s      | `L1_THRESHOLD = 5`      |
| 2     | Arc (L2)      | 3 Sections ≈ 150 messages     | its L1s      | `L2_THRESHOLD = 3`      |

### Storage shape

```ts
interface MemorySummary {
    id: string;
    conversationId: string;
    level: 0 | 1 | 2;
    messageRange: [number, number]; // 0-based, END EXCLUSIVE: [0,50] is the first 50
    content: string;
    keyFacts: string[]; // shown in the panel, never injected
    childIds: string[]; // L1 → its L0s, L2 → its L1s. No upward link.
    createdAt: number;
    branchPath?: string[]; // branch lineage at creation time
    isManuallyEdited?: boolean; // hand-rewritten in the memory panel
    editedAt?: number;
}
```

`messageRange` is **end-exclusive**. The UI and the injected text both render it as 1-based
inclusive (`[0,50]` → "messages 1-50"); showing the raw pair read as "msgs 0–10" for the first
ten messages, which was simply wrong.

### Production

`useBackgroundPipeline` runs after each message, on the background model (never the paid RP
model), gated by `enableHierarchicalSummaries`. One run produces at most one L0, then one L1,
then one L2.

Chunk size is adaptive (`getAdaptiveChunkSize`): dense, high-quality messages summarize in
groups of 6; thin ones in groups of 15.

**Catch-up.** Normally the pipeline runs far ahead of eviction. It can fall behind — memory
switched off for a while, no API key when those messages arrived, repeated background
failures, a long imported conversation. Messages that leave the verbatim window without ever
being summarized are gone from the model's memory entirely; nothing else covers them now.
So when `evictedCount > coveredCount`, the pipeline produces up to `CATCHUP_L0_PER_RUN = 3`
Fragments per run instead of one, and `buildChronicle` reports the gap as
`stats.uncoveredEvictedMessages` (surfaced as a warning in the context preview).

### Prompts

`SUMMARIZATION_PROMPT_L1` / `_L2` ask for real substance — 150–250 words for a Section,
250–350 for an Arc — and say why: _once the raw messages scroll out of the context window,
this text is all that remains of them_. They used to be capped at "Max 2-3 sentences", which
is what made long roleplays feel amnesiac: 50 messages compressed into two lines.

All three levels carry `Write in the SAME LANGUAGE as the source material`. Without it a
French roleplay produced English summaries, injected into an otherwise French prompt.

Each prompt asks for coverage of: actions and consequences · decisions and by whom · named
people, places, objects · relationship shifts · **what is left unresolved**. Output is JSON
(`{summary, keyFacts}`); `parseSummarizationResponse` falls back to raw text if the model
doesn't comply.

---

## 4. The injected format

This is the part that most affects output quality, and the part that was most broken.

The old rendering was flat: `📖 Story Arc:` followed by `📝 Recent Events:`, no ranges, no
nesting. An Arc and the Sections underneath it describe **the same 150 messages** at different
zoom levels — and nothing in that format said so. The model could read them as two separate
runs of events and narrate the same beat twice.

`buildChronicle` renders the pyramid as a pyramid:

```
[CHRONICLE — what has already happened in this story, oldest first.
The levels OVERLAP: an Arc summarizes the SAME period as the Sections nested under it, only
more compressed; a Section summarizes the SAME period as its Fragments. NEVER treat an Arc and
its Sections as two different sequences of events — they are one sequence at two zoom levels.
The most recent messages appear in full in the conversation above.]

■ ARC 1 — messages 1-150
<arc text>

  ▸ Section 1 — messages 1-50
  <section text>

  ▸ Section 2 — messages 51-100
  (this period is covered by the Arc above)

  ▸ Section 3 — messages 101-150
  <section text>

■ ARC 2 — messages 151-210
<arc text>

  ▸ Section 4 — messages 151-200
  <section text>

▸ Recent fragments — messages 201-214
<L0 texts>
```

Three things carry the meaning:

- **The preamble** states the overlap explicitly.
- **Every entry carries its message range**, so overlap is verifiable rather than implied.
- **Nesting is visual and ordered**, so containment is unambiguous.

Two markers handle the edges:

- `(this period is covered by the Arc above)` — a Section dropped for budget. The model sees
  there is no hole, just a coarser zoom.
- `(the end of this period also appears in full above)` — a Section straddling the eviction
  boundary. Harmless overlap, now stated rather than hidden.

The block is in English, like the rest of the assembled prompt (`[CURRENT CONTEXT]`, `[ARC]`,
`[IN THIS RP]`). The summaries nested inside are in the roleplay's own language.

**Coverage is computed from `messageRange`, not `childIds`.** The old code walked
Arc → Section → Fragment through `childIds` on an already-filtered array: if the intermediate
Section had been filtered out, its Fragments were reported "uncovered" and the Arc was
re-injected together with its own Fragments. Range containment has no such failure mode.

---

## 5. The history window

`buildRAGEnhancedPayload` chooses how many recent messages fit. This is where the
"context isn't full" bug lived.

### The bug

The window was sized against `maxContext − system − output − postHistory`, using **this
turn's** post-history. That block swings hard from turn to turn — Chronicle, lorebook, RP
journal, relationships, arc, a one-shot momentum nudge, a regenerated scratchpad, Scene Mode
contracts. On overflow the window was refit to 75% of that budget and the anchor
(`historyCutMessageId`) was persisted — and **the anchor could only ever move forward**.

So the single fattest turn in a conversation set the window size for every turn after it. A
momentum nudge injected once cost history permanently. Measured fill on a 16k preset: **~69%**.

### The fix: two budgets

```ts
const room = maxContextTokens - systemTokens - maxOutputTokens;
const reserveForSizing = min(dynamicReserveTokens ?? postHistoryTokens, room * 0.45);
const availableSized = room - reserveForSizing; // CHOOSES the window
const availableActual = room - postHistoryTokens; // hard constraint: must fit
```

`dynamicReserveTokens` is a **measured, smoothed** size of the dynamic zone, persisted on the
conversation and updated as an exponential moving average (`RESERVE_ADAPT_RATE = 0.35`).

Deliberately _not_ a high-water mark: jumping straight to a spike's size would let one fat turn
shrink the window for the ~30 turns it took to decay back — a slower version of the very
ratchet this replaces. Deliberately _not_ predicted either (summing granted budgets):
the dynamic zone almost never spends what it is allowed, so a predicted reserve over-reserves
massively.

### Three cases

| Case                | Condition                                    | Action                                         | Anchor persisted |
| ------------------- | -------------------------------------------- | ---------------------------------------------- | ---------------- |
| Structural overflow | `total > availableSized`                     | refit to `historyTarget`                       | **yes**          |
| Transient spike     | fits `availableSized`, not `availableActual` | trim just enough for this request              | **no**           |
| Fits                | otherwise                                    | unchanged, or expand if the trigger is crossed | yes if expanded  |

**The transient case is what kills the ratchet.** A one-off spike is absorbed without ever
anchoring the window low; the next normal turn gets the full window back.

**Expansion** reaches back into the past by a _block_ when room opens up durably. It is what
repairs conversations whose anchor was cut under the old rule — they carry no stored reserve,
so the first turn after the upgrade sizes against a full budget and reclaims history in one
step (one cache miss, once).

### The anti-ping-pong invariant

Right after a cut, free space equals `growthHeadroom` exactly. Any expansion trigger at or
below it would re-expand on the very next turn and thrash the cache prefix forever. So:

```ts
const expandTrigger = Math.max(
    availableSized * EXPAND_TRIGGER_RATIO,
    growthHeadroom + avgMsg * MIN_EXPAND_MESSAGES // > growthHeadroom, always
);
```

The max makes it impossible by construction, whatever the ratio says. This is guarded by the
`does not thrash when the dynamic zone oscillates` test.

### Growth headroom, in messages

The margin's only job is to absorb the ~2 messages added per turn. That is not a quantity
proportional to context size: as a flat 25% it left 10k tokens empty on a 40k context to
absorb ~600 tokens of growth. It is now `avgMsg × HEADROOM_MESSAGES`, clamped by ratio bounds.

### Measured result

120 simulated turns, 16k context, volatile dynamic zone (900–1700 tk, periodic 2200 tk spikes):

| Profile                                         | History fill (steady) | Worst turn | Prefix breaks / 120 turns      |
| ----------------------------------------------- | --------------------- | ---------- | ------------------------------ |
| **Max fill** (`HEADROOM_MESSAGES: 4`) — current | **94.4%**             | 88.9%      | 42 (~1 per 2.9 turns)          |
| Cache-friendly (`HEADROOM_MESSAGES: 8`)         | 90.7%                 | 80.9%      | 24 (~1 per 5 turns)            |
| Before this change                              | ~69%                  | —          | rare, but permanently degraded |

Total context engagement under the current profile: **95.4%** steady state, 89.9% worst turn.

To switch profiles, edit `HISTORY_WINDOW_TUNING` in `context-builder.ts`: set
`HEADROOM_MESSAGES: 8`, `HEADROOM_MIN_RATIO: 0.08`, `HEADROOM_MAX_RATIO: 0.25`.

---

## 6. Budget arbitration

Order of operations in `buildConversationPayload`:

1. Build the system prompt → `systemTokens` is now known.
2. `available = maxContext − system − output`.
3. **Chronicle budget = `available × 0.30`** (skipped below 50 tokens). History keeps ~70%.
4. `buildChronicle(budget)` returns text guaranteed to cost ≤ budget.
5. Assemble the dynamic block (Chronicle + lorebook + journal + contracts).
6. Size and fill the history window against what's actually left (§5).

The old formula had a floor expressed against the **total** context (15%), which ignored how
much room was really left: a small context plus a big card could starve history to zero
messages. A flat share of the remaining room cannot do that.

### Chronicle degradation, most to least essential

What gets dropped first is what the Arc above it already covers.

1. **Bridging Fragments** — the stretch between the last Section and the verbatim window. A
   hole here is the worst possible one: it sits immediately before what the model can see.
   Capped at 40% of the Chronicle budget.
2. **Every Arc** — the spine, few and compressed. If even those don't fit, the oldest are
   dropped and announced: `[Arcs 1-5 — messages 1-750: omitted for space]`.
3. **Sections**, newest first, with whatever remains. Omitted ones show the placeholder line.

Selection uses `fitRankedBlock` (`rag-budget.ts`), which fits a ranked list by dropping the
tail. It replaces the old all-or-nothing test (`if (tokens <= remaining)`) that threw away
100% of a block for a one-token overshoot. After assembly, the real token count is verified
and the oldest Section shed until it fits — per-entry estimates can undershoot once everything
is joined, because BPE merges across joins.

Sizing figures, Sections ≈ 280 tk and Arcs ≈ 420 tk:

| Context | `available` | Chronicle budget | Roughly             |
| ------- | ----------- | ---------------- | ------------------- |
| 8k      | ~4100       | ~1240            | 2 Arcs + 1 Section  |
| 16k     | ~12300      | ~3700            | 3 Arcs + 8 Sections |
| 32k     | ~28000      | ~8400            | full pyramid        |

---

## 7. Data layer (IndexedDB)

Database `nexusai-db`, **version 8**.

| Store             | Key               | Indexes                        |
| ----------------- | ----------------- | ------------------------------ |
| `characters`      | `id`              | `by-name`                      |
| `conversations`   | `id`              | `by-character`                 |
| `messages`        | `id`              | `by-conversation`              |
| `summaries`       | `id`              | `by-conversation`, `by-level`  |
| `lorebookHistory` | `id`              | `by-character`, `by-timestamp` |
| `settings`        | `key`             | —                              |
| `canon`           | `work::character` | `by-work`                      |
| `arcOutlines`     | `work`            | —                              |

**v8 migration is destructive and intentional.** It calls `deleteObjectStore` on `facts` and
`vectors`. Neither has a reader any more, and their embeddings (hundreds of floats per row)
were by far the heaviest thing on disk — dropping the stores is the only way to reclaim that
space. Existing exports are unaffected: they never contained either.

`deleteConversation` now also deletes the conversation's summaries. They used to outlive their
conversation forever.

Summary API: `saveSummary` (upsert — also the update path: read, patch, write back),
`getSummariesByConversation`, `deleteSummary`, `deleteSummariesByConversation`.

---

## 8. Embeddings, tokenizer, lorebook

**Embeddings** (`embedding-service.ts`) are still used, but _only_ by the hybrid lorebook
search, which embeds lorebook entries and the query. It never touched the message-vector
store, so removing that store did not affect it. Summaries no longer carry an `embedding`
field — it was computed and persisted on every summary and never once read.

**Tokenizer** (`tokenizer.ts`) is real BPE (`gpt-tokenizer`, cl100k_base), not a
characters÷4 heuristic; the heuristic survives only as a `catch` fallback. `countMessageTokens`
memoizes per message id + content hash (BPE over a long history costs hundreds of ms at the
exact moment the user hits send).

**Lorebook** (`resolveActiveLorebookEntries`) honours the preset's `useLorebooks`, runs a
hybrid keyword + semantic search, and falls back to the pure keyword scan on error.
`extraScanText` feeds it the other memory systems' injected text (canon dossiers, RP journal,
relationships) so entries fire on names those systems bring up, not just on recent messages.

Where the lorebook is rendered depends on the preset template: inside the system prompt when it
contains `{{lorebook}}`, in the dynamic zone otherwise (`templatePlacesLorebook`). The context
preview needs this to know where those tokens are already counted.

---

## 9. Settings

| Setting                                | Default                                 | Effect                                                                                             |
| -------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `enableHierarchicalSummaries`          | `true`                                  | **The whole long-term memory.** Off = the model is amnesiac about anything that leaves the window. |
| `enableScratchpad`                     | `false`                                 | Per-response `<scratchpad>`; costs output tokens and invalidates caching.                          |
| `maxContextTokens` / `maxOutputTokens` | per preset (8192 / 2048 for _Balanced_) | The budget.                                                                                        |
| `lorebookTokenBudget`                  | 2000 (generation)                       | Lorebook share of the dynamic zone.                                                                |

`enableRAGRetrieval` and `enableFactExtraction` were removed. The first was redundant — with
no summaries the Chronicle is empty, and without injection it is useless, so two switches
gated one thing. The second belonged to a system that no longer exists. `minRAGConfidence`
scored facts and chunks; both are gone.

---

## 10. UI surfaces

### Memory panel (`MemoryPanel.tsx`)

Five tabs: Notes, Guidage, Scratchpad, Style, **Résumés**. The Faits tab is gone.

The Résumés tab is now editable:

- **Edit** (pencil) — inline textarea. Saving stamps `isManuallyEdited` + `editedAt` and shows
  a "modifié à la main" badge.
- **Regenerate** (sparkles, L1/L2 only) — rebuilds one summary from its `childIds` on the
  background model. Necessary rather than decorative: improving the prompts does nothing to
  summaries already written, and the only other route is a full re-index. Regenerating clears
  the manual-edit flag — the text is machine-written again. L0 has no button: it is built from
  raw messages, not from child summaries.
- **Key facts** — collapsible list. Stored since forever, never displayed until now.
- **Ranges** — rendered 1-based inclusive.
- **Re-index** — destroys and rebuilds the whole Chronicle. The confirmation dialog now counts
  the hand-edited summaries that will be lost. It also uses the adaptive chunk size, matching
  the live pipeline (it used a fixed 10, producing a Chronicle that didn't line up).

### Context preview (`ContextPreviewPanel.tsx`)

Shows every section with its token cost, plus:

- **Two-segment budget bar** — input actually sent, then the slice reserved for the reply.
  One bar made a mostly-empty context look fuller than it was.
- **History window panel** — used / budget with a fill bar, refit target, dynamic reserve,
  recoverable messages, and a plain-French sentence for the decision taken
  (`Inchangée — préfixe en cache`, `Recoupée`, `Élargie`, `Rognage temporaire`).
- **Chronicle line** — arcs, sections and fragments injected, and how many were omitted.
- **`countedIn` badges** — see below.

### The preview used to over-count

Three separate double-counts inflated the total:

- The canon section re-counted `[CANON — …]` blocks already inside the system prompt.
- The Chronicle was counted as its own section _and_ inside the post-history block containing
  it.
- History was counted on a display transcript decorated with localized role labels, while the
  payload builder counted raw content per message.

Sections that merely display material counted elsewhere now carry
`countedIn: 'system' | 'post-history'` and contribute **zero** to the total, with a badge
saying where. Without the badge, a 900-token section that no longer adds up reads as a bug.

Consequence worth knowing: **the displayed total dropped** after this fix. The real fill was
always lower than the panel claimed.

---

## 11. Export / import

`exportConversationForCharacter` bundles the card subset, the conversation (including
`relationships` and `summaries`), and the messages.

The Chronicle is exported because it _is_ the long-term memory, it can be edited by hand, and
rebuilding it costs dozens of background calls.

On import, `remapSummariesForImport` mints a new id for every summary and rewrites `childIds`
through the same old→new table. Left as-is they would point at ids that don't exist in the new
conversation, and an Arc would render as though it covered no Sections. Children missing from
the export are dropped rather than left dangling. Exports without a `summaries` field — every
file produced before this change — import normally.

---

## 12. What was removed, and why

### Atomic facts (`WorldFact`)

A background model extracted 3–5 "atomic facts" per notable response, embedded each one, and
injected the top-10 by cosine similarity as `🔍 Relevant Past Events`.

Removed because it duplicated the Sections without being readable or editable, cost one
background call per message, and — critically — the model could not tell that a fact, the
Section covering the same beat, and the Arc above it were the same event three times.

### Vector chunk retrieval

L0 summaries were also written into a `vectors` store and retrieved by similarity as
`📜 Related Past Scenes`. Same duplication problem, plus an embedding write per summary.

### The trade-off, honestly

Facts and chunks gave _similarity-targeted_ recall: a precise detail from 400 messages ago
could resurface if the current message happened to match it. The Chronicle gives _narrative
continuity_. Substantial Sections cover the second use well and the first adequately — but a
minor detail the chronicler chose not to keep is gone for good.

What was gained: memory that is predictable, fully readable, editable by hand, exportable, and
whose overlap is explicit to the model. And one less background call per message.

This is reversible — nothing about the Chronicle prevents reintroducing a vector index later.

---

## 13. Tests

`npx vitest run`

| File                            | Covers                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `prompt-cache.test.ts`          | Zone layout, **the cache-prefix contract**, window refit/expand/spike/starvation |
| `chronicle.test.ts`             | Nesting, ranges, degradation, budget ceiling, branch filter, coverage gap        |
| `rag-budget.test.ts`            | `fitRankedBlock`: tail-dropping, one-token overshoot, hard ceiling               |
| `conversation-transfer.test.ts` | `childIds` remapping, hand-edit flag, empty Chronicle                            |
| `card-fields.test.ts`           | Chronicle budget vs history starvation                                           |
| `post-beat-analyses.test.ts`    | One relationship pass per beat (`skipBeatAnalyses`)                              |

Two assertions matter more than the rest:

**`cuts a whole block on overflow and reuses the anchor on later turns`** is the cache-prefix
contract. It passed unmodified through this entire change and must keep doing so — it is what
proves the window doesn't move every turn.

**`does not thrash when the dynamic zone oscillates turn to turn`** (≤ 2 anchor moves over 20
oscillating turns) is what separates this design from a naive symmetric hysteresis, which
would produce ~10.

The old fill assertion allowed anything between 35% and 75% of budget — wide enough that a
regression filling 36% passed. It now requires the window to stop **within one message** of
its target.

---

## 14. Tuning & troubleshooting

**"The context still isn't full."** Open the context preview and read the _Fenêtre
d'historique_ panel: `Utilisé / budget` is the real fill. If the budget itself is small, the
dynamic zone is eating it — check `réserve dynamique` against the 45% cap and reduce
`lorebookTokenBudget`. If fill is low but free space is large, the panel says whether the
window will widen next turn.

**"The model forgot something that happened."** Check the Chronicle line in the preview.
`N section(s) omises faute de place` means it was dropped for budget — the Arc still covers the
period, more coarsely. A `⚠️ N message(s) sont sortis de la fenêtre sans avoir été résumés`
warning means real loss: the pipeline was behind. Catch-up is automatic (3 Fragments per run).

**"Summaries are too shallow."** They predate the rewritten prompts. Regenerate the Arc or
Section from the memory panel, or re-index (which discards hand edits — the dialog counts
them).

**"My prompt cache hit rate dropped."** Expected: the max-fill profile recuts every ~3 turns.
§5 has the numbers and the one-line switch back.

**Constants worth knowing**

| Constant                        | Value               | File                         |
| ------------------------------- | ------------------- | ---------------------------- |
| `RESERVE_MAX_RATIO`             | 0.45                | `context-builder.ts`         |
| `RESERVE_ADAPT_RATE`            | 0.35                | `context-builder.ts`         |
| `HEADROOM_MESSAGES`             | 4                   | `context-builder.ts`         |
| Chronicle budget share          | 0.30 of `available` | `payload-builder.ts`         |
| `L1_THRESHOLD` / `L2_THRESHOLD` | 5 / 3               | `hierarchical-summarizer.ts` |
| `CATCHUP_L0_PER_RUN`            | 3                   | `useBackgroundPipeline.ts`   |

---

## 15. File reference

```
src/lib/ai/
  payload-builder.ts        Single assembly point; Chronicle budget
  context-builder.ts        Zones, dynamic block, HISTORY WINDOW, tuning constants
  hierarchical-summarizer.ts  Levels, thresholds, prompts, buildChronicle
  rag-budget.ts             fitRankedBlock
  rag-service.ts            Lorebook resolution, buildContextPreview
  embedding-service.ts      Embeddings (lorebook only)
  post-beat.ts              Arc capture, momentum, relationship analyst
src/hooks/
  useBackgroundPipeline.ts  Auto-summary L0→L1→L2, catch-up
  useChatGeneration.ts      Generation flow, window-state persistence
src/lib/
  db.ts                     IndexedDB v8
  tokenizer.ts              BPE counting + memoization
  conversation-transfer.ts  Export / import incl. Chronicle
  rag-data-loader.ts        Panel loader
src/components/chat/
  MemoryPanel.tsx           Chronicle editing / regeneration / re-index
  ContextPreviewPanel.tsx   Sections, budget bar, history-window panel
src/types/
  rag.ts                    MemorySummary, ContextSection
  chat.ts                   Conversation.historyCutMessageId, .dynamicReserveTokens
```
