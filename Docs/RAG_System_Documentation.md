# NexusAI — RAG Memory System Documentation

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Data Layer (IndexedDB)](#3-data-layer-indexeddb)
4. [Embedding Service](#4-embedding-service)
5. [Tokenizer](#5-tokenizer)
6. [Hierarchical Summarization](#6-hierarchical-summarization)
7. [Fact Extraction](#7-fact-extraction)
8. [RAG Retrieval](#8-rag-retrieval)
9. [Context Builder](#9-context-builder)
10. [Lorebook System](#10-lorebook-system)
11. [Settings & Toggles](#11-settings--toggles)
12. [Reindex Feature](#12-reindex-feature)
13. [Context Preview Panel](#13-context-preview-panel)
14. [Memory Panel (UI)](#14-memory-panel-ui)
15. [Token Budget Management](#15-token-budget-management)
16. [Data Flow Diagrams](#16-data-flow-diagrams)
17. [File Reference](#17-file-reference)
18. [Improvement Proposals](#18-improvement-proposals)

---

## 1. Overview

NexusAI is a roleplay chat application built with **Next.js 16**, **Zustand**, and **IndexedDB**. It features a comprehensive **RAG (Retrieval-Augmented Generation) memory system** that gives the AI persistent long-term memory across conversations.

### Core Problem Solved

LLMs have a finite context window (8k–128k tokens). For roleplay conversations that span hundreds of messages, early events are lost when the context fills up. The RAG system ensures the AI always has access to:

- **Summaries** of past events (hierarchical L0/L1/L2)
- **Key facts** (relationships, items, locations, consequences)
- **Semantically relevant** past message chunks

### Key Technologies

| Component        | Technology                                      |
| ---------------- | ----------------------------------------------- |
| Framework        | Next.js 16.1.1 (App Router, Turbopack)          |
| State Management | Zustand 5.0.9                                   |
| Database         | IndexedDB via `idb` 8.0.3                       |
| Tokenizer        | `gpt-tokenizer` (cl100k_base encoding)          |
| Embeddings       | `@xenova/transformers` (all-MiniLM-L6-v2, 384d) |
| AI APIs          | OpenRouter, OpenAI, Anthropic                   |
| Tests            | Vitest 4.0.18 (56 tests)                        |

---

## 2. Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CHAT PAGE                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Message   │  │ Context  │  │ Memory   │  │ Settings   │  │
│  │ Display   │  │ Preview  │  │ Panel    │  │ Panel      │  │
│  └─────┬────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│        │            │             │               │          │
│  ┌─────▼────────────▼─────────────▼───────────────▼──────┐  │
│  │              STATE MANAGEMENT (Zustand)                 │  │
│  │   chat-store │ character-store │ settings-store │ ...  │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │                   AI SERVICE LAYER                      │  │
│  │  ┌────────────┐ ┌────────────┐ ┌──────────────────┐   │  │
│  │  │ Context    │ │ RAG        │ │ Hierarchical     │   │  │
│  │  │ Builder    │ │ Service    │ │ Summarizer       │   │  │
│  │  └────────────┘ └────────────┘ └──────────────────┘   │  │
│  │  ┌────────────┐ ┌────────────┐ ┌──────────────────┐   │  │
│  │  │ Fact       │ │ Embedding  │ │ Lorebook         │   │  │
│  │  │ Extractor  │ │ Service    │ │ Extractor        │   │  │
│  │  └────────────┘ └────────────┘ └──────────────────┘   │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │              DATA LAYER (IndexedDB v5)                  │  │
│  │   messages │ vectors │ summaries │ facts │ characters  │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Request Flow (User Sends Message)

```
User types message
       │
       ▼
  handleSend()
       │
       ├──► Lorebook Extraction on PREVIOUS assistant message
       │    (only the active branch/regeneration gets extracted)
       │
       ▼
  triggerAiReponse()
       │
       ├──1── Hybrid Lorebook Search (keyword + semantic)
       │
       ├──2── Build System Prompt (template + lorebook + world state)
       │
       ├──3── RAG Retrieval (summaries + facts + vectors)
       │      Budget: max(25% remaining, 15% total context)
       │
       ├──4── Build RAG-Enhanced Payload (system + RAG + history)
       │      History filled newest-to-oldest until budget exhausted
       │
       ├──5── Stream AI Response
       │
       └──6── Background Post-Processing:
              ├── World State Analysis
              └── Fact Extraction (if enabled, not on regeneration)
```

---

## 3. Data Layer (IndexedDB)

### Database: `nexusai-db` (v5)

| Store             | keyPath | Indexes                                           | Purpose                                           |
| ----------------- | ------- | ------------------------------------------------- | ------------------------------------------------- |
| `characters`      | `id`    | `by-name`                                         | Character cards (name, personality, avatar, etc.) |
| `conversations`   | `id`    | `by-character`                                    | Conversation metadata + world state               |
| `messages`        | `id`    | `by-conversation`                                 | Individual messages with branching support        |
| `lorebookHistory` | `id`    | `by-character`, `by-timestamp`                    | Lorebook snapshots                                |
| `settings`        | `key`   | —                                                 | Persistent settings                               |
| `vectors`         | `id`    | `by-conversation`                                 | Embedded message chunks for semantic search       |
| `summaries`       | `id`    | `by-conversation`, `by-level`                     | Hierarchical summaries (L0/L1/L2)                 |
| `facts`           | `id`    | `by-conversation`, `by-category`, `by-importance` | Extracted world facts                             |

### Schema Migrations

- **v2 → v3**: Extracted embedded `messages[]` from conversations into a dedicated `messages` store.
- **v3 → v4**: Added `messageOrder` and `regenerationIndex` fields for tree-based branching.
- **v4 → v5**: Added RAG stores (`vectors`, `summaries`, `facts`).

### Key Data Types

```typescript
// Vector Entry — embedded message chunk
interface VectorEntry {
    id: string;
    conversationId: string;
    messageIds: string[];
    text: string;
    embedding: number[]; // 384-d vector
    metadata: {
        timestamp: number;
        characters: string[];
        location: string;
        importance: number; // 1–10
        tags: string[];
    };
}

// Memory Summary — hierarchical
interface MemorySummary {
    id: string;
    conversationId: string;
    level: 0 | 1 | 2; // L0=chunk, L1=section, L2=arc
    messageRange: [number, number];
    content: string;
    keyFacts: string[];
    embedding?: number[];
    childIds: string[]; // L1 → L0 children, L2 → L1 children
    createdAt: number;
}

// World Fact — extracted knowledge
interface WorldFact {
    id: string;
    conversationId: string;
    messageId: string;
    fact: string;
    category: 'event' | 'relationship' | 'item' | 'location' | 'lore' | 'consequence' | 'dialogue';
    importance: number; // 1–10
    active: boolean;
    timestamp: number;
    embedding?: number[];
    relatedEntities: string[];
    lastAccessedAt: number;
    accessCount: number;
}
```

---

## 4. Embedding Service

**File**: `src/lib/ai/embedding-service.ts`

### Model

- **Primary**: `Xenova/all-MiniLM-L6-v2` (~6 MB quantized, runs entirely in-browser)
- **Output**: 384-dimensional dense vectors
- **Input truncation**: 512 characters
- **Fallback**: TF-IDF/BM25 hash-based embedding (unigrams + bigrams → 384-d hashed vector, L2-normalized)

### Caching

- In-memory `Map<string, number[]>`, keyed on first 200 chars
- Max 500 entries (FIFO eviction)

### Key Functions

| Function                              | Description                                   |
| ------------------------------------- | --------------------------------------------- |
| `initEmbedder()`                      | Lazy-loads the ML pipeline, returns `boolean` |
| `embedText(text)`                     | Single text → `number[]`                      |
| `embedTexts(texts)`                   | Batch embedding (sequential to avoid OOM)     |
| `cosineSimilarity(a, b)`              | Cosine similarity between two vectors         |
| `findTopK(query, items, k, minScore)` | Top-K cosine search over any collection       |

### Status: `'idle' | 'loading' | 'ready' | 'fallback'`

---

## 5. Tokenizer

**File**: `src/lib/tokenizer.ts`

- **Library**: `gpt-tokenizer`
- **Encoding**: `cl100k_base` (GPT-4 / GPT-3.5-turbo compatible)
- **Fallback**: `Math.ceil(text.length / 4)` if encoding fails

### Functions

| Function                                 | Description                                     |
| ---------------------------------------- | ----------------------------------------------- |
| `countTokens(text)`                      | Exact token count                               |
| `countTokensBatch(texts)`                | Sum of individual counts                        |
| `truncateToTokenBudget(text, maxTokens)` | Binary search for longest prefix fitting budget |

---

## 6. Hierarchical Summarization

**File**: `src/lib/ai/hierarchical-summarizer.ts`

The summarization system creates a pyramid of summaries at three levels of abstraction.

### Summary Hierarchy

```
              ┌──────────────┐
              │   L2 (Arc)   │  ~150 messages
              │  Story arcs  │
              └──────┬───────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐
   │ L1 (Sec) │ │ L1 (Sec) │ │ L1 (Sec) │  ~50 messages each
   │ Sections │ │ Sections │ │ Sections │
   └─────┬────┘ └─────┬────┘ └─────┬────┘
         │            │            │
    ┌────┼────┐  ┌────┼────┐  ┌────┼────┐
    ▼    ▼    ▼  ▼    ▼    ▼  ▼    ▼    ▼
  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ...
  │L0│ │L0│ │L0│ │L0│ │L0│ │L0│ │L0│ │L0│     10 messages each
  └──┘ └──┘ └──┘ └──┘ └──┘ └──┘ └──┘ └──┘
```

### Trigger Rules

| Level            | Trigger Condition        | Covers                   |
| ---------------- | ------------------------ | ------------------------ |
| **L0** (chunk)   | Every **10 messages**    | ~10 consecutive messages |
| **L1** (section) | Every **5 L0** summaries | ~50 messages             |
| **L2** (arc)     | Every **3 L1** summaries | ~150 messages            |

### Processing

1. **Automatic**: A `useEffect` in `page.tsx` runs after each message change. Gated by `enableHierarchicalSummaries` setting.
2. **Model**: `deepseek/deepseek-r1-0528:free` (via OpenRouter)
3. **Output format**: JSON `{ "summary": "...", "keyFacts": ["..."] }`
4. **Side effects**: L0 summaries also generate vector embeddings and extract facts from key facts.

### Deduplication

- **Jaccard word overlap**: Computes word-level overlap (words > 3 chars) between summaries.
- **Threshold**: 60% overlap → treated as duplicate, skipped.

---

## 7. Fact Extraction

**File**: `src/lib/ai/fact-extractor.ts`

### Categories

| Category       | Description                    | Color (UI) |
| -------------- | ------------------------------ | ---------- |
| `event`        | Story events, actions taken    | Blue       |
| `relationship` | Character relationships, bonds | Pink       |
| `item`         | Objects, inventory, artifacts  | Amber      |
| `location`     | Places, settings, geography    | Green      |
| `lore`         | World rules, lore, backstory   | Purple     |
| `consequence`  | Results of actions, promises   | Red        |
| `dialogue`     | Important spoken statements    | Cyan       |

### Extraction Flow

```
AI Response → Fact Extraction Prompt → LLM (llama-3.3-70b-instruct:free)
                                          │
                                          ▼
                                    JSON Array of facts
                                          │
                                          ▼
                               Parse & Validate each fact
                                          │
                                          ▼
                            Deduplicate against existing facts
                                          │
                                          ▼
                               Embed facts (384-d vectors)
                                          │
                                          ▼
                             Save to IndexedDB `facts` store
```

### Deduplication Rules

1. **Exact match**: Case-insensitive string comparison on `fact` field.
2. **Semantic similarity**: If ≥2 entity overlap AND same category → compute Jaccard word overlap → if >60%, it's a duplicate.

### Importance Scoring

Built-in `heuristicImportance()` fallback using keyword patterns:

- **High** (≥7): kill, die, betray, secret, wedding, pregnant, war...
- **Medium** (≥5): attack, fight, steal, find, discover, escape...
- **Low** (≥2): say, ask, smile, walk, look...
- **Bonuses**: +1 for >500 chars, +2 for >1000 chars

### Gating

- Disabled on **regeneration** and **continue** (via `skipFactExtraction` option)
- Toggled globally via `enableFactExtraction` setting

---

## 8. RAG Retrieval

**File**: `src/lib/ai/rag-service.ts`

### `retrieveRelevantContext(queryText, conversationId, tokenBudget, options)`

The main retrieval function builds context sections in priority order:

```
Token Budget Distribution:
┌─────────────────────────────────────────┐
│  30%: Summaries (max 300 tokens)        │  Priority 1
│  Remaining: Facts via vector search     │  Priority 2
│  Remaining: Message chunks via vectors  │  Priority 3
└─────────────────────────────────────────┘
```

### Retrieval Pipeline

1. **Embed query** → 384-d vector
2. **Summary retrieval**: `getBestContextSummary()` — picks highest-level available summary within 30% budget (max 300 tokens). Deduplicates by word overlap.
3. **Fact retrieval**: Vector search over all active facts. Top 10 by cosine similarity. Updates access metadata (recency/frequency tracking).
4. **Chunk retrieval**: Vector search over indexed message chunks. Top 5 by combined score.

### Combined Scoring (Chunks & Facts)

```
combinedScore = 0.5 × cosineSimilarity
             + 0.25 × (importance / 10)
             + 0.25 × temporalDecay
```

### Temporal Decay

Exponential decay with importance-based half-life:

- Importance ≥ 8 → half-life = 720 hours (30 days)
- Importance ≥ 5 → half-life = 168 hours (7 days)
- Otherwise → half-life = 48 hours (2 days)

**Boosts**:

- Recency: 1.5× if accessed within 1 hour
- Frequency: `1 + min(accessCount × 0.1, 0.5)`

### Hybrid Lorebook Search

Combines keyword matching and semantic search for lorebook entries:

1. **Keyword scan**: Check each entry's `keys[]` against last `scanDepth` messages + current query.
2. **Semantic similarity**: Embed `keys + content`, compute cosine similarity.
3. **Scoring**: Keyword match = `1.0 + semanticScore`, semantic-only = `semanticScore`.
4. **Budget fill**: Skip entries with score < 0.25, fill until `tokenBudget` exhausted.

---

## 9. Context Builder

**File**: `src/lib/ai/context-builder.ts`

### System Prompt Template

Variables resolved at runtime:

| Placeholder                             | Source                               |
| --------------------------------------- | ------------------------------------ |
| `{{character_name}}` / `{{char}}`       | Character name                       |
| `{{character_description}}`             | Character description                |
| `{{character_personality}}`             | Personality traits                   |
| `{{scenario}}`                          | Scene/scenario                       |
| `{{world_state}}`                       | Location + relationships + inventory |
| `{{lorebook}}`                          | Active lorebook entries              |
| `{{memory}}` / `{{long_term_memory}}`   | User's manual notes                  |
| `{{user}}`                              | User persona name                    |
| `{{user_bio}}` / `{{user_description}}` | User bio                             |

### `buildRAGEnhancedPayload` — Token Budget Flow

```
┌─────────────────────────────────────────────┐
│            maxContextTokens (e.g. 16384)     │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ System Prompt    (fixed)              │   │
│  │ + RAG Sections   (injected)           │   │
│  ├──────────────────────────────────────┤   │
│  │ Chat History     (newest-first fill)  │   │
│  ├──────────────────────────────────────┤   │
│  │ Post-History Instructions (optional)  │   │
│  ├──────────────────────────────────────┤   │
│  │ Max Output Tokens (reserved)          │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

1. Calculate fixed costs (system prompt + post-history)
2. Inject RAG sections into system prompt (sorted by priority)
3. Calculate remaining budget for history
4. Fill history **newest-to-oldest** until budget exhausted
5. Append post-history instructions and optional assistant prefill

---

## 10. Lorebook System

### Automatic Extraction

**File**: `src/lib/lorebook-extractor.ts`

- **When**: After the user sends a NEW message, the **previous assistant message** is analyzed (not the new AI response). This ensures only the "chosen" regeneration gets extracted.
- **Model**: User's active model (whatever they configured)
- **Extraction targets**: Proper nouns only — named characters, unique locations, unique artifacts
- **Output**: Suggestions queue → user must Accept/Reject via LorebookEditor UI

### Matching at Runtime

**File**: `src/lib/ai/context-builder.ts` — `getActiveLorebookEntries()`

- Scans last `scanDepth` messages (default 2) for keyword matches
- Supports whole-word regex matching or substring matching
- Recursive scanning: matched entry content is scanned for more key matches
- Token-budgeted (default 500 tokens)

### Hybrid Search (RAG-enhanced)

**File**: `src/lib/ai/rag-service.ts` — `hybridLorebookSearch()`

Combines keyword + semantic embedding similarity for more accurate lorebook activation.

---

## 11. Settings & Toggles

**File**: `src/stores/settings-store.ts`

### RAG/Memory Settings (all default: `true`)

| Setting                       | Description                                            | Location     |
| ----------------------------- | ------------------------------------------------------ | ------------ |
| `enableRAGRetrieval`          | Use RAG to inject summaries/facts/vectors into context | Advanced tab |
| `enableFactExtraction`        | Extract facts from AI responses                        | Advanced tab |
| `enableHierarchicalSummaries` | Auto-create L0/L1/L2 summaries                         | Advanced tab |
| `lorebookAutoExtract`         | Suggest new lorebook entries from messages             | Advanced tab |

### Other Relevant Settings

| Setting           | Default | Description                                         |
| ----------------- | ------- | --------------------------------------------------- |
| `showWorldState`  | `true`  | Show world state panel in chat                      |
| `showThoughts`    | `true`  | Show CoT reasoning thoughts                         |
| `immersiveMode`   | `false` | Fullscreen chat mode                                |
| `enableReasoning` | `false` | Enable Chain-of-Thought for models like DeepSeek R1 |

---

## 12. Reindex Feature

**Location**: Memory Panel → Summaries tab → "Reindex Conversation" button

### What It Does

Retroactively processes all un-indexed messages in the current conversation:

1. **Chunks messages** into groups of 10
2. **Creates L0 summaries** for each chunk (via LLM)
3. **Indexes vector chunks** for semantic search
4. **Extracts facts** from summary key facts
5. **Creates L1 summaries** if 5+ L0s exist
6. **Creates L2 summaries** if 3+ L1s exist

### When To Use

- Imported an existing conversation with 400+ messages
- Disabled RAG during a long conversation and want to retroactively analyze it
- Lost RAG data and need to rebuild

### Notes

- Skips already-indexed chunks (incremental)
- Uses `meta-llama/llama-3.3-70b-instruct:free` via OpenRouter
- 1-second delay between chunks to avoid rate limiting
- Shows progress indicator during processing

---

## 13. Context Preview Panel

**Component**: `ContextPreviewPanel`

Shows exactly what will be sent to the AI API:

- **System Prompt** (with token count)
- **Lorebook Entries** (matched entries, token count)
- **RAG Sections** (summaries, facts, chunks — each with token count)
- **Chat History** (included/dropped message count)
- **Post-History Instructions**
- **Total Token Usage** (with visual bar + warnings at >90%)

Supports **draft preview**: includes the message being typed before sending.

---

## 14. Memory Panel (UI)

**File**: `src/components/chat/MemoryPanel.tsx`

### 3 Tabs

| Tab           | Content                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| **Notes**     | User's manual memory entries. Add, edit, delete. AI Summary generation.                                |
| **Facts**     | Auto-extracted facts. View by category and importance. Delete individual or clear all.                 |
| **Summaries** | Hierarchical summaries (L0/L1/L2). Sorted by level (highest first). Delete individual. Reindex button. |

---

## 15. Token Budget Management

### RAG Budget Allocation

```
proportionalBudget = floor((maxContextTokens - systemTokens - maxOutputTokens) × 0.25)
minimumBudget      = floor(maxContextTokens × 0.15)
ragBudget          = max(proportionalBudget, minimumBudget)
```

The 15% minimum is a **reservation**, not a forced allocation. If RAG retrieval only uses 8% of the budget, the remaining 7% automatically goes back to chat history (since `buildRAGEnhancedPayload` only deducts actual tokens used by RAG sections).

### Example: 16384-token context

| Scenario                      | System | RAG Budget             | Actual RAG Used | History Gets |
| ----------------------------- | ------ | ---------------------- | --------------- | ------------ |
| Short conversation            | 2000   | max(3084, 2457) = 3084 | 1500            | 10836        |
| Long conversation (200+ msgs) | 5000   | max(1596, 2457) = 2457 | 800             | 8126         |
| Very long + big system prompt | 8000   | max(334, 2457) = 2457  | 2000            | 3927         |

---

## 16. Data Flow Diagrams

### Message Lifecycle

```
User sends message
       │
       ├──► Lorebook extraction on previous assistant message (async, fire-and-forget)
       │
       ▼
   Add user message to store
       │
       ▼
   triggerAiReponse()
       │
       ├──► 1. Hybrid lorebook keyword+semantic search
       ├──► 2. Build system prompt (template resolution)
       ├──► 3. RAG retrieval (summaries → facts → chunks)
       ├──► 4. Build payload (system+RAG+history, token-budgeted)
       ├──► 5. Stream response from AI API
       │
       ▼
   Post-stream processing
       │
       ├──► World state analysis (location, relationships, inventory)
       ├──► Fact extraction (async, LLM-based)
       │
       ▼
   useEffect: Hierarchical Summarizer
       │
       ├──► Check if L0 needed (every 10 messages)
       ├──► Check if L1 needed (every 5 L0s)
       └──► Check if L2 needed (every 3 L1s)
```

### Regeneration vs New Message

```
┌─────────────────────────────────────────────┐
│              handleSend()                    │
│  ✅ Lorebook extraction (previous msg)       │
│  ✅ Fact extraction (new AI response)        │
│  ✅ World state analysis                     │
│  ✅ Hierarchical summaries                   │
├─────────────────────────────────────────────┤
│           handleRegenerate()                 │
│  ❌ Lorebook extraction (skipped)            │
│  ❌ Fact extraction (skipped)                │
│  ✅ World state analysis                     │
│  ✅ Hierarchical summaries                   │
├─────────────────────────────────────────────┤
│            handleContinue()                  │
│  ❌ Lorebook extraction (skipped)            │
│  ❌ Fact extraction (skipped)                │
│  ✅ World state analysis                     │
│  ✅ Hierarchical summaries                   │
└─────────────────────────────────────────────┘
```

---

## 17. File Reference

### Core AI Services

| File                                    | Purpose                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| `src/lib/ai/context-builder.ts`         | System prompt construction, lorebook matching, RAG payload builder    |
| `src/lib/ai/rag-service.ts`             | RAG retrieval, hybrid lorebook search, vector search, context preview |
| `src/lib/ai/hierarchical-summarizer.ts` | L0/L1/L2 summary pyramid, deduplication                               |
| `src/lib/ai/fact-extractor.ts`          | Fact extraction, parsing, deduplication, importance scoring           |
| `src/lib/ai/embedding-service.ts`       | MiniLM embeddings, caching, cosine similarity                         |
| `src/lib/ai/providers.ts`               | AI provider configuration                                             |
| `src/lib/tokenizer.ts`                  | Token counting (cl100k_base)                                          |
| `src/lib/lorebook-extractor.ts`         | Automatic lorebook entry extraction                                   |
| `src/lib/memory-summarizer.ts`          | Manual memory summary generation                                      |
| `src/lib/db.ts`                         | IndexedDB schema, CRUD operations                                     |

### Components

| File                                         | Purpose                                                  |
| -------------------------------------------- | -------------------------------------------------------- |
| `src/app/chat/page.tsx`                      | Main chat page, integration hub for all systems          |
| `src/components/chat/MemoryPanel.tsx`        | Memory panel UI (Notes/Facts/Summaries + Reindex)        |
| `src/components/chat/ChatBubble.tsx`         | Message rendering with edit/regenerate/continue/branch   |
| `src/components/chat/WorldStatePanel.tsx`    | World state display (location, relationships, inventory) |
| `src/components/chat/TreeVisualization.tsx`  | Message branch tree visualization                        |
| `src/components/lorebook/LorebookEditor.tsx` | Lorebook editor with suggestions                         |
| `src/components/settings/PresetEditor.tsx`   | Settings/presets with RAG toggles                        |

### Stores

| File                            | Purpose                             |
| ------------------------------- | ----------------------------------- |
| `src/stores/settings-store.ts`  | All settings including RAG toggles  |
| `src/stores/chat-store.ts`      | Conversations, messages, branching  |
| `src/stores/character-store.ts` | Character cards, long-term memory   |
| `src/stores/lorebook-store.ts`  | Lorebook entries, suggestions queue |

### Types

| File                     | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `src/types/rag.ts`       | VectorEntry, MemorySummary, WorldFact, ContextSection, etc. |
| `src/types/preset.ts`    | APIPreset fields, default presets, system prompt template   |
| `src/types/character.ts` | CharacterCard type                                          |
| `src/types/chat.ts`      | Message, Conversation, WorldState types                     |

---

## 18. Improvement Proposals

### 1. Conversation-Scoped Persona Memory

**Problem**: User personas share memory across conversations. A user playing different characters in different RPs gets mixed context.

**Solution**: Scope user notes and persona context per conversation, not globally.

### 2. Semantic Fact Merging

**Problem**: Similar facts accumulate over time (e.g., "Alice is angry" → "Alice is furious" → "Alice is enraged"). All three are separate entries.

**Solution**: Periodic fact consolidation — use embeddings to find clusters of similar facts and merge them via LLM, keeping the most recent/important version.

### 3. Adaptive Summarization Frequency

**Problem**: L0 triggers every 10 messages regardless of content density. A fast-paced battle scene has more important events per message than casual dialogue.

**Solution**: Monitor token density and importance of recent messages. Trigger summarization earlier for high-density segments and later for low-density ones.

### 4. RAG Confidence Scoring

**Problem**: RAG sections are always injected if they exist, even if poorly matched to the current context.

**Solution**: Add a minimum relevance threshold. Show confidence scores in the Context Preview so users can tune.

### 5. Multi-Conversation Knowledge Graph

**Problem**: Facts and relationships are siloed per conversation. If the same character appears in multiple RPs, knowledge doesn't transfer.

**Solution**: Optional character-level fact store that aggregates across conversations. Toggle: "Use cross-conversation knowledge."

### 6. Streaming Fact Extraction

**Problem**: Fact extraction waits for the full AI response, then makes a separate LLM call. This adds latency and costs an extra API call.

**Solution**: Extract facts incrementally as the response streams in, using heuristic pattern matching (for high-importance keywords) supplemented by periodic LLM verification.

### 7. User-Defined Fact Templates

**Problem**: Users may want to track specific types of information (e.g., HP, gold, quest progress) beyond the default categories.

**Solution**: Allow custom fact categories with user-defined extraction patterns and display templates. Could work like structured lorebook entries.

### 8. Conversation Branching Awareness in RAG

**Problem**: RAG indexes all messages including inactive branches. Facts from abandoned storylines may pollute the active branch context.

**Solution**: Tag vector entries and facts with their branch path. Only retrieve from the active branch lineage.

### 9. Export/Import RAG Data

**Problem**: RAG data (summaries, facts, vectors) is locked in the browser's IndexedDB. Switching browsers or devices loses everything.

**Solution**: Add export/import functionality for the RAG database (JSON or binary). Could integrate with the existing character export format.

### 10. Visual Timeline / Story Map

**Problem**: For long RPs (500+ messages), users lose track of the narrative arc. Summaries help the AI but don't help the user.

**Solution**: Build a visual timeline component showing L0/L1/L2 summaries on a scrollable timeline with branch visualization. Users can click events to jump to the original messages.

### 11. Smart Context Priority

**Problem**: The RAG budget distribution (30% summaries, rest split) is static. Some conversations may need more facts than summaries.

**Solution**: Dynamic budget allocation based on query type. Combat queries favor facts/events. Dialogue queries favor relationships. Exploration queries favor locations.

### 12. Automatic World State Updates from Facts

**Problem**: World state (location, inventory, relationships) is only updated by the world state analyzer. Some facts imply state changes that aren't captured.

**Solution**: Feed extracted facts back into the world state system. E.g., a fact "Alice gave Bob the sword" → automatically update Bob's inventory.

### 13. Message Quality Scoring

**Problem**: All messages are treated equally during summarization and fact extraction. Short "okay" responses waste processing.

**Solution**: Score message quality/density before processing. Skip low-quality messages. Weight high-quality messages more in summaries.

### 14. PWA Offline Support with Background Sync

**Problem**: The app requires internet for AI API calls. Background processing (fact extraction, summaries) fails if offline.

**Solution**: Queue background tasks and execute when connectivity returns. Leverage Service Worker for offline-first architecture.

### 15. Collaborative Multi-User RP

**Problem**: NexusAI is single-user. Multi-user RP sessions require external coordination.

**Solution**: WebSocket-based real-time collaboration where multiple users control different characters. Shared world state. Individual RAG scoping per user's perspective.
