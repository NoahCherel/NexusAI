/**
 * RAG (Retrieval-Augmented Generation) Service
 *
 * Orchestrates the retrieval of relevant past context for RPG conversations.
 * Combines vector search over facts, summaries, and message chunks
 * with importance scoring and temporal decay.
 */

import type { WorldFact, VectorEntry, ContextSection } from '@/types/rag';
import type { Message, WorldState } from '@/types/chat';
import type { LorebookEntry } from '@/types/character';
import {
    getFactsByConversation,
    getVectorsByConversation,
    updateFact,
    saveVector,
} from '@/lib/db';
import { embedText, cosineSimilarity } from './embedding-service';
import { countTokens } from '@/lib/tokenizer';
import { getBestContextSummary } from './hierarchical-summarizer';
import {
    buildRetrievalQueryText,
    extractSearchTerms,
    lexicalOverlapScore,
} from './rag-ranking';

// ============================================
// Temporal Decay
// ============================================

/**
 * Calculate temporal decay factor.
 * Recent items get higher scores, old unused items decay.
 * Critical items (importance >= 8) decay slower.
 */
function temporalDecay(
    timestamp: number,
    lastAccessedAt: number,
    importance: number,
    accessCount: number
): number {
    const now = Date.now();
    const ageHours = (now - timestamp) / (1000 * 60 * 60);
    const lastAccessHours = (now - lastAccessedAt) / (1000 * 60 * 60);

    // Base decay: exponential with importance-based half-life
    // High importance items have longer half-lives
    const halfLife = importance >= 8 ? 720 : importance >= 5 ? 168 : 48; // hours
    const ageFactor = Math.pow(0.5, ageHours / halfLife);

    // Recency boost: recently accessed items get a boost
    const recencyBoost = lastAccessHours < 1 ? 1.5 : lastAccessHours < 24 ? 1.2 : 1.0;

    // Frequency boost: items accessed multiple times are likely important
    const freqBoost = Math.min(1.5, 1 + accessCount * 0.1);

    return ageFactor * recencyBoost * freqBoost;
}

// ============================================
// Importance Scoring
// ============================================

/**
 * Calculate a combined relevance score.
 * Combines cosine similarity, importance, and temporal decay.
 */
function combinedScore(
    cosineSim: number,
    importance: number,
    timestamp: number,
    lastAccessedAt: number,
    accessCount: number
): number {
    const decay = temporalDecay(timestamp, lastAccessedAt, importance, accessCount);
    const importanceWeight = importance / 10; // Normalize to 0-1

    // Weighted combination:
    // 50% similarity, 25% importance, 25% temporal relevance
    return cosineSim * 0.5 + importanceWeight * 0.25 + decay * 0.25;
}

// ============================================
// Main RAG Retrieval
// ============================================

/**
 * Retrieve relevant context for a given query message.
 * Returns structured sections ready for context injection.
 */
export async function retrieveRelevantContext(
    queryText: string,
    conversationId: string,
    tokenBudget: number,
    options: {
        topKFacts?: number;
        topKChunks?: number;
        includeSummary?: boolean;
        worldState?: WorldState;
        recentMessages?: Message[]; // Recent active-branch messages for richer low-cost retrieval
        activeBranchMessageIds?: string[]; // Active branch message IDs for filtering
        minConfidence?: number; // Minimum confidence threshold (0–1)
    } = {}
): Promise<ContextSection[]> {
    const {
        topKFacts = 10,
        topKChunks = 5,
        includeSummary = true,
        worldState,
        recentMessages,
        activeBranchMessageIds,
        minConfidence = 0,
    } = options;

    const sections: ContextSection[] = [];
    let remainingBudget = tokenBudget;

    // 1. Build a richer retrieval query, then embed it once. This is cheaper than
    // upgrading providers and gives vector search better scene anchors.
    const retrievalQueryText = buildRetrievalQueryText(queryText, {
        recentMessages,
        worldState,
    });
    const queryTerms = extractSearchTerms(retrievalQueryText);
    const queryEmbedding = await embedText(retrievalQueryText || queryText);

    // 2. Hierarchical summary (always included if available — very compact)
    if (includeSummary) {
        const summaryBudget = Math.min(Math.floor(tokenBudget * 0.35), 400);
        const summaryText = await getBestContextSummary(conversationId, summaryBudget);
        if (summaryText) {
            const tokens = countTokens(summaryText);
            sections.push({
                priority: 1,
                content: summaryText,
                tokens,
                label: 'Story Summary',
                type: 'summary',
            });
            remainingBudget -= tokens;
        }
    }

    // 3. Retrieve relevant facts via vector search
    const facts = await getFactsByConversation(conversationId);
    let activeFacts = facts.filter((f) => f.active);

    // Branch-aware filtering: only include facts from the active branch lineage
    if (activeBranchMessageIds && activeBranchMessageIds.length > 0) {
        const branchSet = new Set(activeBranchMessageIds);
        activeFacts = activeFacts.filter((f) => {
            // If fact has branchPath, check it overlaps with active branch
            if (f.branchPath && f.branchPath.length > 0) {
                return f.branchPath.some((id) => branchSet.has(id));
            }
            // Facts without branchPath (legacy) are always included
            return true;
        });
    }

    if (activeFacts.length > 0 && remainingBudget > 50) {
        const factResults = retrieveRelevantFacts(queryEmbedding, queryTerms, activeFacts, topKFacts);

        if (factResults.length > 0) {
            // Update access stats for retrieved facts
            for (const r of factResults) {
                updateFact(r.item.id, {
                    lastAccessedAt: Date.now(),
                    accessCount: r.item.accessCount + 1,
                }).catch(console.error);
            }

            // Compute average confidence for facts section
            const avgFactConfidence =
                factResults.reduce((sum, r) => sum + r.score, 0) / factResults.length;

            // Apply minimum confidence threshold — only include if meaningfully relevant
            if (avgFactConfidence >= Math.max(minConfidence, 0.3)) {
                const factLines = factResults.map((r) => {
                    const imp = r.item.importance >= 8 ? '⚠️' : r.item.importance >= 5 ? '•' : '◦';
                    return `${imp} ${r.item.fact}`;
                });

                const factsText = '🔍 Relevant Past Events:\n' + factLines.join('\n');
                const tokens = countTokens(factsText);

                if (tokens <= remainingBudget) {
                    sections.push({
                        priority: 2,
                        content: factsText,
                        tokens,
                        label: `Facts (${factResults.length})`,
                        type: 'fact',
                        confidence: avgFactConfidence,
                    });
                    remainingBudget -= tokens;
                }
            }
        }
    }

    // 4. Retrieve relevant message chunks
    const chunks = await getVectorsByConversation(conversationId);

    // Branch-aware filtering for chunks
    let filteredChunks = chunks;
    if (activeBranchMessageIds && activeBranchMessageIds.length > 0) {
        const branchSet = new Set(activeBranchMessageIds);
        filteredChunks = chunks.filter((c) => {
            if (c.branchPath && c.branchPath.length > 0) {
                return c.branchPath.some((id) => branchSet.has(id));
            }
            // Legacy chunks without branchPath are always included
            return true;
        });
    }

    if (filteredChunks.length > 0 && remainingBudget > 50) {
        const chunkResults = retrieveRelevantChunks(
            queryEmbedding,
            queryTerms,
            filteredChunks,
            topKChunks
        );

        if (chunkResults.length > 0) {
            const avgChunkConfidence =
                chunkResults.reduce((sum, r) => sum + r.score, 0) / chunkResults.length;

            if (avgChunkConfidence >= minConfidence) {
                const chunkTexts = chunkResults.map((r) => r.item.text);
                const chunksText = '📜 Related Past Scenes:\n' + chunkTexts.join('\n---\n');
                const tokens = countTokens(chunksText);

                if (tokens <= remainingBudget) {
                    sections.push({
                        priority: 3,
                        content: chunksText,
                        tokens,
                        label: `Scenes (${chunkResults.length})`,
                        type: 'memory',
                        confidence: avgChunkConfidence,
                    });
                    remainingBudget -= tokens;
                }
            }
        }
    }

    return sections;
}

/**
 * Retrieve relevant facts with combined scoring.
 */
function retrieveRelevantFacts(
    queryEmbedding: number[],
    queryTerms: Set<string>,
    facts: WorldFact[],
    topK: number
): Array<{ item: WorldFact; score: number }> {
    return facts
        .filter((f) => f.embedding && f.embedding.length > 0)
        .map((f) => {
            const sim = cosineSimilarity(queryEmbedding, f.embedding!);
            const lexical = lexicalOverlapScore(queryTerms, f.fact, [
                f.category,
                ...f.relatedEntities,
            ]);
            const score = combinedScore(
                sim,
                f.importance,
                f.timestamp,
                f.lastAccessedAt,
                f.accessCount
            ) + lexical * 0.25;
            return { item: f, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .filter((r) => {
            const sim = cosineSimilarity(queryEmbedding, r.item.embedding!);
            const lexical = lexicalOverlapScore(queryTerms, r.item.fact, [
                r.item.category,
                ...r.item.relatedEntities,
            ]);

            return (
                r.score > 0.25 &&
                (sim >= 0.18 || lexical >= 0.2 || (r.item.importance >= 8 && sim >= 0.12))
            );
        });
}

function retrieveRelevantChunks(
    queryEmbedding: number[],
    queryTerms: Set<string>,
    chunks: VectorEntry[],
    topK: number
): Array<{ item: VectorEntry; score: number }> {
    return chunks
        .filter((chunk) => chunk.embedding && chunk.embedding.length > 0)
        .map((chunk) => {
            const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
            const lexical = lexicalOverlapScore(queryTerms, chunk.text, [
                ...chunk.metadata.characters,
                chunk.metadata.location,
                ...chunk.metadata.tags,
            ]);
            const importance = Math.max(0, Math.min(1, chunk.metadata.importance / 10));
            const score = sim * 0.7 + lexical * 0.2 + importance * 0.1;
            return { item: chunk, score, sim, lexical };
        })
        .filter((result) => result.score >= 0.2 && (result.sim >= 0.18 || result.lexical >= 0.2))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(({ item, score }) => ({ item, score }));
}

// ============================================
// Hybrid Lorebook Search
// ============================================

/**
 * Enhanced lorebook search combining keyword matching with semantic similarity.
 */
export async function hybridLorebookSearch(
    queryText: string,
    queryEmbedding: number[],
    entries: LorebookEntry[],
    recentMessages: Message[],
    config: {
        scanDepth?: number;
        tokenBudget?: number;
        matchWholeWords?: boolean;
        characterName?: string;
        userPersonaName?: string;
    } = {}
): Promise<LorebookEntry[]> {
    const { scanDepth = 2, tokenBudget = 500, matchWholeWords = false, characterName, userPersonaName } = config;

    if (!entries || entries.length === 0) return [];

    const enabledEntries = entries.filter((e) => e.enabled);
    if (enabledEntries.length === 0) return [];

    // 1. Keyword matching (existing behavior)
    const messagesToScan = recentMessages.slice(-scanDepth);
    const scanText =
        messagesToScan.map((m) => m.content.toLowerCase()).join('\n') +
        '\n' +
        queryText.toLowerCase();

    const keywordMatches = new Set<string>();
    const semanticScores = new Map<string, number>();

    for (const entry of enabledEntries) {
        // Keyword match
        for (const keyword of entry.keys) {
            const cleanKey = keyword.trim().toLowerCase();
            if (!cleanKey) continue;

            if (matchWholeWords) {
                const escapedKey = cleanKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b${escapedKey}\\b`, 'i');
                if (regex.test(scanText)) {
                    keywordMatches.add(entry.keys[0]); // Use first key as ID
                    break;
                }
            } else {
                if (scanText.includes(cleanKey)) {
                    keywordMatches.add(entry.keys[0]);
                    break;
                }
            }
        }

        // Semantic similarity (if embedding available)
        if (queryEmbedding.length > 0) {
            const entryText = `${entry.keys.join(' ')} ${entry.content}`;
            const entryEmbedding = await embedText(entryText);
            const sim = cosineSimilarity(queryEmbedding, entryEmbedding);
            semanticScores.set(entry.keys[0], sim);
        }
    }

    // 2. Combine results: keyword matches get priority, then semantic
    const scored = enabledEntries.map((entry) => {
        const key = entry.keys[0];
        const isKeywordMatch = keywordMatches.has(key);
        const semanticScore = semanticScores.get(key) || 0;

        // Keyword match = guaranteed inclusion (score boost)
        const score = isKeywordMatch ? 1.0 + semanticScore : semanticScore;

        return { entry, score };
    });

    // Sort by score, then by priority, then alphabetically
    scored.sort((a, b) => {
        // User Persona entry always first
        if (userPersonaName) {
            const aIsUser = a.entry.keys.some(k => k.toLowerCase() === userPersonaName.toLowerCase());
            const bIsUser = b.entry.keys.some(k => k.toLowerCase() === userPersonaName.toLowerCase());
            if (aIsUser && !bIsUser) return -1;
            if (!aIsUser && bIsUser) return 1;
        }
        // Character entry second
        if (characterName) {
            const aIsChar = a.entry.keys.some(k => k.toLowerCase() === characterName.toLowerCase());
            const bIsChar = b.entry.keys.some(k => k.toLowerCase() === characterName.toLowerCase());
            if (aIsChar && !bIsChar) return -1;
            if (!aIsChar && bIsChar) return 1;
        }
        if (b.score !== a.score) return b.score - a.score;
        const priorityDiff = (b.entry.priority || 10) - (a.entry.priority || 10);
        if (priorityDiff !== 0) return priorityDiff;
        return (a.entry.keys[0] || '').localeCompare(b.entry.keys[0] || '');
    });

    // 3. Fill within token budget
    const result: LorebookEntry[] = [];
    let currentTokens = 0;

    for (const { entry, score } of scored) {
        // Always include User Persona and AI Character if they exist
        const isUser = userPersonaName && entry.keys.some(k => k.toLowerCase() === userPersonaName.toLowerCase());
        const isChar = characterName && entry.keys.some(k => k.toLowerCase() === characterName.toLowerCase());
        
        // Skip low semantic scores (unless keyword matched — score > 1.0 means keyword match, or it's a core character)
        if (score < 0.3 && !isUser && !isChar) continue;

        const entryTokens = countTokens(entry.content);
        if (currentTokens + entryTokens > tokenBudget) continue;

        result.push(entry);
        currentTokens += entryTokens;
    }

    return result;
}

// ============================================
// Message Chunk Indexing
// ============================================

/**
 * Index a group of messages as a vector chunk for future retrieval.
 */
export async function indexMessageChunk(
    messages: Message[],
    conversationId: string,
    summaryText: string,
    metadata: {
        characters?: string[];
        location?: string;
        importance?: number;
        tags?: string[];
    } = {},
    branchPath?: string[]
): Promise<void> {
    const embedding = await embedText(summaryText);

    const entry: VectorEntry = {
        id: crypto.randomUUID(),
        conversationId,
        messageIds: messages.map((m) => m.id),
        text: summaryText,
        embedding,
        metadata: {
            timestamp: Date.now(),
            characters: metadata.characters || [],
            location: metadata.location || '',
            importance: metadata.importance || 5,
            tags: metadata.tags || [],
        },
        branchPath,
        createdAt: Date.now(),
    };

    await saveVector(entry);
}

// ============================================
// Context Preview Builder
// ============================================

/**
 * Build a full context preview showing exactly what would be sent to the AI.
 * This is for the UI preview feature.
 */
export async function buildContextPreview(
    systemPrompt: string,
    ragSections: ContextSection[],
    historyMessages: { role: string; content: string }[],
    postHistory: string | undefined,
    maxContextTokens: number,
    maxOutputTokens: number,
    activeLorebookEntries?: { keys: string[]; content: string }[],
    worldState?: { location?: string; relationships?: Record<string, number>; inventory?: string[] },
    /**
     * Casting metadata used to expose what's injected vs ignored, so the user can see
     * exactly which canon fiches reach the model (and which were excluded because they're
     * stubs / disabled / not mentioned in the recent scene).
     */
    canonInjection?: {
        injectedNames: string[]; // dossiers actually rendered in the system prompt
        ignoredStubs: string[]; // stubs that won't be injected (no identity fetched)
        ignoredDisabled: string[]; // dossiers explicitly toggled off
        scanDepth: number; // how many recent messages were scanned
        dueToAppear?: string[]; // characters hinted to the Director (arc-matched)
    }
): Promise<{
    sections: ContextSection[];
    totalTokens: number;
    maxTokens: number;
    warnings: string[];
}> {
    const sections: ContextSection[] = [];
    const warnings: string[] = [];

    // 1. System prompt (strip lorebook, world state, AND canon blocks for cleaner preview)
    let displaySystemPrompt = systemPrompt;

    // Strip lorebook entries from system prompt display (they're shown in their own section)
    if (activeLorebookEntries && activeLorebookEntries.length > 0) {
        for (const entry of activeLorebookEntries) {
            const lorebookLine = `[About ${entry.keys[0]}: ${entry.content}]`;
            displaySystemPrompt = displaySystemPrompt.replace(lorebookLine, '');
        }
    }

    // Strip CANON / IN THIS RP blocks (they're shown in their own section). The blocks span
    // multiple lines from a bracketed label until a blank line. We capture the whole block.
    displaySystemPrompt = displaySystemPrompt.replace(
        /\[CANON — [^\]]+\][\s\S]*?(?=\n\n|\n\[|$)/g,
        '⟨canon block — see Canon section⟩'
    );
    displaySystemPrompt = displaySystemPrompt.replace(
        /\[IN THIS RP — [^\]]+\][\s\S]*?(?=\n\n|\n\[|$)/g,
        '⟨in-this-rp block — see Canon section⟩'
    );
    displaySystemPrompt = displaySystemPrompt.replace(
        /\[RELATIONSHIPS —[\s\S]*?(?=\n\n|$)/g,
        '⟨relationships block — see Canon section⟩'
    );

    // Strip world state block from system prompt display (shown in dedicated section)
    if (worldState) {
        // Remove the "Current World Context:" block if present
        displaySystemPrompt = displaySystemPrompt.replace(
            /Current World Context:\n(?:Location:[^\n]*\n?)?(?:Relationships:[^\n]*\n?)?(?:Inventory:[^\n]*\n?)?/gi,
            ''
        );
    }

    // Clean up excessive whitespace from stripping
    displaySystemPrompt = displaySystemPrompt.replace(/\n{3,}/g, '\n\n').trim();

    const sysTokens = countTokens(systemPrompt); // Use original for accurate token count
    sections.push({
        priority: 0,
        content: displaySystemPrompt,
        tokens: sysTokens,
        label: 'System Prompt',
        type: 'system',
    });

    // 2. World State (relationships & inventory - shown separately for visibility, already in system prompt)
    if (worldState) {
        const wsParts: string[] = [];
        if (worldState.location) {
            wsParts.push(`Location: ${worldState.location}`);
        }
        if (worldState.relationships && Object.keys(worldState.relationships).length > 0) {
            const rels = Object.entries(worldState.relationships)
                .map(([name, desc]) => `  ${name}: ${desc}`)
                .join('\n');
            wsParts.push(`Relationships:\n${rels}`);
        }
        if (worldState.inventory && worldState.inventory.length > 0) {
            wsParts.push(`Inventory: ${worldState.inventory.join(', ')}`);
        }
        if (wsParts.length > 0) {
            const wsContent = wsParts.join('\n\n');
            sections.push({
                priority: 0,
                content: wsContent,
                tokens: countTokens(wsContent),
                label: 'World State — included in system prompt',
                type: 'world-state',
            });
        }
    }

    // 2.5 Canon dossiers — shows EXACTLY which casting fiches reached the model, plus why
    // the others were excluded. This is the user-facing answer to "is my casting being used?".
    if (canonInjection) {
        const {
            injectedNames,
            ignoredStubs,
            ignoredDisabled,
            scanDepth,
            dueToAppear,
        } = canonInjection;

        // Extract the actual rendered blocks straight from the system prompt so the user sees
        // the literal text the model will read.
        const canonBlocks: string[] = [];
        const canonRegex = /\[CANON — [^\]]+\][\s\S]*?(?=\n\n|\n\[|$)/g;
        const rpRegex = /\[IN THIS RP — [^\]]+\][\s\S]*?(?=\n\n|\n\[|$)/g;
        const relRegex = /\[RELATIONSHIPS —[\s\S]*?(?=\n\n|$)/g;
        const canonMatches = systemPrompt.match(canonRegex) || [];
        const rpMatches = systemPrompt.match(rpRegex) || [];
        const relMatches = systemPrompt.match(relRegex) || [];
        canonBlocks.push(...canonMatches, ...rpMatches, ...relMatches);

        const lines: string[] = [];
        lines.push(
            `Scope: scanned the last ${scanDepth} message(s) for casting names mentioned in the scene.`
        );
        if (injectedNames.length > 0) {
            lines.push(`Injected dossiers (${injectedNames.length}): ${injectedNames.join(', ')}`);
        } else {
            lines.push(
                'Injected dossiers: none. No casting member was mentioned in the recent messages, OR all matches are stubs / disabled.'
            );
        }
        if (dueToAppear && dueToAppear.length > 0) {
            lines.push(
                `Hinted to the Director (due to appear around this arc): ${dueToAppear.join(', ')}`
            );
        }
        if (ignoredStubs.length > 0) {
            lines.push(
                `Excluded — stubs (no fiche fetched yet, click "Récupérer la fiche complète"): ${ignoredStubs.join(', ')}`
            );
        }
        if (ignoredDisabled.length > 0) {
            lines.push(`Excluded — disabled by user: ${ignoredDisabled.join(', ')}`);
        }
        if (canonBlocks.length > 0) {
            lines.push('');
            lines.push('— Literal blocks injected into the system prompt —');
            lines.push(canonBlocks.join('\n\n'));
        }
        const content = lines.join('\n');
        sections.push({
            priority: 1,
            content,
            tokens: countTokens(content),
            label: `Canon dossiers (${injectedNames.length} injected) — what the model sees about your casting`,
            type: 'canon',
        });
    }

    // 3. Lorebook entries (shown separately for visibility, but tokens already counted in system prompt)
    if (activeLorebookEntries && activeLorebookEntries.length > 0) {
        // Keep the order they were passed in (User Persona first, then AI Character, then priority/alphabetical)
        const lorebookContent = activeLorebookEntries
            .map((e) => `[About ${e.keys[0]}: ${e.content}]`)
            .join('\n');
        const lorebookTokens = countTokens(lorebookContent);
        sections.push({
            priority: 1,
            content: lorebookContent,
            tokens: lorebookTokens,
            label: `Lorebook (${activeLorebookEntries.length} entries) — included in system prompt`,
            type: 'lorebook',
        });
    }

    // 3. RAG sections
    for (const section of ragSections) {
        sections.push(section);
    }

    // 3. Message history
    const historyContent = historyMessages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');
    const historyTokens = countTokens(historyContent);
    sections.push({
        priority: 10,
        content: historyContent,
        tokens: historyTokens,
        label: `Chat History (${historyMessages.length} msgs)`,
        type: 'history',
    });

    // 4. Post-history
    if (postHistory) {
        const phTokens = countTokens(postHistory);
        sections.push({
            priority: 11,
            content: postHistory,
            tokens: phTokens,
            label: 'Post-History Instructions',
            type: 'post-history',
        });
    }

    // Calculate totals
    // Note: Lorebook and world-state tokens are already included in system prompt, so exclude from total
    const totalTokens =
        sections.filter((s) => s.type !== 'lorebook' && s.type !== 'world-state').reduce((sum, s) => sum + s.tokens, 0) +
        maxOutputTokens;

    if (totalTokens > maxContextTokens) {
        warnings.push(
            `⚠️ Context exceeds limit: ${totalTokens} / ${maxContextTokens} tokens (including ${maxOutputTokens} reserved for output)`
        );
    }

    const usedRatio = totalTokens / maxContextTokens;
    if (usedRatio > 0.9 && usedRatio <= 1.0) {
        warnings.push(`⚡ Context is at ${Math.round(usedRatio * 100)}% capacity`);
    }

    return {
        sections,
        totalTokens,
        maxTokens: maxContextTokens,
        warnings,
    };
}
