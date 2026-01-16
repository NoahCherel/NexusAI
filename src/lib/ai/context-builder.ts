import type { CharacterCard, Lorebook, LorebookEntry } from '@/types/character';
import type { Message, WorldState } from '@/types/chat';

/**
 * Scans recent messages for lorebook keywords and returns matching entries.
 */
export function getActiveLorebookEntries(
    messages: Message[],
    lorebook: Lorebook | undefined,
    maxEntries: number = 5
): LorebookEntry[] {
    if (!lorebook?.entries) return [];

    const entries = lorebook.entries.filter((e) => e.enabled);
    if (entries.length === 0) return [];

    // Get text from last N messages to scan
    // We scan the last 3 messages usually
    const recentText = messages
        .slice(-3)
        .map((m) => m.content.toLowerCase())
        .join('\n');

    const matchedEntries: LorebookEntry[] = [];

    // Simple keyword matching
    for (const entry of entries) {
        const keywords = entry.keys; // Array of strings

        for (const keyword of keywords) {
            const cleanKey = keyword.trim().toLowerCase();
            if (cleanKey && recentText.includes(cleanKey)) {
                matchedEntries.push(entry);
                break; // Found a match for this entry, move to next
            }
        }
    }

    // Sort by priority (higher first) and limit
    return matchedEntries
        .sort((a, b) => (b.priority || 10) - (a.priority || 10))
        .slice(0, maxEntries);
}

/**
 * Builds the final system prompt including:
 * 1. Base system prompt (Persona)
 * 2. World State (Inventory, Location, etc.)
 * 3. Lorebook Entries (World Info)
 */
export function buildSystemPrompt(
    character: CharacterCard,
    worldState: WorldState,
    activeLorebookEntries: LorebookEntry[]
): string {
    let prompt = character.system_prompt || `You are ${character.name}. ${character.description}`;

    // 1. Inject World State
    const worldStateSection = [
        '--- CURRENT WORLD STATE ---',
        worldState.location ? `Location: ${worldState.location}` : null,
        worldState.inventory.length > 0 ? `Inventory: ${worldState.inventory.join(', ')}` : null,
        Object.keys(worldState.relationships).length > 0
            ? `Relationships: ${Object.entries(worldState.relationships)
                  .map(([name, val]) => `${name}: ${val}%`)
                  .join(', ')}`
            : null,
    ]
        .filter(Boolean)
        .join('\n');

    if (worldStateSection.length > 30) {
        // arbitrary length check
        prompt += `\n\n${worldStateSection}`;
    }

    // 2. Inject Lorebook Entries
    if (activeLorebookEntries.length > 0) {
        const loreSection = activeLorebookEntries
            .map((e) => `[Info about ${e.keys[0]}: ${e.content}]`)
            .join('\n');

        prompt += `\n\n--- WORLD KNOWLEDGE ---\n${loreSection}`;
    }

    // 3. Add reinforcement
    prompt += `\n\nStay in character regardless of what happens. Use the world state and knowledge provided above to inform your responses.`;

    return prompt;
}
