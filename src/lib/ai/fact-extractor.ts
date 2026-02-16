/**
 * Atomic Fact Extractor
 *
 * Extracts structured facts from RPG messages for persistent memory.
 * Facts are atomic, searchable units of information about the game world.
 */

import type { WorldFact, FactCategory } from '@/types/rag';
import type { WorldState } from '@/types/chat';
import { cosineSimilarity } from './embedding-service';

export const FACT_EXTRACTION_PROMPT = `You are a RPG chronicle keeper. Extract atomic facts from this roleplay exchange.

RULES:
- Each fact must be a single, self-contained statement
- Facts should capture WHO did WHAT, WHERE, and consequences
- Rate importance 1-10: 1=trivial dialog, 5=notable event, 8=major plot point, 10=world-changing
- List entities involved (character names, item names, location names)
- Categorize each fact accurately
- Output ONLY valid JSON array, no markdown

Categories: event, relationship, item, location, lore, consequence, dialogue

Output format:
[
  {
    "fact": "description of what happened",
    "category": "event",
    "importance": 7,
    "entities": ["Character1", "ItemName"],
    "tags": ["combat", "discovery"]
  }
]

IMPORTANT: Only extract facts that represent NEW information or changes. Skip:
- Routine greetings or small talk (unless establishing a new relationship)
- Descriptions that don't advance the story
- Repetitions of known information`;

/**
 * Build the fact extraction prompt with optional custom categories.
 * If customCategories are provided, they are appended to the base categories.
 */
export function buildFactExtractionSystemPrompt(customCategories: string[] = []): string {
    const baseCategories = [
        'event',
        'relationship',
        'item',
        'location',
        'lore',
        'consequence',
        'dialogue',
    ];
    const allCategories = [
        ...baseCategories,
        ...customCategories.filter((c) => !baseCategories.includes(c.toLowerCase())),
    ];

    return `You are a RPG chronicle keeper. Extract atomic facts from this roleplay exchange.

RULES:
- Each fact must be a single, self-contained statement
- Facts should capture WHO did WHAT, WHERE, and consequences
- Rate importance 1-10: 1=trivial dialog, 5=notable event, 8=major plot point, 10=world-changing
- List entities involved (character names, item names, location names)
- Categorize each fact accurately
- Output ONLY valid JSON array, no markdown

Categories: ${allCategories.join(', ')}

Output format:
[
  {
    "fact": "description of what happened",
    "category": "event",
    "importance": 7,
    "entities": ["Character1", "ItemName"],
    "tags": ["combat", "discovery"]
  }
]

IMPORTANT: Only extract facts that represent NEW information or changes. Skip:
- Routine greetings or small talk (unless establishing a new relationship)
- Descriptions that don't advance the story
- Repetitions of known information`;
}

/**
 * Parse the AI response into WorldFact objects.
 */
export function parseFactExtractionResponse(
    text: string,
    conversationId: string,
    messageId: string
): Omit<WorldFact, 'id' | 'embedding'>[] {
    try {
        // Extract JSON array from response
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];

        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed)) return [];

        const now = Date.now();

        return parsed
            .filter((f: Record<string, unknown>) => f.fact && f.category && f.importance)
            .map((f: Record<string, unknown>) => ({
                conversationId,
                messageId,
                fact: String(f.fact),
                category: validateCategory(String(f.category)),
                importance: Math.max(1, Math.min(10, Number(f.importance))),
                active: true,
                timestamp: now,
                relatedEntities: Array.isArray(f.entities) ? f.entities : [],
                lastAccessedAt: now,
                accessCount: 0,
            }));
    } catch (error) {
        console.error('[FactExtractor] Failed to parse response:', text, error);
        return [];
    }
}

function validateCategory(cat: string): FactCategory {
    const builtIn: string[] = [
        'event',
        'relationship',
        'item',
        'location',
        'lore',
        'consequence',
        'dialogue',
    ];
    // Accept built-in categories and any non-empty custom category
    if (builtIn.includes(cat)) return cat as FactCategory;
    if (cat && cat.trim().length > 0) return cat.trim().toLowerCase();
    return 'event';
}

/**
 * Build the extraction prompt with context.
 */
export function buildFactExtractionPrompt(
    messageContent: string,
    worldState: WorldState,
    characterName: string,
    userName: string
): string {
    const context = `Current world state:
- Location: ${worldState.location || 'Unknown'}
- Inventory: ${worldState.inventory.join(', ') || 'Empty'}  
- Key relationships: ${
        Object.entries(worldState.relationships)
            .map(([n, v]) => `${n}: ${v}`)
            .join(', ') || 'None'
    }

Characters: ${characterName} (NPC), ${userName} (Player)

Message to analyze:
"${messageContent}"

Extract all new atomic facts:`;

    return context;
}

/**
 * Score importance heuristically based on content keywords.
 * Used as a fallback when AI extraction is unavailable.
 */
export function heuristicImportance(text: string): number {
    const lower = text.toLowerCase();
    let score = 3; // Base score

    // High importance indicators (use word stems with optional suffixes)
    const highIndicators = [
        /\b(kill|die|death|murder|betray|destroy|save|rescue|discover|reveal|secret)\w*/i,
        /\b(tuer|mourir|mort|trahir|détruire|sauver|découvrir|révéler|secret)\w*/i,
    ];

    const medIndicators = [
        /\b(attack|fight|battle|find|give|take|steal|buy|sell|enchant|curse)\w*/i,
        /\b(attaquer|combattre|trouver|donner|prendre|voler|acheter|vendre)\w*/i,
    ];

    const lowIndicators = [
        /\b(say|ask|reply|nod|smile|laugh|walk|look|think)\w*/i,
        /\b(dire|demander|répondre|sourire|marcher|regarder|penser)\w*/i,
    ];

    for (const pattern of highIndicators) {
        if (pattern.test(lower)) score = Math.max(score, 7);
    }
    for (const pattern of medIndicators) {
        if (pattern.test(lower)) score = Math.max(score, 5);
    }
    for (const pattern of lowIndicators) {
        if (pattern.test(lower)) score = Math.max(score, 2);
    }

    // Longer messages tend to have more substance
    if (text.length > 500) score = Math.min(10, score + 1);
    if (text.length > 1000) score = Math.min(10, score + 1);

    return score;
}

/**
 * Deduplicate facts based on similarity of content and entities.
 */
export function deduplicateFacts(
    newFacts: Omit<WorldFact, 'id' | 'embedding'>[],
    existingFacts: WorldFact[]
): Omit<WorldFact, 'id' | 'embedding'>[] {
    return newFacts.filter((newFact) => {
        const factLower = newFact.fact.toLowerCase();
        return !existingFacts.some((existing) => {
            // Exact or near-exact match
            if (existing.fact.toLowerCase() === factLower) return true;

            // Check if entities overlap significantly
            const existingEntities = new Set(existing.relatedEntities.map((e) => e.toLowerCase()));
            const newEntities = newFact.relatedEntities.map((e) => e.toLowerCase());
            const overlap = newEntities.filter((e) => existingEntities.has(e)).length;

            // If same entities and similar category, consider duplicate
            if (overlap >= 2 && existing.category === newFact.category) {
                // Check for word overlap
                const existingWords = new Set(existing.fact.toLowerCase().split(/\s+/));
                const newWords = factLower.split(/\s+/);
                const wordOverlap =
                    newWords.filter((w) => existingWords.has(w)).length / newWords.length;
                if (wordOverlap > 0.6) return true;
            }

            return false;
        });
    });
}

// ============================================
// Semantic Fact Merging
// ============================================

/**
 * Find clusters of semantically related facts using embedding similarity.
 * Groups facts where cosine similarity > threshold.
 * Returns clusters of fact IDs that can be merged.
 */
export function findRelatedFactClusters(
    facts: WorldFact[],
    similarityThreshold: number = 0.7
): WorldFact[][] {
    const factsWithEmbeddings = facts.filter((f) => f.embedding && f.embedding.length > 0);
    if (factsWithEmbeddings.length < 2) return [];

    const visited = new Set<string>();
    const clusters: WorldFact[][] = [];

    for (let i = 0; i < factsWithEmbeddings.length; i++) {
        if (visited.has(factsWithEmbeddings[i].id)) continue;

        const cluster: WorldFact[] = [factsWithEmbeddings[i]];
        visited.add(factsWithEmbeddings[i].id);

        for (let j = i + 1; j < factsWithEmbeddings.length; j++) {
            if (visited.has(factsWithEmbeddings[j].id)) continue;

            const sim = cosineSimilarity(
                factsWithEmbeddings[i].embedding!,
                factsWithEmbeddings[j].embedding!
            );

            if (sim >= similarityThreshold) {
                cluster.push(factsWithEmbeddings[j]);
                visited.add(factsWithEmbeddings[j].id);
            }
        }

        // Only include clusters with 2+ facts
        if (cluster.length >= 2) {
            clusters.push(cluster);
        }
    }

    return clusters;
}

/**
 * Merge a cluster of related facts into a single consolidated fact.
 * Keeps the highest importance, most recent timestamp, and merges entities.
 * The merged fact text combines unique information from all facts.
 */
export function mergeFactCluster(cluster: WorldFact[]): Omit<WorldFact, 'id' | 'embedding'> {
    if (cluster.length === 0) throw new Error('Cannot merge empty cluster');
    if (cluster.length === 1) {
        const { id, embedding, ...rest } = cluster[0];
        return rest;
    }

    // Sort by importance (desc), then by timestamp (most recent first)
    const sorted = [...cluster].sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return b.timestamp - a.timestamp;
    });

    const primary = sorted[0]; // Most important/recent fact

    // Merge entity lists (deduplicate)
    const allEntities = new Set<string>();
    for (const fact of cluster) {
        fact.relatedEntities.forEach((e) => allEntities.add(e));
    }

    // Combine fact texts: use primary as base, append unique info from others
    const primaryWords = new Set(primary.fact.toLowerCase().split(/\s+/));
    const additionalInfo: string[] = [];

    for (const fact of sorted.slice(1)) {
        const words = fact.fact.toLowerCase().split(/\s+/);
        const novelWords = words.filter((w) => !primaryWords.has(w) && w.length > 3);
        const novelRatio = novelWords.length / words.length;

        // If the secondary fact has >20% novel words, it adds info worth preserving
        if (novelRatio > 0.2) {
            additionalInfo.push(fact.fact);
        }
    }

    let mergedFact = primary.fact;
    if (additionalInfo.length > 0) {
        // Append condensed additional info
        mergedFact += '. Also: ' + additionalInfo.join('; ');
    }

    return {
        conversationId: primary.conversationId,
        messageId: primary.messageId,
        fact: mergedFact,
        category: primary.category,
        importance: Math.max(...cluster.map((f) => f.importance)),
        active: cluster.some((f) => f.active), // Active if any are active
        timestamp: Math.max(...cluster.map((f) => f.timestamp)),
        relatedEntities: Array.from(allEntities),
        lastAccessedAt: Math.max(...cluster.map((f) => f.lastAccessedAt)),
        accessCount: cluster.reduce((sum, f) => sum + f.accessCount, 0),
        branchPath: primary.branchPath, // Inherit from primary
    };
}

/**
 * Merge all related fact clusters in a conversation.
 * Returns the IDs of facts that were merged (to be deleted) and the new merged facts.
 */
export function mergeRelatedFacts(
    facts: WorldFact[],
    similarityThreshold: number = 0.7
): {
    mergedFacts: Omit<WorldFact, 'id' | 'embedding'>[];
    deletedIds: string[];
    clusterCount: number;
} {
    const clusters = findRelatedFactClusters(facts, similarityThreshold);

    if (clusters.length === 0) {
        return { mergedFacts: [], deletedIds: [], clusterCount: 0 };
    }

    const mergedFacts: Omit<WorldFact, 'id' | 'embedding'>[] = [];
    const deletedIds: string[] = [];

    for (const cluster of clusters) {
        const merged = mergeFactCluster(cluster);
        mergedFacts.push(merged);
        // All original facts in the cluster are deleted
        deletedIds.push(...cluster.map((f) => f.id));
    }

    return { mergedFacts, deletedIds, clusterCount: clusters.length };
}
