/**
 * RAG (Retrieval-Augmented Generation) Service
 * 
 * Orchestrates the retrieval of relevant past context for RPG conversations.
 * Combines vector search over facts, summaries, and message chunks
 * with importance scoring and temporal decay.
 */

import type { RAGResult, WorldFact, MemorySummary, VectorEntry, ContextSection } from '@/types/rag';
import type { Message, WorldState } from '@/types/chat';
import type { LorebookEntry } from '@/types/character';
import {
    getFactsByConversation,
    getSummariesByConversation,
    getVectorsByConversation,
    updateFact,
    saveVector,
} from '@/lib/db';
import { embedText, cosineSimilarity, findTopK } from './embedding-service';
import { countTokens } from '@/lib/tokenizer';
import { getBestContextSummary } from './hierarchical-summarizer';

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
    return (cosineSim * 0.5) + (importanceWeight * 0.25) + (decay * 0.25);
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
        activeBranchMessageIds?: string[]; // Active branch message IDs for filtering
        minConfidence?: number;            // Minimum confidence threshold (0–1)
    } = {}
): Promise<ContextSection[]> {
    const {
        topKFacts = 10,
        topKChunks = 5,
        includeSummary = true,
        activeBranchMessageIds,
        minConfidence = 0,
    } = options;

    const sections: ContextSection[] = [];
    let remainingBudget = tokenBudget;

    // 1. Get query embedding
    const queryEmbedding = await embedText(queryText);

    // 2. Hierarchical summary (always included if available — very compact)
    if (includeSummary) {
        const summaryBudget = Math.min(Math.floor(tokenBudget * 0.3), 300);
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
    let activeFacts = facts.filter(f => f.active);

    // Branch-aware filtering: only include facts from the active branch lineage
    if (activeBranchMessageIds && activeBranchMessageIds.length > 0) {
        const branchSet = new Set(activeBranchMessageIds);
        activeFacts = activeFacts.filter(f => {
            // If fact has branchPath, check it overlaps with active branch
            if (f.branchPath && f.branchPath.length > 0) {
                return f.branchPath.some(id => branchSet.has(id));
            }
            // Facts without branchPath (legacy) are always included
            return true;
        });
    }
    
    if (activeFacts.length > 0 && remainingBudget > 50) {
        const factResults = retrieveRelevantFacts(queryEmbedding, activeFacts, topKFacts);
        
        if (factResults.length > 0) {
            // Update access stats for retrieved facts
            for (const r of factResults) {
                updateFact(r.item.id, {
                    lastAccessedAt: Date.now(),
                    accessCount: r.item.accessCount + 1,
                }).catch(console.error);
            }

            // Compute average confidence for facts section
            const avgFactConfidence = factResults.reduce((sum, r) => sum + r.score, 0) / factResults.length;

            // Apply minimum confidence threshold
            if (avgFactConfidence >= minConfidence) {
                const factLines = factResults.map(r => {
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
        filteredChunks = chunks.filter(c => {
            if (c.branchPath && c.branchPath.length > 0) {
                return c.branchPath.some(id => branchSet.has(id));
            }
            // Legacy chunks without branchPath are always included
            return true;
        });
    }

    if (filteredChunks.length > 0 && remainingBudget > 50) {
        const chunkResults = findTopK(queryEmbedding, filteredChunks, topKChunks, 0.2);
        
        if (chunkResults.length > 0) {
            const avgChunkConfidence = chunkResults.reduce((sum, r) => sum + r.score, 0) / chunkResults.length;

            if (avgChunkConfidence >= minConfidence) {
                const chunkTexts = chunkResults.map(r => r.item.text);
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
    facts: WorldFact[],
    topK: number
): Array<{ item: WorldFact; score: number }> {
    return facts
        .filter(f => f.embedding && f.embedding.length > 0)
        .map(f => {
            const sim = cosineSimilarity(queryEmbedding, f.embedding!);
            const score = combinedScore(sim, f.importance, f.timestamp, f.lastAccessedAt, f.accessCount);
            return { item: f, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .filter(r => r.score > 0.15);
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
    } = {}
): Promise<LorebookEntry[]> {
    const { scanDepth = 2, tokenBudget = 500, matchWholeWords = false } = config;
    
    if (!entries || entries.length === 0) return [];
    
    const enabledEntries = entries.filter(e => e.enabled);
    if (enabledEntries.length === 0) return [];
    
    // 1. Keyword matching (existing behavior)
    const messagesToScan = recentMessages.slice(-scanDepth);
    const scanText = messagesToScan.map(m => m.content.toLowerCase()).join('\n') + '\n' + queryText.toLowerCase();
    
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
                    keywordMatches.add(entry.keys[0]);  // Use first key as ID
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
    const scored = enabledEntries.map(entry => {
        const key = entry.keys[0];
        const isKeywordMatch = keywordMatches.has(key);
        const semanticScore = semanticScores.get(key) || 0;
        
        // Keyword match = guaranteed inclusion (score boost)
        const score = isKeywordMatch ? 1.0 + semanticScore : semanticScore;
        
        return { entry, score };
    });
    
    // Sort by score, then by priority
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.entry.priority || 10) - (a.entry.priority || 10);
    });
    
    // 3. Fill within token budget
    const result: LorebookEntry[] = [];
    let currentTokens = 0;
    
    for (const { entry, score } of scored) {
        // Skip very low semantic scores (unless keyword matched)
        if (score < 0.25) continue;
        
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
        messageIds: messages.map(m => m.id),
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
    activeLorebookEntries?: { keys: string[]; content: string }[]
): Promise<{
    sections: ContextSection[];
    totalTokens: number;
    maxTokens: number;
    warnings: string[];
}> {
    const sections: ContextSection[] = [];
    const warnings: string[] = [];
    
    // 1. System prompt
    const sysTokens = countTokens(systemPrompt);
    sections.push({
        priority: 0,
        content: systemPrompt,
        tokens: sysTokens,
        label: 'System Prompt',
        type: 'system',
    });
    
    // 2. Lorebook entries (shown separately for visibility, but tokens already counted in system prompt)
    if (activeLorebookEntries && activeLorebookEntries.length > 0) {
        const lorebookContent = activeLorebookEntries
            .map(e => `[About ${e.keys[0]}: ${e.content}]`)
            .join('\n');
        const lorebookTokens = countTokens(lorebookContent);
        sections.push({
            priority: 1,
            content: lorebookContent,
            tokens: lorebookTokens,
            label: `Lorebook (${activeLorebookEntries.length} entries)`,
            type: 'lorebook',
        });
        // Warn: these tokens are already counted inside system prompt, so we note this
        warnings.push(`ℹ️ Lorebook tokens (${lorebookTokens}) are included within System Prompt — not double-counted`);
    }
    
    // 3. RAG sections
    for (const section of ragSections) {
        sections.push(section);
    }
    
    // 3. Message history
    const historyContent = historyMessages
        .map(m => `[${m.role}]: ${m.content}`)
        .join('\n\n');
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
    const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0) + maxOutputTokens;
    
    if (totalTokens > maxContextTokens) {
        warnings.push(`⚠️ Context exceeds limit: ${totalTokens} / ${maxContextTokens} tokens (including ${maxOutputTokens} reserved for output)`);
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
