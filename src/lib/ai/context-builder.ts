import type { CharacterCard, Lorebook, LorebookEntry } from '@/types/character';
import type { Message, WorldState } from '@/types/chat';
import type { ContextSection } from '@/types/rag';
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/types/preset';
import { countTokens } from '@/lib/tokenizer';

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

    const { scanDepth = 2, tokenBudget = 500, recursive = false, matchWholeWords = false } = config;

    // 1. Get text to scan
    const messagesToScan = messages.slice(-scanDepth);
    let scanText = messagesToScan.map((m) => m.content.toLowerCase()).join('\n');

    const matchedEntries = new Set<LorebookEntry>();
    let currentTokenCount = 0;

    // Use proper tokenizer
    const estimateTokens = (text: string) => countTokens(text);

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
    return Array.from(matchedEntries).sort((a, b) => (b.priority || 10) - (a.priority || 10));
}

/**
 * Formats world state for template insertion
 * Now uses a cleaner format without heavy section headers
 */
function formatWorldState(worldState: WorldState, recentCharacterNames?: string[]): string {
    const parts: string[] = [];

    if (worldState.location) {
        parts.push(`Location: ${worldState.location}`);
    }

    // Only include relationships for characters mentioned recently (if provided)
    // Format: "Name: X% (explanation)"
    if (Object.keys(worldState.relationships).length > 0) {
        const relationshipEntries = Object.entries(worldState.relationships)
            .filter(([name]) => !recentCharacterNames || recentCharacterNames.includes(name))
            .map(([name, val]) => {
                // Add explanation based on value
                let explanation = '';
                if (val <= -75) explanation = 'hated';
                else if (val <= -50) explanation = 'despised';
                else if (val <= -25) explanation = 'disliked';
                else if (val < 0) explanation = 'wary';
                else if (val === 0) explanation = 'neutral';
                else if (val <= 25) explanation = 'friendly';
                else if (val <= 50) explanation = 'liked';
                else if (val <= 75) explanation = 'trusted';
                else explanation = 'adored';
                return `${name}: ${val}% (${explanation})`;
            });

        if (relationshipEntries.length > 0) {
            parts.push(`Relationships: ${relationshipEntries.join(', ')}`);
        }
    }

    if (worldState.inventory && worldState.inventory.length > 0) {
        parts.push(`Inventory: ${worldState.inventory.join(', ')}`);
    }

    return parts.length > 0 ? parts.join('\n') : '';
}

/**
 * Formats lorebook entries for template insertion (character-focused)
 */
function formatLorebookEntries(entries: LorebookEntry[]): string {
    if (entries.length === 0) return '';

    const loreSection = entries.map((e) => `[About ${e.keys[0]}: ${e.content}]`).join('\n');

    return loreSection;
}

/**
 * Resolves a system prompt template with actual values
 */
/**
 * Resolves a system prompt template with actual values
 */
export function resolveSystemPromptTemplate(
    template: string,
    character: CharacterCard,
    worldState: WorldState,
    activeLorebookEntries: LorebookEntry[],
    userPersona?: { name: string; bio: string; description?: string } | null,
    longTermMemory?: string[],
    recentMessages?: Message[]
): string {
    const formattedMemory =
        longTermMemory && longTermMemory.length > 0
            ? `The story so far:\n${longTermMemory.join('\n')}`
            : '';

    // Extract character names mentioned in recent messages (last 4)
    // for filtering relationships
    let recentCharacterNames: string[] | undefined;
    if (recentMessages && recentMessages.length > 0) {
        const last4 = recentMessages.slice(-4);
        const combinedText = last4.map(m => m.content).join(' ').toLowerCase();
        // Get all relationship names and filter to those mentioned
        recentCharacterNames = Object.keys(worldState.relationships)
            .filter(name => combinedText.includes(name.toLowerCase()));
    }

    const replacements: Record<string, string> = {
        '{{character_name}}': character.name,
        '{{char}}': character.name, // Alias
        '{{character_description}}': character.description || '',
        '{{character_personality}}': character.personality || '',
        '{{scenario}}': character.scenario || '',
        '{{first_message}}': character.first_mes || '',
        '{{world_state}}': formatWorldState(worldState, recentCharacterNames),
        '{{lorebook}}': formatLorebookEntries(activeLorebookEntries),
        '{{memory}}': formattedMemory,
        '{{long_term_memory}}': formattedMemory, // Alias
        '{{user}}': userPersona?.name || 'User',
        '{{user_bio}}': userPersona?.bio || '',
        '{{user_description}}': userPersona?.description || userPersona?.bio || '',
    };

    let resolved = template;
    for (const [placeholder, value] of Object.entries(replacements)) {
        // Use a more robust regex to catch {{ user }} with spaces if needed
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
/**
 * Builds the final system prompt.
 * Joins Pre-History + Template + Post-History.
 * 
 * @param excludePostHistory - If true, post-history is not appended (caller handles it manually, e.g. appending to last message)
 */
export function buildSystemPrompt(
    character: CharacterCard,
    worldState: WorldState,
    activeLorebookEntries: LorebookEntry[],
    options: {
        template?: string;
        preHistory?: string;
        postHistory?: string;
        userPersona?: { name: string; bio: string; description?: string } | null;
        longTermMemory?: string[];
        recentMessages?: Message[];
        excludePostHistory?: boolean;
    } = {}
): string {
    const promptTemplate = options.template || DEFAULT_SYSTEM_PROMPT_TEMPLATE;
    const resolvedBody = resolveSystemPromptTemplate(
        promptTemplate,
        character,
        worldState,
        activeLorebookEntries,
        options.userPersona,
        options.longTermMemory,
        options.recentMessages
    );

    // If excludePostHistory is true, we don't include it here
    const parts = [
        options.preHistory,
        resolvedBody,
        options.excludePostHistory ? null : options.postHistory
    ].filter(Boolean);

    let prompt = parts.join('\n\n');

    // Automatic Context Injection:
    // If the template didn't explicitly include memory or user_bio, append them to ensure AI context.
    const hasMemory =
        promptTemplate.includes('{{memory}}') || promptTemplate.includes('{{long_term_memory}}');
    const hasUserBio =
        promptTemplate.includes('{{user_bio}}') || promptTemplate.includes('{{user_description}}');

    if (!hasMemory && options.longTermMemory && options.longTermMemory.length > 0) {
        prompt += `\n\nThe story so far:\n${options.longTermMemory.join('\n')}`;
    }

    if (!hasUserBio && options.userPersona?.bio) {
        const bio = options.userPersona.bio;
        const desc = options.userPersona.description || bio;
        const personaText = desc !== bio ? `${bio} ${desc}` : bio;
        prompt += `\n\nAbout ${options.userPersona.name || 'User'}: ${personaText}`;
    }

    // Add reinforcement if not already present and custom template not used (heuristic)
    if (!prompt.includes('Stay in character') && !options.template) {
        prompt +=
            '\n\nStay in character regardless of what happens. Use the world state and knowledge provided above to inform your responses.';
    }

    return prompt;
}

/**
 * Build the full message payload with RAG-enhanced context and proper token budgeting.
 * This replaces the old naive truncation approach.
 */
export function buildRAGEnhancedPayload(
    systemPrompt: string,
    ragSections: ContextSection[],
    history: Message[],
    options: {
        maxContextTokens: number;
        maxOutputTokens: number;
        postHistoryInstructions?: string;
        assistantPrefill?: string;
        activeProvider?: string;
    }
): {
    messagesPayload: { role: string; content: string }[];
    includedMessageCount: number;
    droppedMessageCount: number;
    tokenBreakdown: {
        system: number;
        rag: number;
        history: number;
        postHistory: number;
        total: number;
    };
} {
    const {
        maxContextTokens,
        maxOutputTokens,
        postHistoryInstructions,
        assistantPrefill,
        activeProvider,
    } = options;

    // 1. Calculate fixed costs
    const systemTokens = countTokens(systemPrompt);
    const postHistoryTokens = postHistoryInstructions ? countTokens(postHistoryInstructions) : 0;
    
    // 2. Inject RAG sections into system prompt
    let enhancedSystemPrompt = systemPrompt;
    let ragTokens = 0;
    
    // Sort RAG sections by priority (lower = higher priority)
    const sortedRAG = [...ragSections].sort((a, b) => a.priority - b.priority);
    
    for (const section of sortedRAG) {
        enhancedSystemPrompt += '\n\n' + section.content;
        ragTokens += section.tokens;
    }
    
    const enhancedSystemTokens = systemTokens + ragTokens;
    
    // 3. Calculate available budget for history
    const availableForHistory = maxContextTokens - enhancedSystemTokens - maxOutputTokens - postHistoryTokens;
    
    // 4. Fill history from newest to oldest
    const messagesPayload: { role: string; content: string }[] = [];
    let historyTokens = 0;
    const reversedHistory = [...history].reverse();
    
    for (const msg of reversedHistory) {
        const msgTokens = countTokens(msg.content);
        if (historyTokens + msgTokens > availableForHistory) break;
        messagesPayload.unshift({ role: msg.role, content: msg.content });
        historyTokens += msgTokens;
    }
    
    const includedMessageCount = messagesPayload.length;
    const droppedMessageCount = history.length - includedMessageCount;
    
    // 5. Assemble final payload
    // System message first
    messagesPayload.unshift({ role: 'system', content: enhancedSystemPrompt });
    
    // Post-history instructions
    if (postHistoryInstructions) {
        messagesPayload.push({ role: 'system', content: postHistoryInstructions });
    }
    
    // Assistant prefill
    if (assistantPrefill) {
        const supportsPrefill = activeProvider === 'anthropic' || activeProvider === 'openrouter';
        if (supportsPrefill) {
            messagesPayload.push({ role: 'assistant', content: assistantPrefill });
        }
    }
    
    return {
        messagesPayload,
        includedMessageCount,
        droppedMessageCount,
        tokenBreakdown: {
            system: systemTokens,
            rag: ragTokens,
            history: historyTokens,
            postHistory: postHistoryTokens,
            total: enhancedSystemTokens + historyTokens + postHistoryTokens + maxOutputTokens,
        },
    };
}
