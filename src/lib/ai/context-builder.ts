import type { CharacterCard, Lorebook, LorebookEntry } from '@/types/character';
import type { Message, WorldState } from '@/types/chat';
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/types/preset';

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
 * Formats world state for template insertion
 */
function formatWorldState(worldState: WorldState): string {
    const parts = [
        '--- CURRENT WORLD STATE ---',
        worldState.location ? `Location: ${worldState.location}` : null,
        worldState.inventory.length > 0 ? `Inventory: ${worldState.inventory.join(', ')}` : null,
        Object.keys(worldState.relationships).length > 0
            ? `Relationships: ${Object.entries(worldState.relationships)
                .map(([name, val]) => `${name}: ${val}%`)
                .join(', ')}`
            : null,
    ].filter(Boolean);

    return parts.length > 1 ? parts.join('\n') : '';
}

/**
 * Formats lorebook entries for template insertion
 */
function formatLorebookEntries(entries: LorebookEntry[]): string {
    if (entries.length === 0) return '';

    const loreSection = entries
        .map((e) => `[Info about ${e.keys[0]}: ${e.content}]`)
        .join('\n');

    return `--- WORLD KNOWLEDGE ---\n${loreSection}`;
}

/**
 * Resolves a system prompt template with actual values
 */
export function resolveSystemPromptTemplate(
    template: string,
    character: CharacterCard,
    worldState: WorldState,
    activeLorebookEntries: LorebookEntry[]
): string {
    const replacements: Record<string, string> = {
        '{{character_name}}': character.name,
        '{{character_description}}': character.description || '',
        '{{character_personality}}': character.personality || '',
        '{{scenario}}': character.scenario || '',
        '{{first_message}}': character.first_mes || '',
        '{{world_state}}': formatWorldState(worldState),
        '{{lorebook}}': formatLorebookEntries(activeLorebookEntries),
    };

    let resolved = template;
    for (const [placeholder, value] of Object.entries(replacements)) {
        resolved = resolved.replace(new RegExp(placeholder, 'g'), value);
    }

    // Clean up empty lines from unused placeholders
    resolved = resolved.replace(/\n{3,}/g, '\n\n');

    return resolved.trim();
}

/**
 * Builds the final system prompt.
 * Uses template if provided, otherwise uses default structure.
 */
export function buildSystemPrompt(
    character: CharacterCard,
    worldState: WorldState,
    activeLorebookEntries: LorebookEntry[],
    template?: string
): string {
    const promptTemplate = template || DEFAULT_SYSTEM_PROMPT_TEMPLATE;
    let prompt = resolveSystemPromptTemplate(promptTemplate, character, worldState, activeLorebookEntries);

    // Add reinforcement if not already present
    if (!prompt.includes('Stay in character')) {
        prompt += '\n\nStay in character regardless of what happens. Use the world state and knowledge provided above to inform your responses.';
    }

    return prompt;
}

