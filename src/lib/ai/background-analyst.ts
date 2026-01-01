/**
 * Background Analyst - World State Tracker
 * 
 * Analyzes chat messages for action verbs and updates the world state.
 * Uses a free-tier model (Gemini Flash) to extract state changes.
 */

// Regex patterns to detect action verbs in messages
export const ACTION_TRIGGERS = /\b(prends?|donne|ramasse|récupère|pose|dépose|jette|lâche|va\s+[àa]|entre|sors?|part|arrive|attaque|frappe|tue|blesse|soigne|parle|dis|crie|mange|bois|achète|vends|ouvre|ferme|utilise|équipe|porte|retire|enlève)\b/i;

export interface WorldStateChanges {
    inventory_add: string[];
    inventory_remove: string[];
    location: string | null;
    relationship_changes: Record<string, number>;
}

export const ANALYST_PROMPT = `Tu es un analyseur de récit. Ton rôle est d'extraire les changements d'état du monde depuis un message de roleplay.

RÈGLES:
- Analyse UNIQUEMENT les ACTIONS CONCRÈTES décrites dans le message
- Ne déduis PAS ce qui pourrait arriver, seulement ce qui EST décrit
- Pour les relations, utilise des valeurs relatives: +5 (petit), +10 (moyen), -10 (négatif)
- location = null si pas de changement de lieu explicite

Réponds UNIQUEMENT en JSON valide, sans commentaires:
{
  "inventory_add": [],
  "inventory_remove": [],
  "location": null,
  "relationship_changes": {}
}

EXEMPLES:
Message: "*Je prends l'épée sur la table*"
→ {"inventory_add": ["épée"], "inventory_remove": [], "location": null, "relationship_changes": {}}

Message: "*Je donne la potion à Aria et elle sourit*"
→ {"inventory_add": [], "inventory_remove": ["potion"], "location": null, "relationship_changes": {"Aria": 5}}

Message: "*J'entre dans la forêt sombre*"
→ {"inventory_add": [], "inventory_remove": [], "location": "Forêt sombre", "relationship_changes": {}}`;

/**
 * Check if a message contains action verbs that warrant analysis
 */
export function shouldAnalyzeMessage(message: string): boolean {
    return true; // Always analyze to catch all actions regardless of language/phrasing
}

/**
 * Parse the analyst response into WorldStateChanges
 */
export function parseAnalystResponse(text: string): WorldStateChanges | null {
    try {
        // Try to extract JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);

        // Validate structure
        return {
            inventory_add: Array.isArray(parsed.inventory_add) ? parsed.inventory_add : [],
            inventory_remove: Array.isArray(parsed.inventory_remove) ? parsed.inventory_remove : [],
            location: typeof parsed.location === 'string' ? parsed.location : null,
            relationship_changes: typeof parsed.relationship_changes === 'object' ? parsed.relationship_changes : {},
        };
    } catch (error) {
        console.error('[BackgroundAnalyst] Failed to parse response:', text, error);
        return null;
    }
}

/**
 * Merge world state changes into current state
 */
export function mergeWorldState(
    current: { inventory: string[]; location: string; relationships: Record<string, number> },
    changes: WorldStateChanges
): { inventory: string[]; location: string; relationships: Record<string, number> } {
    // Update inventory
    let newInventory = [...current.inventory];

    // Add new items (avoid duplicates)
    for (const item of changes.inventory_add) {
        if (!newInventory.includes(item)) {
            newInventory.push(item);
        }
    }

    // Remove items
    newInventory = newInventory.filter(item =>
        !changes.inventory_remove.some(r =>
            r.toLowerCase() === item.toLowerCase()
        )
    );

    // Update location if changed
    const newLocation = changes.location || current.location;

    // Update relationships (additive)
    const newRelationships = { ...current.relationships };
    for (const [name, delta] of Object.entries(changes.relationship_changes)) {
        const currentValue = newRelationships[name] || 50; // Default 50 (neutral)
        newRelationships[name] = Math.max(0, Math.min(100, currentValue + delta));
    }

    return {
        inventory: newInventory,
        location: newLocation,
        relationships: newRelationships,
    };
}
