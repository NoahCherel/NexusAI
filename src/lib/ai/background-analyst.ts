/**
 * Background Analyst - World State Tracker
 *
 * Analyzes chat messages for action verbs and updates the world state.
 * Uses a free-tier model (Gemini Flash) to extract state changes.
 */

// Regex patterns to detect action verbs in messages (English)
export const ACTION_TRIGGERS =
    /\b(take|give|pick\s*up|grab|drop|put\s*down|throw|go\s+to|enter|exit|leave|arrive|attack|hit|kill|wound|heal|speak|say|shout|eat|drink|buy|sell|open|close|use|equip|wear|remove)\b/i;

export interface WorldStateChanges {
    inventory_add: string[];
    inventory_remove: string[];
    location: string | null;
    relationship_changes: Record<string, number>;
}

export const ANALYST_PROMPT = `You are a narrative analyzer tracking the state of a roleplay game.
Your task is to analyze the latest message/action and determine if it changes the world state.

CRITICAL INSTRUCTIONS FOR RELATIONSHIPS:
- You must consider the User's Persona (Role) and the context provided in "User Reference".
- be REALISTIC. Relationships evolve slowly.
- Minor friendly interactions (agreement, small talk) should only yield +1 or +2.
- Minor hostile interactions (snark, disagreement) should only yield -1 or -2.
- Reserve large changes (+/- 10 or more) for SIGNIFICANT events only (saving a life, betrayal, murder).
- Hostile/Aggressive actions (attacking, insulting, threatening) MUST result in NEGATIVE relationship changes.
- Friendly/Helpful actions (giving gifts, saving, complimenting) result in POSITIVE changes.
- If NPCs are rallying AGAINST the User, this represents a NEGATIVE shift.
- Do NOT assume interaction implies friendship. Use the context.

RULES:
- Analyze ONLY the CONCRETE ACTIONS described in the message
- inventory_add: Items clearly acquired.
- inventory_remove: Items lost/consumed/given away.
- location: Only if clearly moved to a new place.
- relationship_changes: Delta values. Default is 0.

Respond ONLY in valid JSON, no comments:
{
  "inventory_add": [],
  "inventory_remove": [],
  "location": null,
  "relationship_changes": {}
}

EXAMPLES:
Message: "I draw my sword and attack the guard."
→ { "inventory_add": [], "inventory_remove": [], "location": null, "relationship_changes": {"Guard": -15} }

Message: "I heal the wounded soldier."
→ { "inventory_add": [], "inventory_remove": [], "location": null, "relationship_changes": {"Soldier": +10} }

Message: "The King shouts: 'Seize him! He is our enemy!'"
→ { "inventory_add": [], "inventory_remove": [], "location": null, "relationship_changes": {"King": -10} }`;

/**
 * Check if a message contains action verbs that warrant analysis
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function shouldAnalyzeMessage(_message: string): boolean {
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

        // Sanitize JSON: fix common AI mistakes like "+20" (should be "20")
        // Replace ": +" with ": " to handle cases like {"key": +20}
        const sanitizedJson = jsonMatch[0].replace(/:\s*\+(\d)/g, ': $1');

        const parsed = JSON.parse(sanitizedJson);

        // Validate structure
        return {
            inventory_add: Array.isArray(parsed.inventory_add) ? parsed.inventory_add : [],
            inventory_remove: Array.isArray(parsed.inventory_remove) ? parsed.inventory_remove : [],
            location: typeof parsed.location === 'string' ? parsed.location : null,
            relationship_changes:
                typeof parsed.relationship_changes === 'object' ? parsed.relationship_changes : {},
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
    newInventory = newInventory.filter(
        (item) => !changes.inventory_remove.some((r) => r.toLowerCase() === item.toLowerCase())
    );

    // Update location if changed
    const newLocation = changes.location || current.location;

    // Update relationships (additive)
    const newRelationships = { ...current.relationships };
    for (const [name, delta] of Object.entries(changes.relationship_changes)) {
        const currentValue = newRelationships[name] ?? 0; // Default 0 (neutral) - changed from 50
        // Clamp between -100 (Hated) and 100 (Devotion)
        newRelationships[name] = Math.max(-100, Math.min(100, currentValue + delta));
    }

    return {
        inventory: newInventory,
        location: newLocation,
        relationships: newRelationships,
    };
}

export const LOREBOOK_CONSOLIDATION_PROMPT = `You are a legendary Lorekeeper. Your task is to organize and consolidate the Lorebook of a roleplay game.
Receive a list of Lorebook Entries (Keywords + Content).
Identify entries that are:
1. Redundant (exact duplicates) -> Merge
2. Overlapping (same concept, different details) -> Merge into one comprehensive entry
3. Fragmented (related details split across entries) -> Merge

Maintain all distinct characters, places, and concepts as separate entries.
Do NOT merge unrelated things.

For merged entries:
- Combine keywords (remove duplicates).
- Rewrite content to be concise, comprehensive, and consistent.

Return JSON ONLY:
{
  "consolidated": [
    {
      "originalindices": [0, 2], // Indices of original entries being merged
      "keywords": ["key1", "key2"],
      "content": "Merged content..."
    }
  ],
  "unchanged": [1, 3] // Indices of entries that should stay exactly as is
}
`;

export interface LorebookConsolidationChange {
    originalIndices: number[];
    keywords: string[];
    content: string;
}

export interface LorebookConsolidationResult {
    consolidated: LorebookConsolidationChange[];
    unchanged: number[]; // Indices
}

export function parseConsolidationResponse(text: string): LorebookConsolidationResult | null {
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);
        return {
            consolidated: Array.isArray(parsed.consolidated)
                ? parsed.consolidated.map((c: Record<string, unknown>) => ({
                      originalIndices: c.originalindices || c.originalIndices || [],
                      keywords: c.keywords || [],
                      content: c.content || '',
                  }))
                : [],
            unchanged: Array.isArray(parsed.unchanged) ? parsed.unchanged : [],
        };
    } catch (e) {
        console.error('Failed to parse consolidation response', e);
        return null;
    }
}
