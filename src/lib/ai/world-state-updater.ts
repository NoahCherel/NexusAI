/**
 * Automatic World State Updater
 * 
 * Analyzes newly extracted facts and generates world state updates.
 * Maps fact categories and entities to inventory, location, and relationship changes.
 */

import type { WorldFact } from '@/types/rag';
import type { WorldState } from '@/types/chat';

interface WorldStateUpdate {
    inventory?: { add?: string[]; remove?: string[] };
    location?: string;
    relationships?: Record<string, number>; // entity -> relationship delta
}

/**
 * Analyze a set of facts and derive world state updates.
 * Uses fact categories, entities, and keywords to determine changes.
 */
export function deriveWorldStateUpdates(
    facts: WorldFact[],
    currentState: WorldState,
    characterName: string,
    userName: string
): WorldStateUpdate {
    const update: WorldStateUpdate = {};
    const itemsToAdd: string[] = [];
    const itemsToRemove: string[] = [];
    const relationshipDeltas: Record<string, number> = {};
    let newLocation: string | undefined;

    for (const fact of facts) {
        const lower = fact.fact.toLowerCase();
        const entities = fact.relatedEntities.map(e => e.toLowerCase());

        // ===== ITEM CHANGES =====
        if (fact.category === 'item' || hasItemKeywords(lower)) {
            const obtainMatch = matchObtainPatterns(lower);
            const loseMatch = matchLosePatterns(lower);

            if (obtainMatch) {
                // Extract item names from entities (exclude character names)
                const items = fact.relatedEntities.filter(
                    e => !isCharacterName(e, characterName, userName)
                );
                itemsToAdd.push(...items);
            }

            if (loseMatch) {
                const items = fact.relatedEntities.filter(
                    e => !isCharacterName(e, characterName, userName)
                );
                itemsToRemove.push(...items);
            }
        }

        // ===== LOCATION CHANGES =====
        if (fact.category === 'location' || hasLocationKeywords(lower)) {
            // Look for entities that aren't characters — they're likely places
            const locations = fact.relatedEntities.filter(
                e => !isCharacterName(e, characterName, userName)
            );
            if (locations.length > 0) {
                // Use the most recently mentioned location
                newLocation = locations[locations.length - 1];
            }
        }

        // ===== RELATIONSHIP CHANGES =====
        if (fact.category === 'relationship' || hasRelationshipKeywords(lower)) {
            // Find character entities (exclude items/locations)
            const characters = fact.relatedEntities.filter(
                e => !isCharacterName(e, characterName, userName) && e.length > 1
            );

            for (const charEntity of characters) {
                const delta = computeRelationshipDelta(lower, fact.importance);
                if (delta !== 0) {
                    relationshipDeltas[charEntity] = (relationshipDeltas[charEntity] || 0) + delta;
                }
            }
        }

        // ===== CONSEQUENCE-BASED UPDATES =====
        if (fact.category === 'consequence' && fact.importance >= 7) {
            // High-importance consequences may impact relationships
            const characters = fact.relatedEntities.filter(
                e => !isCharacterName(e, characterName, userName) && e.length > 1
            );
            for (const charEntity of characters) {
                const delta = computeRelationshipDelta(lower, fact.importance);
                if (delta !== 0) {
                    relationshipDeltas[charEntity] = (relationshipDeltas[charEntity] || 0) + delta;
                }
            }
        }
    }

    // Assemble update
    if (itemsToAdd.length > 0 || itemsToRemove.length > 0) {
        update.inventory = {};
        if (itemsToAdd.length > 0) {
            // Deduplicate and filter already-in-inventory
            update.inventory.add = [...new Set(itemsToAdd)]
                .filter(item => !currentState.inventory.some(i => i.toLowerCase() === item.toLowerCase()));
        }
        if (itemsToRemove.length > 0) {
            update.inventory.remove = [...new Set(itemsToRemove)]
                .filter(item => currentState.inventory.some(i => i.toLowerCase() === item.toLowerCase()));
        }
    }

    if (newLocation && newLocation.toLowerCase() !== currentState.location?.toLowerCase()) {
        update.location = newLocation;
    }

    if (Object.keys(relationshipDeltas).length > 0) {
        update.relationships = {};
        for (const [entity, delta] of Object.entries(relationshipDeltas)) {
            const currentVal = currentState.relationships[entity] || 0;
            const newVal = Math.max(-100, Math.min(100, currentVal + delta));
            if (newVal !== currentVal) {
                update.relationships[entity] = newVal;
            }
        }
    }

    return update;
}

/**
 * Apply world state updates to the current state.
 * Returns the partial WorldState that changed (for updateWorldState).
 */
export function applyWorldStateUpdate(
    currentState: WorldState,
    update: WorldStateUpdate
): Partial<WorldState> | null {
    const changes: Partial<WorldState> = {};
    let hasChanges = false;

    if (update.location) {
        changes.location = update.location;
        hasChanges = true;
    }

    if (update.inventory) {
        let newInventory = [...currentState.inventory];

        if (update.inventory.add && update.inventory.add.length > 0) {
            newInventory = [...newInventory, ...update.inventory.add];
            hasChanges = true;
        }

        if (update.inventory.remove && update.inventory.remove.length > 0) {
            const removeSet = new Set(update.inventory.remove.map(i => i.toLowerCase()));
            newInventory = newInventory.filter(i => !removeSet.has(i.toLowerCase()));
            hasChanges = true;
        }

        if (hasChanges) {
            changes.inventory = newInventory;
        }
    }

    if (update.relationships && Object.keys(update.relationships).length > 0) {
        changes.relationships = {
            ...currentState.relationships,
            ...update.relationships,
        };
        hasChanges = true;
    }

    return hasChanges ? changes : null;
}

// ============================================
// Keyword Pattern Helpers
// ============================================

function isCharacterName(entity: string, characterName: string, userName: string): boolean {
    const lower = entity.toLowerCase();
    return lower === characterName.toLowerCase() ||
        lower === userName.toLowerCase() ||
        lower === 'player' ||
        lower === 'user' ||
        lower === 'you';
}

function hasItemKeywords(text: string): boolean {
    return /\b(obtain|receive|find|pick up|acquire|loot|buy|purchase|craft|take|equip|give|lose|drop|sell|destroy|broke|consumed)\b/i.test(text) ||
        /\b(obtenir|recevoir|trouver|ramasser|acheter|fabriquer|prendre|équiper|donner|perdre|vendre|détruire|casser|consommer)\b/i.test(text);
}

function hasLocationKeywords(text: string): boolean {
    return /\b(arrive|enter|reach|travel|move to|go to|depart|leave|explore|discover|visit)\b/i.test(text) ||
        /\b(arriver|entrer|atteindre|voyager|aller à|partir|quitter|explorer|découvrir|visiter)\b/i.test(text);
}

function hasRelationshipKeywords(text: string): boolean {
    return /\b(befriend|betray|ally|enemy|trust|love|hate|respect|fear|admire|forgive|insult|threaten|help|save)\b/i.test(text) ||
        /\b(ami|trahir|allié|ennemi|confiance|aimer|haïr|respecter|craindre|admirer|pardonner|insulter|menacer|aider|sauver)\b/i.test(text);
}

function matchObtainPatterns(text: string): boolean {
    return /\b(obtain|receive|find|pick up|acquire|loot|buy|purchase|craft|take|equip|reward|given)\b/i.test(text) ||
        /\b(obtenir|recevoir|trouver|ramasser|acheter|fabriquer|prendre|équiper|récompense|donné)\b/i.test(text);
}

function matchLosePatterns(text: string): boolean {
    return /\b(lose|drop|sell|destroy|broke|consumed|gave away|discard|stolen|sacrifice)\b/i.test(text) ||
        /\b(perdre|jeter|vendre|détruire|casser|consommer|donné|sacrifier|volé)\b/i.test(text);
}

/**
 * Compute a relationship delta based on the sentiment of the fact.
 * Returns a positive or negative number indicating relationship change.
 */
function computeRelationshipDelta(text: string, importance: number): number {
    const baseDelta = Math.ceil(importance / 2); // 1-5 based on importance

    // Positive relationship patterns
    const positivePatterns = /\b(befriend|ally|trust|love|respect|admire|forgive|help|save|rescue|heal|protect|grateful|thank|praise)\b/i;
    const frPositivePatterns = /\b(ami|allié|confiance|aimer|respecter|admirer|pardonner|aider|sauver|soigner|protéger|reconnaissant|remercier|louer)\b/i;

    // Negative relationship patterns
    const negativePatterns = /\b(betray|enemy|hate|fear|insult|threaten|attack|kill|murder|steal|deceive|abandon|humiliate|curse)\b/i;
    const frNegativePatterns = /\b(trahir|ennemi|haïr|craindre|insulter|menacer|attaquer|tuer|voler|tromper|abandonner|humilier|maudire)\b/i;

    if (positivePatterns.test(text) || frPositivePatterns.test(text)) {
        return baseDelta;
    }
    if (negativePatterns.test(text) || frNegativePatterns.test(text)) {
        return -baseDelta;
    }

    return 0;
}
