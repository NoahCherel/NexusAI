import type { CharacterCard, Lorebook, LorebookEntry } from '@/types/character';
import type { Message, WorldState } from '@/types/chat';
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/types/preset';

interface LorebookConfig {
    scanDepth?: number;
    tokenBudget?: number; // Approximate
    recursive?: boolean;
    matchWholeWords?: boolean;
}

/**
 * Scans recent messages for lorebook keywords and returns matching entries.
 * Supports recursive scanning and token budgets.
 */
export function getActiveLorebookEntries(
    messages: Message[],
    lorebook: Lorebook | undefined,
    config: LorebookConfig = {}
): LorebookEntry[] {
    if (!lorebook?.entries) return [];

    const entries = lorebook.entries.filter((e) => e.enabled);
    if (entries.length === 0) return [];

    const {
        scanDepth = 2,
        tokenBudget = 500,
        recursive = false,
        matchWholeWords = false,
    } = config;

    // 1. Get text to scan
    const messagesToScan = messages.slice(-scanDepth);
    let scanText = messagesToScan.map((m) => m.content.toLowerCase()).join('\n');

    const matchedEntries = new Set<LorebookEntry>();
    let currentTokenCount = 0;

    // Helper to estimate tokens (approx 4 chars per token)
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);

    // 2. recursive scan function
    const scanForKeywords = (text: string) => {
        let foundNew = false;

        for (const entry of entries) {
            if (matchedEntries.has(entry)) continue;

            const contentTokens = estimateTokens(entry.content);
            if (currentTokenCount + contentTokens > tokenBudget) continue;

            for (const keyword of entry.keys) {
                const cleanKey = keyword.trim().toLowerCase();
                if (!cleanKey) continue;

                let isMatch = false;

                if (matchWholeWords) {
                    // Regex match for whole word
                    // Escape regex special chars in keyword
                    const escapedKey = cleanKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`\\b${escapedKey}\\b`, 'i');
                    isMatch = regex.test(text);
                } else {
                    isMatch = text.includes(cleanKey);
                }

                if (isMatch) {
                    matchedEntries.add(entry);
                    currentTokenCount += contentTokens;
                    foundNew = true;
                    // If recursive, we append this entry's content to the scan text for next pass?
                    // Actually standard recursion scans the NEW entry's content for OTHER keys.
                    if (recursive) {
                        // We can either recurse immediately or just collect content to scan next
                        // Let's recurse immediately
                        scanForKeywords(entry.content.toLowerCase());
                    }
                    break; // Move to next entry after matching this one
                }
            }
        }
        return foundNew;
    };

    // Initial scan
    scanForKeywords(scanText);

    // Convert Set to Array and sort
    return Array.from(matchedEntries)
        .sort((a, b) => (b.priority || 10) - (a.priority || 10));
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
    activeLorebookEntries: LorebookEntry[],
    userPersonaName: string = 'User'
): string {
    const replacements: Record<string, string> = {
        '{{character_name}}': character.name,
        '{{char}}': character.name, // Alias
        '{{character_description}}': character.description || '',
        '{{character_personality}}': character.personality || '',
        '{{scenario}}': character.scenario || '',
        '{{first_message}}': character.first_mes || '',
        '{{world_state}}': formatWorldState(worldState),
        '{{lorebook}}': formatLorebookEntries(activeLorebookEntries),
        '{{user}}': userPersonaName,
    };

    let resolved = template;
    for (const [placeholder, value] of Object.entries(replacements)) {
        // Use a more robust regex to catch {{ user }} with spaces if needed, but standard is {{key}}
        // Using 'gi' for case-insensitive matching if desired, but usually keys are case-sensitive. 
        // We'll stick to case-insensitive for user/char as they are common typos.
        resolved = resolved.replace(new RegExp(placeholder, 'gi'), value);
    }

    // Clean up empty lines from unused placeholders
    resolved = resolved.replace(/\n{3,}/g, '\n\n');

    return resolved.trim();
}

/**
 * Builds the final system prompt.
 * Joins Pre-History + Template + Post-History.
 */
export function buildSystemPrompt(
    character: CharacterCard,
    worldState: WorldState,
    activeLorebookEntries: LorebookEntry[],
    options: {
        template?: string;
        preHistory?: string;
        postHistory?: string;
        userPersonaName?: string;
    } = {}
): string {
    const promptTemplate = options.template || DEFAULT_SYSTEM_PROMPT_TEMPLATE;
    const resolvedBody = resolveSystemPromptTemplate(
        promptTemplate,
        character,
        worldState,
        activeLorebookEntries,
        options.userPersonaName
    );

    const parts = [
        options.preHistory,
        resolvedBody,
        options.postHistory
    ].filter(Boolean);

    let prompt = parts.join('\n\n');

    // Add reinforcement if not already present and custom template not used (heuristic)
    if (!prompt.includes('Stay in character') && !options.template) {
        prompt += '\n\nStay in character regardless of what happens. Use the world state and knowledge provided above to inform your responses.';
    }

    return prompt;
}

