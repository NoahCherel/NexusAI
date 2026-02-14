/**
 * Atomic Fact Extractor
 * 
 * Extracts structured facts from RPG messages for persistent memory.
 * Facts are atomic, searchable units of information about the game world.
 */

import type { WorldFact, FactCategory } from '@/types/rag';
import type { WorldState } from '@/types/chat';

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
            .filter((f: any) => f.fact && f.category && f.importance)
            .map((f: any) => ({
                conversationId,
                messageId,
                fact: f.fact,
                category: validateCategory(f.category),
                importance: Math.max(1, Math.min(10, f.importance)),
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
    const valid: FactCategory[] = ['event', 'relationship', 'item', 'location', 'lore', 'consequence', 'dialogue'];
    return valid.includes(cat as FactCategory) ? (cat as FactCategory) : 'event';
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
- Key relationships: ${Object.entries(worldState.relationships).map(([n, v]) => `${n}: ${v}`).join(', ') || 'None'}

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
    return newFacts.filter(newFact => {
        const factLower = newFact.fact.toLowerCase();
        return !existingFacts.some(existing => {
            // Exact or near-exact match
            if (existing.fact.toLowerCase() === factLower) return true;

            // Check if entities overlap significantly
            const existingEntities = new Set(existing.relatedEntities.map(e => e.toLowerCase()));
            const newEntities = newFact.relatedEntities.map(e => e.toLowerCase());
            const overlap = newEntities.filter(e => existingEntities.has(e)).length;

            // If same entities and similar category, consider duplicate
            if (overlap >= 2 && existing.category === newFact.category) {
                // Check for word overlap
                const existingWords = new Set(existing.fact.toLowerCase().split(/\s+/));
                const newWords = factLower.split(/\s+/);
                const wordOverlap = newWords.filter(w => existingWords.has(w)).length / newWords.length;
                if (wordOverlap > 0.6) return true;
            }

            return false;
        });
    });
}
