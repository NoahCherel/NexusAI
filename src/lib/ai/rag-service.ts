/**
 * Lorebook resolution and context preview.
 *
 * Long-term memory used to live here too — atomic facts and vector chunk retrieval, scored
 * with cosine similarity and temporal decay. Both were removed: they duplicated the
 * hierarchical summaries without being readable or editable, and the model could not tell
 * that the three blocks overlapped. Memory is now the Chronicle alone
 * (see `hierarchical-summarizer.ts`).
 */

import type { ContextSection } from '@/types/rag';
import type { Message } from '@/types/chat';
import type { Lorebook, LorebookEntry } from '@/types/character';
import { getActiveLorebookEntries } from './context-builder';
import { embedText, cosineSimilarity, getSimilarityThresholds } from './embedding-service';
import { countTokens } from '@/lib/tokenizer';

// ============================================
// Lorebook Resolution (single entry point)
// ============================================

/** Subset of an API preset that drives lorebook resolution. */
export interface LorebookPresetConfig {
    useLorebooks?: boolean;
    lorebookScanDepth?: number;
    lorebookTokenBudget?: number;
    lorebookRecursiveScanning?: boolean;
    matchWholeWords?: boolean;
}

/**
 * Single shared resolver for the active lorebook entries (chat generation, context preview,
 * impersonation). Honours the preset's `useLorebooks` switch, optionally runs the hybrid
 * keyword+semantic search, and falls back to the pure keyword scan on error or when hybrid
 * is not applicable.
 */
export async function resolveActiveLorebookEntries(options: {
    messages: Message[];
    lorebook: Lorebook | null | undefined;
    preset: LorebookPresetConfig | null;
    characterName: string;
    userPersonaName?: string;
    /** Run the hybrid keyword+semantic search (embeds `queryText`). */
    hybrid?: boolean;
    /** Query for the semantic leg; defaults to the last message's content. */
    queryText?: string;
    /** Token budget for the selected entries (callers keep their historical defaults). */
    tokenBudget?: number;
    /**
     * Extra text scanned for keyword triggers alongside recent messages — the canon
     * dossiers / RP journal / relations injected this turn. This is what makes lorebook
     * entries fire on facts the OTHER memory systems bring up (the "lorebook doesn't see
     * facts" problem): a canon dossier mentioning "Soul Society" now triggers that entry
     * even if no recent message names it.
     */
    extraScanText?: string;
}): Promise<LorebookEntry[]> {
    const {
        messages,
        lorebook,
        preset,
        characterName,
        userPersonaName,
        hybrid = false,
        queryText,
        tokenBudget,
        extraScanText,
    } = options;

    if (!(preset?.useLorebooks ?? true)) return [];

    if (hybrid && lorebook?.entries && lorebook.entries.length > 0) {
        try {
            const query = queryText ?? messages[messages.length - 1]?.content ?? '';
            const queryEmbedding = await embedText(query, 'query');
            return await hybridLorebookSearch(query, queryEmbedding, lorebook.entries, messages, {
                scanDepth: preset?.lorebookScanDepth,
                tokenBudget,
                matchWholeWords: preset?.matchWholeWords,
                characterName,
                userPersonaName,
                extraScanText,
            });
        } catch (err) {
            console.warn('[RAG] Hybrid lorebook search failed, falling back:', err);
        }
    }

    return getActiveLorebookEntries(messages, lorebook ?? undefined, {
        scanDepth: preset?.lorebookScanDepth,
        tokenBudget,
        recursive: preset?.lorebookRecursiveScanning,
        matchWholeWords: preset?.matchWholeWords,
        characterName,
        userPersonaName,
        extraScanText,
    });
}

// ============================================
// Hybrid Lorebook Search
// ============================================

/**
 * Enhanced lorebook search combining keyword matching with semantic similarity.
 */
export async function hybridLorebookSearch(
    queryText: string,
    queryEmbedding: number[],
    entries: LorebookEntry[],
    recentMessages: Message[],
    config: {
        scanDepth?: number;
        tokenBudget?: number;
        matchWholeWords?: boolean;
        characterName?: string;
        userPersonaName?: string;
        extraScanText?: string;
    } = {}
): Promise<LorebookEntry[]> {
    const { scanDepth = 4, tokenBudget = 500, matchWholeWords = false, characterName, userPersonaName, extraScanText } = config;

    if (!entries || entries.length === 0) return [];

    const enabledEntries = entries.filter((e) => e.enabled);
    if (enabledEntries.length === 0) return [];

    // 1. Keyword matching (existing behavior) — over recent messages AND the other memory
    // systems' injected text (canon/journal/relations), so entries fire on facts too.
    const messagesToScan = recentMessages.slice(-scanDepth);
    const scanText =
        messagesToScan.map((m) => m.content.toLowerCase()).join('\n') +
        '\n' +
        queryText.toLowerCase() +
        (extraScanText ? '\n' + extraScanText.toLowerCase() : '');

    const keywordMatches = new Set<string>();
    const semanticScores = new Map<string, number>();

    for (const entry of enabledEntries) {
        // Keyword match
        for (const keyword of entry.keys) {
            const cleanKey = keyword.trim().toLowerCase();
            if (!cleanKey) continue;

            if (matchWholeWords) {
                const escapedKey = cleanKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b${escapedKey}\\b`, 'i');
                if (regex.test(scanText)) {
                    keywordMatches.add(entry.keys[0]); // Use first key as ID
                    break;
                }
            } else {
                if (scanText.includes(cleanKey)) {
                    keywordMatches.add(entry.keys[0]);
                    break;
                }
            }
        }

        // Semantic similarity (if embedding available)
        if (queryEmbedding.length > 0) {
            const entryText = `${entry.keys.join(' ')} ${entry.content}`;
            const entryEmbedding = await embedText(entryText, 'passage');
            const sim = cosineSimilarity(queryEmbedding, entryEmbedding);
            semanticScores.set(entry.keys[0], sim);
        }
    }

    // 2. Combine results: keyword matches get priority, then semantic
    const scored = enabledEntries.map((entry) => {
        const key = entry.keys[0];
        const isKeywordMatch = keywordMatches.has(key);
        const semanticScore = semanticScores.get(key) || 0;

        // Keyword match = guaranteed inclusion (score boost)
        const score = isKeywordMatch ? 1.0 + semanticScore : semanticScore;

        return { entry, score };
    });

    // Sort by score, then by priority, then alphabetically
    scored.sort((a, b) => {
        // User Persona entry always first
        if (userPersonaName) {
            const aIsUser = a.entry.keys.some(k => k.toLowerCase() === userPersonaName.toLowerCase());
            const bIsUser = b.entry.keys.some(k => k.toLowerCase() === userPersonaName.toLowerCase());
            if (aIsUser && !bIsUser) return -1;
            if (!aIsUser && bIsUser) return 1;
        }
        // Character entry second
        if (characterName) {
            const aIsChar = a.entry.keys.some(k => k.toLowerCase() === characterName.toLowerCase());
            const bIsChar = b.entry.keys.some(k => k.toLowerCase() === characterName.toLowerCase());
            if (aIsChar && !bIsChar) return -1;
            if (!aIsChar && bIsChar) return 1;
        }
        if (b.score !== a.score) return b.score - a.score;
        const priorityDiff = (b.entry.priority || 10) - (a.entry.priority || 10);
        if (priorityDiff !== 0) return priorityDiff;
        return (a.entry.keys[0] || '').localeCompare(b.entry.keys[0] || '');
    });

    // 3. Fill within token budget
    const result: LorebookEntry[] = [];
    let currentTokens = 0;

    for (const { entry, score } of scored) {
        // Always include User Persona and AI Character if they exist
        const isUser = userPersonaName && entry.keys.some(k => k.toLowerCase() === userPersonaName.toLowerCase());
        const isChar = characterName && entry.keys.some(k => k.toLowerCase() === characterName.toLowerCase());
        
        // Skip low semantic scores (unless keyword matched — score > 1.0 means keyword
        // match, or it's a core character). The "strong semantic" bar depends on the
        // embedding space: e5 similarities are compressed high (~0.8 = strong), the
        // TF-IDF fallback keeps the legacy 0.3.
        const strongSemantic = getSimilarityThresholds().min > 0.5 ? 0.8 : 0.3;
        if (score < strongSemantic && !isUser && !isChar) continue;

        const entryTokens = countTokens(entry.content);
        if (currentTokens + entryTokens > tokenBudget) continue;

        result.push(entry);
        currentTokens += entryTokens;
    }

    return result;
}

// ============================================
// Context Preview Builder
// ============================================

export interface ContextPreviewInput {
    /** The system prompt as actually sent (canon/lorebook blocks still inside). */
    systemPrompt: string;
    /** The Chronicle, already merged into `postHistory` — shown, not re-counted. */
    ragSections: ContextSection[];
    /** Only the messages that made the window, as they go on the wire. */
    historyMessages: { role: string; content: string }[];
    postHistory?: string;
    maxContextTokens: number;
    maxOutputTokens: number;
    activeLorebookEntries?: { keys: string[]; content: string }[];
    /** Where the preset's template renders the lorebook — decides where it is counted. */
    lorebookPlacement: 'system' | 'post-history';
    /**
     * Casting metadata used to expose what's injected vs ignored, so the user can see
     * exactly which canon fiches reach the model (and which were excluded because they're
     * stubs / disabled / not mentioned in the recent scene).
     */
    canonInjection?: {
        injectedNames: string[]; // dossiers actually rendered in the system prompt
        ignoredStubs: string[]; // stubs that won't be injected (no identity fetched)
        ignoredDisabled: string[]; // dossiers explicitly toggled off
        scanDepth: number; // how many recent messages were scanned
        dueToAppear?: string[]; // characters hinted to the Director (arc-matched)
    };
    /** History-window accounting — drives the "why isn't my budget full?" warnings. */
    tokenBreakdown?: {
        historyBudget: number;
        historyHeadroom: number;
        dynamicReserve: number;
    };
    historyWindow?: { recoverableMessageCount: number };
    /** Non-zero `uncoveredEvictedMessages` means real, silent memory loss. */
    chronicleStats?: { uncoveredEvictedMessages: number };
}

/**
 * Build a full context preview showing exactly what would be sent to the AI.
 *
 * The total used to be inflated: the canon section re-counted blocks already inside the
 * system prompt, and the Chronicle was counted both as its own section and inside the
 * post-history block that contains it. Sections that merely display material counted
 * elsewhere now carry `countedIn` and contribute zero.
 */
export async function buildContextPreview(input: ContextPreviewInput): Promise<{
    sections: ContextSection[];
    totalTokens: number;
    maxTokens: number;
    warnings: string[];
}> {
    const {
        systemPrompt,
        ragSections,
        historyMessages,
        postHistory,
        maxContextTokens,
        maxOutputTokens,
        activeLorebookEntries,
        lorebookPlacement,
        canonInjection,
    } = input;

    const sections: ContextSection[] = [];
    const warnings: string[] = [];

    // 1. System prompt (strip lorebook AND canon blocks for cleaner preview)
    let displaySystemPrompt = systemPrompt;

    // Strip lorebook entries from system prompt display (they're shown in their own section)
    if (activeLorebookEntries && activeLorebookEntries.length > 0) {
        for (const entry of activeLorebookEntries) {
            const lorebookLine = `[About ${entry.keys[0]}: ${entry.content}]`;
            displaySystemPrompt = displaySystemPrompt.replace(lorebookLine, '');
        }
    }

    // Strip CANON blocks (shown in their own section). The block spans multiple lines from a
    // bracketed label until a blank line.
    displaySystemPrompt = displaySystemPrompt.replace(
        /\[CANON — [^\]]+\][\s\S]*?(?=\n\n|\n\[|$)/g,
        '⟨bloc canon — voir la section Canon⟩'
    );

    // Clean up excessive whitespace from stripping
    displaySystemPrompt = displaySystemPrompt.replace(/\n{3,}/g, '\n\n').trim();

    const sysTokens = countTokens(systemPrompt); // Use original for accurate token count
    sections.push({
        priority: 0,
        content: displaySystemPrompt,
        tokens: sysTokens,
        label: 'Prompt système',
        type: 'system',
    });

    // 2. Canon dossiers — shows EXACTLY which casting fiches reached the model, plus why the
    // others were excluded. Display only: every token here is already in the system prompt.
    if (canonInjection) {
        const { injectedNames, ignoredStubs, ignoredDisabled, scanDepth, dueToAppear } =
            canonInjection;

        // Pull the rendered blocks straight from the system prompt so the user reads the
        // literal text the model will read. `[IN THIS RP]` and `[RELATIONSHIPS]` are NOT
        // here — they live in the dynamic zone, so they show up under post-history.
        const canonBlocks = systemPrompt.match(/\[CANON — [^\]]+\][\s\S]*?(?=\n\n|\n\[|$)/g) || [];

        const lines: string[] = [];
        lines.push('— Ce que le modèle voit de votre casting —');
        lines.push(
            `Portée : les ${scanDepth} dernier(s) message(s) ont été analysés à la recherche de noms du casting mentionnés dans la scène.`
        );
        if (injectedNames.length > 0) {
            lines.push(`Dossiers injectés (${injectedNames.length}) : ${injectedNames.join(', ')}`);
        } else {
            lines.push(
                'Dossiers injectés : aucun. Aucun membre du casting n’a été mentionné dans les messages récents, OU toutes les correspondances sont des ébauches / désactivées.'
            );
        }
        if (dueToAppear && dueToAppear.length > 0) {
            lines.push(
                `Suggérés au Directeur (attendus autour de cet arc) : ${dueToAppear.join(', ')}`
            );
        }
        if (ignoredStubs.length > 0) {
            lines.push(
                `Exclus — ébauches (fiche pas encore récupérée, cliquez sur « Récupérer la fiche complète ») : ${ignoredStubs.join(', ')}`
            );
        }
        if (ignoredDisabled.length > 0) {
            lines.push(`Exclus — désactivés par l’utilisateur : ${ignoredDisabled.join(', ')}`);
        }
        if (canonBlocks.length > 0) {
            lines.push('');
            lines.push('— Blocs littéraux injectés dans le prompt système —');
            lines.push(canonBlocks.join('\n\n'));
        }
        const content = lines.join('\n');
        sections.push({
            priority: 1,
            content,
            tokens: countTokens(content),
            // Short on purpose: section labels sit next to a badge and a token count, and on a
            // phone a long one wrapped to a word per line. The explanation lives in the body.
            label: `Dossiers du canon (${injectedNames.length} injectés)`,
            type: 'canon',
            countedIn: 'system',
        });
    }

    // 3. Lorebook entries — rendered either inside the system prompt or in the dynamic zone,
    // depending on whether the preset's template has a {{lorebook}} placeholder.
    if (activeLorebookEntries && activeLorebookEntries.length > 0) {
        // Keep the order they were passed in (User Persona first, then AI Character, then
        // priority/alphabetical).
        const lorebookContent = activeLorebookEntries
            .map((e) => `[About ${e.keys[0]}: ${e.content}]`)
            .join('\n');
        sections.push({
            priority: 1,
            content: lorebookContent,
            tokens: countTokens(lorebookContent),
            label: `Lorebook (${activeLorebookEntries.length} entrées)`,
            type: 'lorebook',
            countedIn: lorebookPlacement,
        });
    }

    // 4. The Chronicle — displayed on its own, but physically part of the post-history block.
    for (const section of ragSections) {
        sections.push({ ...section, countedIn: 'post-history' });
    }

    // 5. Message history. Display and accounting are deliberately separate: the transcript is
    // decorated with localized role labels for readability, but the count must match what the
    // payload builder measures — the raw content, message by message.
    const roleDisplayLabels: Record<string, string> = {
        user: 'utilisateur',
        assistant: 'assistant',
        system: 'système',
    };
    const historyContent = historyMessages
        .map((m) => `[${roleDisplayLabels[m.role] ?? m.role}]: ${m.content}`)
        .join('\n\n');
    const historyTokens = historyMessages.reduce((sum, m) => sum + countTokens(m.content), 0);
    sections.push({
        priority: 10,
        content: historyContent,
        tokens: historyTokens,
        label: `Historique de discussion (${historyMessages.length} msgs)`,
        type: 'history',
    });

    // 6. Post-history (dynamic zone) — the Chronicle above is inside this.
    if (postHistory) {
        sections.push({
            priority: 11,
            content: postHistory,
            tokens: countTokens(postHistory),
            label: 'Instructions post-historique',
            type: 'post-history',
        });
    }

    const totalTokens =
        sections.reduce((sum, s) => sum + (s.countedIn ? 0 : s.tokens), 0) + maxOutputTokens;

    if (totalTokens > maxContextTokens) {
        warnings.push(
            `⚠️ Le contexte dépasse la limite : ${totalTokens} / ${maxContextTokens} tokens (dont ${maxOutputTokens} réservés pour la sortie)`
        );
    }

    const usedRatio = totalTokens / maxContextTokens;
    if (usedRatio > 0.9 && usedRatio <= 1.0) {
        warnings.push(`⚡ Le contexte est à ${Math.round(usedRatio * 100)}% de sa capacité`);
    }

    // The Chronicle is now the ONLY thing that remembers evicted messages. If it is behind,
    // that stretch of the story is simply gone — worth saying out loud.
    if (input.chronicleStats && input.chronicleStats.uncoveredEvictedMessages > 0) {
        warnings.push(
            `⚠️ ${input.chronicleStats.uncoveredEvictedMessages} message(s) sont sortis de la fenêtre sans avoir été résumés : le modèle ne s'en souvient plus. Le rattrapage se fait automatiquement au fil des messages suivants.`
        );
    }

    // Makes the hysteresis legible instead of mysterious: room is free AND there is history
    // to reclaim, so the window will widen shortly.
    const tb = input.tokenBreakdown;
    if (
        tb &&
        input.historyWindow &&
        tb.historyBudget > 0 &&
        tb.historyHeadroom > tb.historyBudget * 0.25 &&
        input.historyWindow.recoverableMessageCount > 0
    ) {
        warnings.push(
            `ℹ️ ${tb.historyHeadroom} tokens libres dans le budget d'historique et ${input.historyWindow.recoverableMessageCount} message(s) récupérables — la fenêtre s'élargira au prochain tour.`
        );
    }

    if (tb && tb.historyBudget > 0 && tb.dynamicReserve >= (tb.historyBudget + tb.dynamicReserve) * 0.45) {
        warnings.push(
            `⚠️ La zone dynamique (chronique, lorebook, canon) sature sa réserve — réduisez le budget lorebook pour rendre de la place à l'historique.`
        );
    }

    return {
        sections,
        totalTokens,
        maxTokens: maxContextTokens,
        warnings,
    };
}

