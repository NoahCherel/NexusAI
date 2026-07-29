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
export function resolveSystemPromptTemplate(
    template: string,
    character: CharacterCard,
    _worldState: WorldState,
    activeLorebookEntries: LorebookEntry[],
    userPersona?: { name: string; bio: string; description?: string } | null,
    longTermMemory?: string[],
    _recentMessages?: Message[]
): string {
    const formattedMemory =
        longTermMemory && longTermMemory.length > 0
            ? `The story so far:\n${longTermMemory.join('\n')}`
            : '';

    const replacements: Record<string, string> = {
        '{{character_name}}': character.name,
        '{{char}}': character.name, // Alias
        '{{character_description}}': character.description || '',
        '{{character_personality}}': character.personality || '',
        '{{scenario}}': character.scenario || '',
        '{{first_message}}': character.first_mes || '',
        // The old World Context (location / inventory / scalar relationships) is retired in
        // favour of the directional Relationship system — the placeholder resolves to nothing.
        '{{world_state}}': '',
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
 * Builds the STABLE system prompt — everything here must be byte-identical from one turn to
 * the next (provider prompt caching keys on this prefix). Per-turn material (active lorebook,
 * RAG, relationships, arc position, momentum, scratchpad, memory) lives in the dynamic
 * context block rendered AFTER the chat history — see `buildDynamicContextBlock`.
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
        // Canon Codex: immutable dossiers for the NPCs on stage (sticky cast). Rendered in
        // deterministic (alphabetical) order so the cached prefix doesn't flap.
        canonDossiers?: CanonDossier[];
        // Full canonical arc outline (Director/GM meta-knowledge — static per work).
        arc?: ArcCompass;
        arcOutline?: string;
        // Approx token budget for all injected canon dossiers (default 1200).
        canonTokenBudget?: number;
        // RP Engine behavioral rules (player autonomy, knowledge limits, dialogue/narration
        // discipline, ban list). Injected before the scene-specific blocks. Already resolved
        // (no {{user}} left). Omitted for impersonation, which uses its own contract.
        engineSystemBlock?: string;
        // When true, the trailing "emit a <scratchpad>" instruction is omitted (impersonation
        // or scratchpad disabled).
        suppressScratchpadInstruction?: boolean;
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

    // Automatic Context Injection: if the template didn't explicitly include the user bio,
    // append it (stable — the persona rarely changes). Long-term memory is NOT auto-appended
    // any more: it changes over time and lives in the dynamic context block after history.
    const hasUserBio =
        promptTemplate.includes('{{user_bio}}') || promptTemplate.includes('{{user_description}}');

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

    // ===== Canon Codex: immutable ground truth for the sticky cast. Alphabetical order so
    // the cached prefix is deterministic. The per-playthrough RP journal is dynamic and
    // rendered after history. =====
    if (options.canonDossiers && options.canonDossiers.length > 0) {
        const budget = options.canonTokenBudget ?? 1200;
        let used = 0;
        const blocks: string[] = [];
        const ordered = [...options.canonDossiers].sort((a, b) =>
            a.character.localeCompare(b.character)
        );
        for (const d of ordered) {
            const body = formatCanonDossier(d);
            const cost = countTokens(body);
            if (used + cost > budget) continue;
            used += cost;
            blocks.push(
                `[CANON — ${d.character} (ground truth, as of ${d.timelineCap}). This is who ${d.character} IS. ` +
                    `RP events layer on top and never overwrite this. Never contradict this personality, voice, or canonical relationships, ` +
                    `and never act on knowledge from beyond ${d.timelineCap}.]\n${body}`
            );
        }
        if (blocks.length > 0) prompt += `\n\n${blocks.join('\n\n')}`;
    }

    // ===== Director framing + the (static) canonical arc map. The moving parts — current
    // position, next beat, due-to-appear — are rendered in the dynamic context block. =====
    // Arc Compass is ON by default — only an explicit `enabled: false` turns it off.
    if (options.arc && options.arc.enabled !== false) {
        const arcParts: string[] = [];
        if (options.arc.work) arcParts.push(`Work: ${options.arc.work}`);
        if (options.arcOutline) arcParts.push(`Canonical arc map:\n${options.arcOutline}`);
        if (arcParts.length > 0) {
            prompt +=
                `\n\n[NARRATIVE DIRECTOR — steer the story subtly toward the next canonical beat, ` +
                `via foreshadowing and NPC goals. Never railroad, never spoil; respect the one-primary-beat rule. ` +
                `The current timeline position and next beat are given in the CURRENT CONTEXT block after the chat.]\n` +
                arcParts.join('\n');
        }
    }

    // Impersonation returns the generated text straight into the user's message, so it must
    // NOT be asked to emit a <scratchpad> (it would leak into the player's line).
    if (!options.suppressScratchpadInstruction) {
        prompt += `\n\nAt the end of your response, you must output a <scratchpad> block containing your working memory, thoughts, and plans for the next turn. This will be provided to you in the next turn.`;
    }

    // Add reinforcement if not already present and custom template not used (heuristic)
    if (!prompt.includes('Stay in character') && !options.template) {
        prompt +=
            '\n\nStay in character regardless of what happens. Use the world state and knowledge provided above to inform your responses.';
    }

    return prompt;
}

/** Everything `buildDynamicContextBlock` may render — all of it is per-turn material. */
export interface DynamicContextOptions {
    /** Active lorebook entries (when the template does NOT place them via {{lorebook}}). */
    lorebookEntries?: LorebookEntry[];
    /** Long-term memory / notes (when the template does NOT place them via {{memory}}). */
    longTermMemory?: string[];
    /** Per-character "in this RP" developments, filtered to the on-stage cast. */
    rpJournal?: Record<string, string[]>;
    /** Names whose journal entries should be rendered (the sticky cast). */
    activeCastNames?: string[];
    /** Directional relationships among the characters on stage. */
    relationshipBlock?: string;
    /** RAG sections (story summary, relevant facts, related scenes), already budgeted. */
    ragSections?: ContextSection[];
    /** Arc cursor — the moving part of the Director block. */
    arcPosition?: string;
    arcNextBeat?: string;
    dueToAppear?: string[];
    /** User-written narrative guidance (author's note). */
    storyGuidance?: string;
    /** Transient anti-stall directive (consumed this turn). */
    momentumNudge?: string;
    /** The model's own working memory from the previous turn. */
    scratchpad?: string;
}

/**
 * Render the per-turn context as ONE block, placed AFTER the chat history (in the
 * post-history message). Keeping every per-turn element out of the system prompt is what
 * makes the stable prefix cacheable; recency also gives these details more weight.
 */
export function buildDynamicContextBlock(options: DynamicContextOptions): string {
    const parts: string[] = [];

    if (options.lorebookEntries && options.lorebookEntries.length > 0) {
        parts.push(formatLorebookEntries(options.lorebookEntries));
    }

    if (options.longTermMemory && options.longTermMemory.length > 0) {
        parts.push(`The story so far:\n${options.longTermMemory.join('\n')}`);
    }

    if (options.rpJournal && options.activeCastNames) {
        for (const name of options.activeCastNames) {
            const journal = options.rpJournal[name];
            if (journal && journal.length > 0) {
                parts.push(
                    `[IN THIS RP — ${name}: developments specific to this playthrough, layered on top of canon.]\n- ${journal.join(
                        '\n- '
                    )}`
                );
            }
        }
    }

    if (options.relationshipBlock) {
        parts.push(options.relationshipBlock);
    }

    const arcParts: string[] = [];
    if (options.arcPosition)
        arcParts.push(`Current position in the timeline: ${options.arcPosition}`);
    if (options.arcNextBeat) arcParts.push(`Next beat to steer toward: ${options.arcNextBeat}`);
    if (options.dueToAppear && options.dueToAppear.length > 0) {
        arcParts.push(
            `Canonical characters who appear around this point — introduce them when it fits ` +
                `naturally (they may diverge from canon as the RP unfolds): ${options.dueToAppear.join(', ')}`
        );
    }
    if (arcParts.length > 0) {
        parts.push(`[ARC]\n${arcParts.join('\n')}`);
    }

    if (options.ragSections && options.ragSections.length > 0) {
        const sorted = [...options.ragSections].sort((a, b) => a.priority - b.priority);
        parts.push(...sorted.map((s) => s.content));
    }

    if (options.storyGuidance) {
        parts.push(`[Author's Note / Story Guidance: ${options.storyGuidance}]`);
    }

    if (options.momentumNudge) {
        parts.push(`[MOMENTUM — ${options.momentumNudge}]`);
    }

    if (options.scratchpad) {
        parts.push(`<scratchpad>\n${options.scratchpad}\n</scratchpad>`);
    }

    if (parts.length === 0) return '';

    return (
        `[CURRENT CONTEXT — up-to-date reference for this turn. The durable rules and canon above still apply.]\n\n` +
        parts.join('\n\n')
    );
}

/**
 * Build the full message payload with proper token budgeting and a CACHE-STABLE shape:
 *   [ stable system ] [ history window (sticky cut) ] [ dynamic context + instructions ]
 *
 * RAG sections are NOT folded into the system prompt any more — the caller merges them into
 * `postHistoryInstructions` (the dynamic zone); they're passed here only for token
 * accounting. The history window uses hysteresis: it only moves when the budget overflows,
 * and then cuts a whole block (25% headroom) so the prefix stays stable for many turns.
 */
export function buildRAGEnhancedPayload(
    systemPrompt: string,
    ragSections: ContextSection[],
    history: Message[],
    options: {
        maxContextTokens: number;
        maxOutputTokens: number;
        /** The merged dynamic-context + behavioural-contract block (after history). */
        postHistoryInstructions?: string;
        /** Defaults to system. Impersonation uses user for provider-compatible task framing. */
        postHistoryRole?: 'system' | 'user';
        assistantPrefill?: string;
        activeProvider?: string;
        /** Sticky window anchor: id of the oldest message currently in the API window. */
        historyCutMessageId?: string;
    }
): {
    messagesPayload: { role: string; content: string }[];
    includedMessageCount: number;
    droppedMessageCount: number;
    /** system + included history — the cache_control anchor (everything after is dynamic). */
    stablePrefixLength: number;
    /** Set when the window moved this turn; the caller persists it on the conversation. */
    suggestedCutMessageId?: string;
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
        postHistoryRole = 'system',
        assistantPrefill,
        activeProvider,
        historyCutMessageId,
    } = options;

    // 1. Fixed costs. RAG lives inside postHistoryInstructions; count it separately only
    // for the breakdown display.
    const systemTokens = countTokens(systemPrompt);
    const postHistoryTokens = postHistoryInstructions ? countTokens(postHistoryInstructions) : 0;
    const ragTokens = ragSections.reduce((sum, s) => sum + s.tokens, 0);

    // 2. Budget for history
    const availableForHistory =
        maxContextTokens - systemTokens - maxOutputTokens - postHistoryTokens;

    // 3. Apply the sticky cut (hysteresis): reuse the previous window start if it still
    // exists on this branch.
    let workingHistory = history;
    if (historyCutMessageId) {
        const cutIdx = history.findIndex((m) => m.id === historyCutMessageId);
        if (cutIdx > 0) workingHistory = history.slice(cutIdx);
    }

    const perMessageTokens = workingHistory.map((m) => countTokens(m.content));
    const totalHistoryTokens = perMessageTokens.reduce((a, b) => a + b, 0);

    let included: Message[];
    let historyTokens: number;
    let suggestedCutMessageId: string | undefined;

    if (totalHistoryTokens <= availableForHistory) {
        // Fits — window unchanged, prefix stable, cache can hit.
        included = workingHistory;
        historyTokens = totalHistoryTokens;
    } else {
        // Overflow — refit newest-first against 75% of the budget, leaving headroom so the
        // window then stays put for many turns (block cut instead of per-message slide).
        const target = Math.max(0, Math.floor(availableForHistory * 0.75));
        included = [];
        historyTokens = 0;
        for (let i = workingHistory.length - 1; i >= 0; i--) {
            const t = perMessageTokens[i];
            if (historyTokens + t > target) break;
            included.unshift(workingHistory[i]);
            historyTokens += t;
        }
        if (included.length > 0) suggestedCutMessageId = included[0].id;
    }

    const messagesPayload: { role: string; content: string }[] = included.map((m) => ({
        role: m.role,
        content: m.content,
    }));
    const includedMessageCount = messagesPayload.length;
    const droppedMessageCount = history.length - includedMessageCount;

    // 4. Assemble final payload — stable prefix first.
    messagesPayload.unshift({ role: 'system', content: systemPrompt });
    const stablePrefixLength = messagesPayload.length;

    // Dynamic zone: per-turn context + behavioural contract.
    if (postHistoryInstructions) {
        messagesPayload.push({ role: postHistoryRole, content: postHistoryInstructions });
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
        stablePrefixLength,
        suggestedCutMessageId,
        tokenBreakdown: {
            system: systemTokens,
            rag: ragTokens,
            history: historyTokens,
            postHistory: postHistoryTokens,
            total: systemTokens + historyTokens + postHistoryTokens + maxOutputTokens,
        },
    };
}
