import type { CharacterCard, Lorebook, LorebookEntry } from '@/types/character';
import type { Message, WorldState, ArcCompass } from '@/types/chat';
import type { ContextSection } from '@/types/rag';
import type { CanonDossier } from '@/types/canon';
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/types/preset';
import { countTokens } from '@/lib/tokenizer';

/** Render an immutable canon dossier as a compact, labelled block. */
function formatCanonDossier(d: CanonDossier): string {
    const parts: string[] = [d.identity.trim()];
    if (d.backstory?.trim()) parts.push(`Background: ${d.backstory.trim()}`);
    if (d.relationships?.length) {
        parts.push(
            'Canonical relationships: ' +
                d.relationships.map((r) => `${r.name} — ${r.nature}`).join('; ')
        );
    }
    if (d.abilities?.trim()) parts.push(`Abilities: ${d.abilities.trim()}`);
    return parts.join('\n');
}

interface LorebookConfig {
    scanDepth?: number;
    tokenBudget?: number; // Approximate
    recursive?: boolean;
    matchWholeWords?: boolean;
    characterName?: string; // AI Character name to prioritize in lorebook
    userPersonaName?: string; // User's persona name to prioritize in lorebook
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

    const { scanDepth = 2, tokenBudget = 500, recursive = false, matchWholeWords = false, characterName, userPersonaName } = config;

    // 1. Get text to scan
    const messagesToScan = messages.slice(-scanDepth);
    const scanText = messagesToScan.map((m) => m.content.toLowerCase()).join('\n');

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

    // Forcefully include character's entry if characterName is provided
    if (characterName) {
        const charEntry = entries.find(e => e.keys.some(k => k.toLowerCase() === characterName.toLowerCase()));
        if (charEntry && !matchedEntries.has(charEntry)) {
            const contentTokens = estimateTokens(charEntry.content);
            if (currentTokenCount + contentTokens <= tokenBudget) {
                matchedEntries.add(charEntry);
                currentTokenCount += contentTokens;
            }
        }
    }

    // Forcefully include user persona's entry if userPersonaName is provided
    if (userPersonaName) {
        const userEntry = entries.find(e => e.keys.some(k => k.toLowerCase() === userPersonaName.toLowerCase()));
        if (userEntry && !matchedEntries.has(userEntry)) {
            const contentTokens = estimateTokens(userEntry.content);
            if (currentTokenCount + contentTokens <= tokenBudget) {
                matchedEntries.add(userEntry);
                currentTokenCount += contentTokens;
            }
        }
    }

    // Convert Set to Array and sort:
    // 1. User Persona's entry always first
    // 2. AI Character's entry second
    // 3. Then by priority (higher first)
    // 4. Then alphabetically by first key
    const result = Array.from(matchedEntries);
    return result.sort((a, b) => {
        const aIsUser = userPersonaName ? a.keys.some(k => k.toLowerCase() === userPersonaName.toLowerCase()) : false;
        const bIsUser = userPersonaName ? b.keys.some(k => k.toLowerCase() === userPersonaName.toLowerCase()) : false;
        if (aIsUser && !bIsUser) return -1;
        if (!aIsUser && bIsUser) return 1;

        const aIsChar = characterName ? a.keys.some(k => k.toLowerCase() === characterName.toLowerCase()) : false;
        const bIsChar = characterName ? b.keys.some(k => k.toLowerCase() === characterName.toLowerCase()) : false;
        if (aIsChar && !bIsChar) return -1;
        if (!aIsChar && bIsChar) return 1;

        const priorityDiff = (b.priority || 10) - (a.priority || 10);
        if (priorityDiff !== 0) return priorityDiff;
        return (a.keys[0] || '').localeCompare(b.keys[0] || '');
    });
}

/**
 * Formats world state for template insertion
 * Now uses a cleaner format without heavy section headers
 */
function formatWorldState(_worldState: WorldState, _recentCharacterNames?: string[]): string {
    // Phase 2: the old World Context (location / inventory / symmetric relationship scalars) is
    // retired in favour of the directional Relationship system. The `{{world_state}}` placeholder
    // now resolves to nothing; relationships are injected via the dedicated relationship block.
    return '';
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

    // Extract character names mentioned in recent messages (last 10)
    // for filtering relationships
    let recentCharacterNames: string[] | undefined;
    if (recentMessages && recentMessages.length > 0) {
        const last10 = recentMessages.slice(-10);
        const combinedText = last10
            .map((m) => m.content)
            .join(' ')
            .toLowerCase();
        // Get all relationship names and filter to those mentioned (by full name or first name)
        recentCharacterNames = Object.keys(worldState.relationships).filter((name) => {
            const lowerName = name.toLowerCase();
            const firstName = lowerName.split(' ')[0];
            return combinedText.includes(lowerName) || combinedText.includes(firstName);
        });
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
        storyGuidance?: string;
        scratchpad?: string;
        // Canon Codex: immutable dossiers for the NPCs currently active in the scene.
        canonDossiers?: CanonDossier[];
        // Per-character "in this RP" developments, layered ON TOP of canon (never overwrite).
        rpJournal?: Record<string, string[]>;
        // Full canonical arc outline (Director/GM meta-knowledge) + per-conversation cursor.
        arc?: ArcCompass;
        arcOutline?: string;
        // Canonical characters whose arc matches the current position but who aren't on stage yet.
        dueToAppear?: string[];
        // Directional, multi-axis relationships among the characters on stage (Phase 2).
        relationshipBlock?: string;
        // Transient anti-stall directive for this turn.
        momentumNudge?: string;
        // Approx token budget for all injected canon dossiers (default 1200).
        canonTokenBudget?: number;
        // RP Engine behavioral rules (player autonomy, knowledge limits, dialogue/narration
        // discipline, ban list). Injected before the scene-specific blocks. Already resolved
        // (no {{user}} left). Omitted for impersonation, which uses its own contract.
        engineSystemBlock?: string;
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
        options.excludePostHistory ? null : options.postHistory,
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

    // ===== RP Engine: how to write this scene (player autonomy, knowledge limits,
    // dialogue & narration discipline, anti-cliché). Before the scene-specific blocks so
    // canon/relationships/director stay closest to the live history. =====
    if (options.engineSystemBlock) {
        prompt += `\n\n${options.engineSystemBlock}`;
    }

    if (options.storyGuidance) {
        prompt += `\n\n[Author's Note / Story Guidance: ${options.storyGuidance}]`;
    }

    // ===== Canon Codex: immutable ground truth for active NPCs (+ RP journal on top) =====
    if (options.canonDossiers && options.canonDossiers.length > 0) {
        const budget = options.canonTokenBudget ?? 1200;
        let used = 0;
        const blocks: string[] = [];
        for (const d of options.canonDossiers) {
            const body = formatCanonDossier(d);
            const cost = countTokens(body);
            if (used + cost > budget) continue;
            used += cost;
            blocks.push(
                `[CANON — ${d.character} (ground truth, as of ${d.timelineCap}). This is who ${d.character} IS. ` +
                    `RP events layer on top and never overwrite this. Never contradict this personality, voice, or canonical relationships, ` +
                    `and never act on knowledge from beyond ${d.timelineCap}.]\n${body}`
            );
            const journal = options.rpJournal?.[d.character];
            if (journal && journal.length > 0) {
                blocks.push(
                    `[IN THIS RP — ${d.character}: developments specific to this playthrough, layered on top of canon.]\n- ${journal.join(
                        '\n- '
                    )}`
                );
            }
        }
        if (blocks.length > 0) prompt += `\n\n${blocks.join('\n\n')}`;
    }

    // ===== Directional relationships among the characters on stage (Phase 2) =====
    if (options.relationshipBlock) {
        prompt += `\n\n${options.relationshipBlock}`;
    }

    // ===== Directed progression toward the next canonical arc beat =====
    // Arc Compass is ON by default — only an explicit `enabled: false` turns it off.
    if (options.arc && options.arc.enabled !== false) {
        const arcParts: string[] = [];
        if (options.arc.work) arcParts.push(`Work: ${options.arc.work}`);
        if (options.arcOutline) arcParts.push(`Canonical arc map:\n${options.arcOutline}`);
        if (options.arc.currentPosition)
            arcParts.push(`Current position in the timeline: ${options.arc.currentPosition}`);
        if (options.arc.nextBeat) arcParts.push(`Next beat to steer toward: ${options.arc.nextBeat}`);
        if (options.dueToAppear && options.dueToAppear.length > 0) {
            arcParts.push(
                `Canonical characters who appear around this point — introduce them when it fits ` +
                    `naturally (they may diverge from canon as the RP unfolds): ${options.dueToAppear.join(', ')}`
            );
        }
        if (arcParts.length > 0) {
            prompt +=
                `\n\n[NARRATIVE DIRECTOR — steer the story subtly toward the next canonical beat, ` +
                `via foreshadowing and NPC goals. Never railroad, never spoil; respect the one-primary-beat rule.]\n` +
                arcParts.join('\n');
        }
    }

    // ===== Transient anti-stall nudge (consumed this turn) =====
    if (options.momentumNudge) {
        prompt += `\n\n[MOMENTUM — ${options.momentumNudge}]`;
    }

    if (options.scratchpad) {
        prompt += `\n\n<scratchpad>\n${options.scratchpad}\n</scratchpad>`;
    }

    prompt += `\n\nAt the end of your response, you must output a <scratchpad> block containing your working memory, thoughts, and plans for the next turn. This will be provided to you in the next turn.`;

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
    const availableForHistory =
        maxContextTokens - enhancedSystemTokens - maxOutputTokens - postHistoryTokens;

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
