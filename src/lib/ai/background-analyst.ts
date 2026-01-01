/**
 * Background Analyst - World State Tracker
 * 
 * Analyzes chat messages for action verbs and updates the world state.
 * Uses a free-tier model (Gemini Flash) to extract state changes.
 */

// Regex patterns to detect action verbs in messages (English)
export const ACTION_TRIGGERS = /\b(take|give|pick\s*up|grab|drop|put\s*down|throw|go\s+to|enter|exit|leave|arrive|attack|hit|kill|wound|heal|speak|say|shout|eat|drink|buy|sell|open|close|use|equip|wear|remove)\b/i;

export interface WorldStateChanges {
    inventory_add: string[];
    inventory_remove: string[];
    location: string | null;
    relationship_changes: Record<string, number>;
}

export const ANALYST_PROMPT = `You are a narrative analyzer. Your role is to extract world state changes from a roleplay message.

RULES:
- Analyze ONLY the CONCRETE ACTIONS described in the message
- Do NOT infer what might happen, only what IS described
- For relationships, use relative values: +5 (small), +10 (medium), -10 (negative)
- location = null if no explicit location change

Respond ONLY in valid JSON, no comments:
{
  "inventory_add": [],
  "inventory_remove": [],
  "location": null,
  "relationship_changes": {}
}

EXAMPLES:
Message: "*I take the sword from the table*"
→ {"inventory_add": ["sword"], "inventory_remove": [], "location": null, "relationship_changes": {}}

Message: "*I give the potion to Aria and she smiles*"
→ {"inventory_add": [], "inventory_remove": ["potion"], "location": null, "relationship_changes": {"Aria": 5}}

Message: "*I enter the dark forest*"
→ {"inventory_add": [], "inventory_remove": [], "location": "Dark forest", "relationship_changes": {}}`;;

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
