// Single assembly point for the prompt payload across generation, preview, and
// impersonation. Centralises the RP-engine layer, the system prompt, the (mode-aware)
// behavioural contract, RAG budgeting, and final payload construction so the three call
// sites can't drift apart or double-inject.

import type { CharacterCard, LorebookEntry } from '@/types/character';
import type { ArcCompass, Message } from '@/types/chat';
import type { CanonDossier } from '@/types/canon';
import type { APIPreset } from '@/types/preset';
import type { RPEngine } from '@/types/engine';
import type { ContextSection } from '@/types/rag';
import {
    DEFAULT_SYSTEM_PROMPT_TEMPLATE,
    LEGACY_DEFAULT_SYSTEM_PROMPT_TEMPLATE,
} from '@/types/preset';
import {
    buildSystemPrompt,
    buildDynamicContextBlock,
    buildRAGEnhancedPayload,
} from '@/lib/ai/context-builder';
import {
    buildEngineSystemBlock,
    buildEnginePostHistory,
    buildLearnedBanBlock,
} from '@/lib/ai/rp-engine';
import type { ChronicleResult, ChronicleStats } from '@/lib/ai/hierarchical-summarizer';
import { countTokens } from '@/lib/tokenizer';

/** Canon Codex material, split by the builder into stable (dossiers, arc map) and dynamic
 *  (journal, relationships, arc cursor, momentum) zones. Mirrors CanonPromptOptions. */
export interface CanonPayloadOptions {
    canonDossiers?: CanonDossier[];
    rpJournal?: Record<string, string[]>;
    arc?: ArcCompass;
    arcOutline?: string;
    momentumNudge?: string;
    dueToAppear?: string[];
    relationshipBlock?: string;
    canonTokenBudget?: number;
    injectionMeta?: unknown;
}

export type ConversationMode = 'generate' | 'preview' | 'impersonate';

export interface BuildConversationPayloadParams {
    mode: ConversationMode;
    character: CharacterCard;
    activeEntries: LorebookEntry[];
    /** Messages placed after the system prompt (history / simulated history). */
    history: Message[];
    /** Messages used to resolve recency-sensitive blocks; defaults to `history`. */
    recentMessages?: Message[];
    activePreset: APIPreset | null;
    activeEngine: RPEngine | null;
    /** Per-chat learned anti-cliché rules (Style Guard). Injected for generation/preview only. */
    learnedBanList?: string[];
    userPersona?: { name: string; bio: string; description?: string } | null;
    longTermMemory?: string[];
    /**
     * Impersonation only: the one-shot outline the player typed in the input box before
     * asking for a draft ("il ouvre la porte, saute, et combat"). The drafted message must
     * ENACT it. Unlike `storyGuidance` this is not persisted and not an author's note — it
     * describes this single turn, and it never enters the history as a played message.
     */
    impersonationDirective?: string;
    storyGuidance?: string;
    scratchpad?: string;
    /**
     * Per-response <scratchpad> working memory (settings.enableScratchpad). When false, the
     * stored scratchpad is not injected AND the model is not asked to emit one — it costs
     * output tokens on every reply and invalidates prompt caching. Defaults to true so
     * explicit callers/tests keep the legacy behaviour.
     */
    enableScratchpad?: boolean;
    /** Canon Codex options — split into stable/dynamic zones (may carry `injectionMeta`). */
    canonOptions?: CanonPayloadOptions;
    assistantPrefill?: string;
    activeProvider?: string;
    maxContextTokens: number;
    maxOutputTokens: number;
    /** Sticky history-window anchor (prompt-cache hysteresis), from the conversation. */
    historyCutMessageId?: string;
    /** Smoothed dynamic-zone size from the previous turn (`Conversation.dynamicReserveTokens`). */
    dynamicReserveTokens?: number;
    /**
     * Continue-in-place mode (providers without assistant prefill): history ends with the
     * incomplete assistant message; a final instruction demands the continuation only.
     */
    continueFromAssistant?: boolean;
    /**
     * Scene Mode: this generation is ONE character's turn. A final contract restricts the
     * reply to that character's voice/POV (the narrator and other characters have their
     * own turns).
     */
    sceneSpeaker?: string;
    /** The Director's stage direction for this speaker's turn (goal/emotion/initiative). */
    sceneDirection?: string;
    /** Scene Mode: regenerating a NARRATOR message — pure diegetic narration, no dialogue. */
    sceneNarrator?: boolean;
    /** The Director's dramatic goal for the whole beat (shared context). */
    sceneGoal?: string;
    /**
     * Scene Mode, 'unified' style: ONE generation writes the whole directed beat
     * (narration + every on-stage character, interleaved) as a single message.
     * Mutually exclusive with sceneSpeaker.
     */
    sceneEnsemble?: {
        roster: string[];
        directions: { name: string; direction?: string }[];
        sceneGoal?: string;
        /** Narration hint from the Director, to weave into the passage (not verbatim). */
        narrationHint?: string;
        userName?: string;
    };
    /**
     * Final structured contract for an agent turn, placed after history in the same slot the
     * composer uses. Every invisible agent of a directed beat (Director, per-character
     * reflection, Auditor, Story Director) and the composer itself share this seam: identical
     * system prompt and history window, only this last block differs.
     */
    agentContract?: string;
    /** Replay the window of an earlier build of the same beat (see buildRAGEnhancedPayload). */
    frozenWindow?: { startMessageId: string };
    /**
     * Optional Chronicle retrieval (long-term memory). Invoked with a budget once the system
     * prompt size is known. Omit — as impersonation does — to skip memory entirely.
     */
    retrieveChronicle?: (budget: number) => Promise<ChronicleResult>;
}

export interface BuildConversationPayloadResult {
    /** The STABLE system prompt (cache prefix) — per-turn material is in effectivePostHistory. */
    systemPrompt: string;
    /** The merged dynamic zone: per-turn context + engine contract + preset post-history. */
    effectivePostHistory?: string;
    /** The Chronicle, as a section, for the preview. Already inside `effectivePostHistory`. */
    ragSections: ContextSection[];
    /** What the Chronicle managed to include, and what it could not. */
    chronicleStats?: ChronicleStats;
    /**
     * Whether the preset's template renders the lorebook inside the system prompt (vs the
     * dynamic zone). The preview needs it to know where those tokens are already counted.
     */
    templatePlacesLorebook: boolean;
    messagesPayload: { role: string; content: string }[];
    includedMessageCount: number;
    droppedMessageCount: number;
    /** system + included history — cache_control anchor for Claude models. */
    stablePrefixLength: number;
    /** Set when the history window moved; caller persists it on the conversation. */
    suggestedCutMessageId?: string;
    /** Oldest included message — feed back as `frozenWindow` to replay this exact window. */
    windowStartMessageId?: string;
    /** Smoothed dynamic-zone size to persist for next turn (generation only). */
    nextDynamicReserve: number;
    /** What the window did this turn, and why — surfaced in the context preview. */
    historyWindow: {
        action: 'unchanged' | 'cut' | 'expanded' | 'transient-trim';
        reason: string;
        recoverableMessageCount: number;
    };
    tokenBreakdown: {
        system: number;
        rag: number;
        history: number;
        postHistory: number;
        total: number;
        dynamicReserve: number;
        historyBudget: number;
        historyTarget: number;
        historyHeadroom: number;
    };
}

/**
 * Separate UI bubbles from one atomic beat must look like one assistant turn to the next
 * model. Otherwise consecutive assistant messages can be mistaken for independent answers.
 */
export function projectSceneBeatsForContext(history: Message[]): Message[] {
    const projected: Message[] = [];
    for (let index = 0; index < history.length; ) {
        const first = history[index];
        if (first.role !== 'assistant' || !first.sceneBeatId) {
            projected.push(first);
            index++;
            continue;
        }
        const group: Message[] = [];
        while (
            index < history.length &&
            history[index].role === 'assistant' &&
            history[index].sceneBeatId === first.sceneBeatId
        ) {
            group.push(history[index++]);
        }
        projected.push({
            ...first,
            content: group
                .map((message) => {
                    const speaker = message.speaker?.name ?? 'Narrateur';
                    const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const content = message.content.replace(
                        new RegExp(`^\\s*${escaped}\\s*:\\s*`, 'i'),
                        ''
                    );
                    return `[${speaker}]\n${content}`;
                })
                .join('\n\n'),
            // Keep the state snapshot carried by the final bubble on the projected beat.
            storyStateRevisionId: group[group.length - 1].storyStateRevisionId,
        });
    }
    return projected;
}

export async function buildConversationPayload(
    params: BuildConversationPayloadParams
): Promise<BuildConversationPayloadResult> {
    const {
        mode,
        character,
        activeEntries,
        history,
        activePreset,
        activeEngine,
        userPersona,
        longTermMemory,
        storyGuidance,
        scratchpad,
        assistantPrefill,
        activeProvider,
        maxContextTokens,
        maxOutputTokens,
        retrieveChronicle,
    } = params;
    const projectedHistory = projectSceneBeatsForContext(history);
    let projectedCutMessageId = params.historyCutMessageId;
    if (
        projectedCutMessageId &&
        !projectedHistory.some((message) => message.id === projectedCutMessageId)
    ) {
        const sourceBeatId = history.find(
            (message) => message.id === projectedCutMessageId
        )?.sceneBeatId;
        if (sourceBeatId) {
            projectedCutMessageId = projectedHistory.find(
                (message) => message.sceneBeatId === sourceBeatId
            )?.id;
        }
    }

    const recentMessages = params.recentMessages ?? history;
    const isImpersonation = mode === 'impersonate';
    const scratchpadOn = params.enableScratchpad ?? true;
    const userName = userPersona?.name?.trim() || undefined;
    // buildSystemPrompt resolves {{user}} to "User" when no persona is active. Keep the
    // impersonation cleanup and contract on that exact same fallback so the default
    // "Do not speak for User" instruction cannot survive and contradict impersonation.
    const resolvedUserName = userName || 'User';

    // Engine system block carries the player-facing contract ("never write the player").
    // Impersonation must NOT receive it — it writes the player on purpose. The per-chat
    // learned ban list rides alongside it (and applies even when the engine is off, since
    // it's conversation-level feedback), but never during impersonation.
    const engineSystemBlock =
        [
            activeEngine && !isImpersonation
                ? buildEngineSystemBlock(activeEngine, { userName })
                : '',
            !isImpersonation && params.learnedBanList?.length
                ? buildLearnedBanBlock(params.learnedBanList)
                : '',
        ]
            .filter(Boolean)
            .join('\n\n') || undefined;

    // Template: silently upgrade pristine copies of the legacy v1 default to the
    // cache-friendly v2 (per-turn blocks move to the dynamic zone). A CUSTOM template that
    // places {{lorebook}}/{{memory}} itself keeps its own placement — the user chose it —
    // at the (accepted) cost of a colder prompt cache.
    const rawTemplate = activePreset?.systemPromptTemplate;
    const template =
        !rawTemplate || rawTemplate.trim() === LEGACY_DEFAULT_SYSTEM_PROMPT_TEMPLATE.trim()
            ? DEFAULT_SYSTEM_PROMPT_TEMPLATE
            : rawTemplate;
    const templatePlacesLorebook = template.includes('{{lorebook}}');
    const templatePlacesMemory =
        template.includes('{{memory}}') || template.includes('{{long_term_memory}}');

    const canon = params.canonOptions ?? {};

    // STABLE zone: character card, persona, RP engine, canon dossiers (sticky cast,
    // deterministic order), arc map. Byte-identical between turns → provider cache prefix.
    //
    // IMPERSONATION EXCEPTION: the player's ghost-writer must NOT inherit the character's
    // system prompt — no card template, no "you are {char}" framing, no engine, no bans.
    // It drafts the PLAYER's message from the persona + chat history alone (story context
    // still arrives via the dynamic block; the inverted contract closes the request).
    let systemPrompt: string;
    if (isImpersonation) {
        const bio = userPersona?.description || userPersona?.bio || '';
        systemPrompt = [
            `You are ghost-writing the next message of ${resolvedUserName}, the PLAYER's character in an ongoing fictional roleplay. You write as ${resolvedUserName} and ONLY ${resolvedUserName} — never as ${character.name}, the narrator, or any other character.`,
            bio ? `About ${resolvedUserName}: ${bio}` : '',
            `Match ${resolvedUserName}'s established voice, knowledge and current situation from the chat history.`,
        ]
            .filter(Boolean)
            .join('\n\n');
    } else {
        systemPrompt = buildSystemPrompt(character, templatePlacesLorebook ? activeEntries : [], {
            template,
            preHistory: activePreset?.preHistoryInstructions,
            postHistory: activePreset?.postHistoryInstructions,
            userPersona,
            longTermMemory: templatePlacesMemory ? longTermMemory : undefined,
            recentMessages,
            excludePostHistory: true,
            engineSystemBlock,
            suppressScratchpadInstruction: !scratchpadOn,
            canonDossiers: canon.canonDossiers,
            arc: canon.arc,
            arcOutline: canon.arcOutline,
            canonTokenBudget: canon.canonTokenBudget,
        });
    }

    // Mode-aware behavioural contract, placed AFTER history (strongest position) and merged
    // with the user's own post-history instructions (never replacing them).
    let contractBlock: string | undefined;
    if (isImpersonation) {
        // Precedence: a custom impersonationPrompt (explicit user config) wins; then the
        // engine's inverted contract; then a sane default.
        const customImpersonationPrompt = activePreset?.impersonationPrompt?.replace(
            /\{\{user\}\}/gi,
            resolvedUserName
        );
        const draftingContext = `[ROLEPLAY DRAFTING CONTEXT — ${resolvedUserName} is the user's player-character/persona in this fictional roleplay. This is collaborative fiction drafting, not a request to claim or verify anyone's identity.]`;
        const defaultDraftingContract = activeEngine
            ? buildEnginePostHistory(activeEngine, 'impersonate', {
                  userName: resolvedUserName,
              })
            : `${draftingContext}\n\n[Draft one candidate next message for ${resolvedUserName} in their established voice. Output only ${resolvedUserName}'s message; do not answer as the assistant and do not write the other characters.]`;
        // What the player typed in the input box before asking for a draft: an outline of the
        // turn, not a played message. It is placed BEFORE the contract so the contract stays
        // the final instruction (a custom impersonationPrompt must remain the closing word).
        const outline = params.impersonationDirective?.trim();
        const outlineBlock = outline
            ? [
                  `[PLAYER'S OUTLINE — ${resolvedUserName} has sketched what they do or say next:`,
                  `« ${outline} »`,
                  `The outline may be written in any person or tense: "je", "il", "elle" and the like all refer to ${resolvedUserName}. Write ${resolvedUserName}'s message so it enacts exactly this outline: keep every event, its order and its intent; expand it into full prose and dialogue in ${resolvedUserName}'s established voice and point of view; do not add outcomes, decisions or events the player did not sketch. When an action has no written outcome (a fight, a question, an attempt), play it out and stop at the moment the other characters' response becomes necessary; never narrate their reactions.]`,
              ].join('\n')
            : undefined;
        // A custom prompt remains authoritative; the neutral context only tells the model that
        // this is fictional drafting, then the user's configured instruction closes the request.
        // Avoid calling this "impersonation" in model-facing text: some models interpret that
        // as identity impersonation instead of collaborative drafting for a fictional persona.
        contractBlock = (
            customImpersonationPrompt
                ? [draftingContext, outlineBlock, customImpersonationPrompt]
                : [outlineBlock, defaultDraftingContract]
        )
            .filter(Boolean)
            .join('\n\n');
    } else if (activeEngine) {
        contractBlock = buildEnginePostHistory(activeEngine, 'generate', { userName });
    }

    // Chronicle retrieval (optional), budgeted from the now-known system prompt size.
    // A flat share of the room actually left, so the verbatim history always keeps ~70% of
    // it. The old formula had a floor expressed against the TOTAL context (15%), which
    // ignored how much room was really left: a small context plus a big card could starve
    // the history down to zero messages.
    let ragSections: ContextSection[] = [];
    let chronicleStats: ChronicleStats | undefined;
    if (retrieveChronicle) {
        const systemTokens = countTokens(systemPrompt);
        const available = maxContextTokens - systemTokens - maxOutputTokens;
        const chronicleBudget = Math.max(0, Math.floor(available * 0.3));
        if (chronicleBudget > 50) {
            try {
                const chronicle = await retrieveChronicle(chronicleBudget);
                chronicleStats = chronicle.stats;
                if (chronicle.text) {
                    ragSections = [
                        {
                            priority: 1,
                            content: chronicle.text,
                            tokens: countTokens(chronicle.text),
                            label: 'Chronique',
                            type: 'summary',
                        },
                    ];
                }
            } catch (err) {
                console.warn('[Chronicle] Retrieval failed:', err);
            }
        }
    }

    // DYNAMIC zone: everything per-turn, rendered once after the history. Impersonation
    // stays context-light (no canon/RAG/journal) as before.
    const dynamicBlock = buildDynamicContextBlock({
        lorebookEntries: templatePlacesLorebook ? undefined : activeEntries,
        longTermMemory: templatePlacesMemory ? undefined : longTermMemory,
        rpJournal: isImpersonation ? undefined : canon.rpJournal,
        // The journal is keyed by character name, and it used to render ONLY for names with
        // an injected canon dossier — so the card's own character, who is always on stage and
        // is exactly who the journal is mostly about, never got theirs. Their names are added
        // here; a name with no notes renders nothing, so this costs nothing when empty.
        activeCastNames: Array.from(
            new Set(
                [
                    ...(canon.canonDossiers ?? []).map((d) => d.character),
                    character.name,
                    character.displayName,
                ].filter((name): name is string => !!name)
            )
        ),
        relationshipBlock: canon.relationshipBlock,
        ragSections,
        arcPosition: canon.arc?.enabled !== false ? canon.arc?.currentPosition : undefined,
        arcNextBeat: canon.arc?.enabled !== false ? canon.arc?.nextBeat : undefined,
        dueToAppear: canon.dueToAppear,
        storyGuidance,
        momentumNudge: canon.momentumNudge,
        // Impersonation must not SEE the prior scratchpad (private AI plans → metagaming).
        scratchpad: isImpersonation || !scratchpadOn ? undefined : scratchpad,
    });

    // For impersonation the inverted contract must be the FINAL instruction so a
    // contradictory user post-history can't reclaim priority; for generation the engine
    // checklist leads and the user's post-history follows. The dynamic context block always
    // comes first (it's reference material, not the instruction).
    // Continue-in-place: the continuation demand goes LAST — it must beat everything.
    const continueBlock = params.continueFromAssistant
        ? `[CONTINUE — Your previous message above is INCOMPLETE. Continue it from exactly where it stops, mid-flow. Do not repeat any earlier text, do not summarize, do not start over. Output ONLY the continuation.]`
        : undefined;
    // Scene Mode 'unified': one generation writes the whole directed beat as a single
    // flowing passage — narration + on-stage characters interleaved, one distinct voice
    // each, the player untouched.
    const ensemble = params.sceneEnsemble;
    const sceneEnsembleBlock = ensemble
        ? [
              `[ENSEMBLE SCENE — Write the next beat as ONE flowing passage: diegetic narration plus the reactions of the on-stage characters, interleaved naturally (action, dialogue, silence). On stage: ${ensemble.roster.join(', ')}.`,
              ensemble.sceneGoal ? `\nDramatic goal of this beat: ${ensemble.sceneGoal}` : '',
              ensemble.narrationHint
                  ? `\nScene development to weave in (rephrase, don't quote): ${ensemble.narrationHint}`
                  : '',
              ensemble.directions.length > 0
                  ? `\nStage directions:\n${ensemble.directions
                        .map((d) => `- ${d.name}: ${d.direction || 'react in character'}`)
                        .join('\n')}`
                  : '',
              `\nEach character keeps their OWN canon voice; a character whose reaction doesn't matter may stay silent. Never write, decide or speak for ${ensemble.userName || 'the player'}. 2 to 5 paragraphs.]`,
          ].join('')
        : undefined;

    // Scene Mode: narrator regeneration — scene description only, no character dialogue.
    const sceneNarratorBlock = params.sceneNarrator
        ? `[SCENE TURN — Write ONLY the narrator: 1 to 3 sentences of diegetic scene narration (atmosphere, events, environment, passage of time). No character dialogue, no player actions, no meta.]`
        : undefined;

    // Scene Mode: per-speaker contract (one character per turn, their voice only), with
    // the Director's stage direction when provided.
    const sceneSpeakerBlock = params.sceneSpeaker
        ? [
              `[SCENE TURN — This reply belongs to ${params.sceneSpeaker} ALONE. Write only ${params.sceneSpeaker}: their voice, their point of view, only what they can know. React to the latest beats. Do not write for the player, the narrator, or any other character — they get their own turns. 1 to 3 paragraphs.`,
              params.sceneGoal ? ` Dramatic goal of this beat: ${params.sceneGoal}.` : '',
              params.sceneDirection
                  ? ` Director's guidance for this turn: ${params.sceneDirection}`
                  : '',
              ']',
          ].join('')
        : undefined;
    const agentContractBlock = params.agentContract;
    // Card-level post-history (V2 `post_history_instructions`) — imported cards ship their
    // own "jailbreak"/behavioural closer. `{{original}}` splices the preset's post-history
    // in; otherwise the card's block follows the preset's. Never for impersonation (the
    // ghost-writer must not inherit the character's contract).
    const rawCardPostHistory = character.post_history_instructions?.trim() || '';
    const resolvedCardPostHistory = rawCardPostHistory
        ? rawCardPostHistory
              .replace(/\{\{char\}\}|\{\{character_name\}\}/gi, character.name)
              .replace(/\{\{user\}\}/gi, resolvedUserName)
        : '';
    const cardSplicesOriginal = /\{\{original\}\}/i.test(resolvedCardPostHistory);
    const presetPostHistory = activePreset?.postHistoryInstructions;
    const mergedPostHistory = cardSplicesOriginal
        ? resolvedCardPostHistory.replace(/\{\{original\}\}/gi, presetPostHistory || '')
        : [presetPostHistory, resolvedCardPostHistory].filter(Boolean).join('\n\n') || undefined;

    const effectivePostHistory =
        (isImpersonation
            ? [dynamicBlock, presetPostHistory, contractBlock]
            : [
                  dynamicBlock,
                  contractBlock,
                  mergedPostHistory,
                  sceneSpeakerBlock,
                  sceneNarratorBlock,
                  sceneEnsembleBlock,
                  agentContractBlock,
                  continueBlock,
              ]
        )
            .filter(Boolean)
            .join('\n\n') || undefined;

    const {
        messagesPayload,
        includedMessageCount,
        droppedMessageCount,
        stablePrefixLength,
        suggestedCutMessageId,
        windowStartMessageId,
        nextDynamicReserve,
        historyWindow,
        tokenBreakdown,
    } = buildRAGEnhancedPayload(systemPrompt, ragSections, projectedHistory, {
        maxContextTokens,
        maxOutputTokens,
        postHistoryInstructions: effectivePostHistory,
        // A second system message after history is not portable across OpenAI-compatible
        // providers. A final user drafting request is both valid chat structure and explicit.
        postHistoryRole: isImpersonation ? 'user' : 'system',
        assistantPrefill,
        activeProvider,
        historyCutMessageId: projectedCutMessageId,
        dynamicReserveTokens: params.dynamicReserveTokens,
        frozenWindow: params.frozenWindow,
    });

    return {
        systemPrompt,
        effectivePostHistory,
        ragSections,
        chronicleStats,
        templatePlacesLorebook,
        messagesPayload,
        includedMessageCount,
        droppedMessageCount,
        stablePrefixLength,
        suggestedCutMessageId,
        windowStartMessageId,
        nextDynamicReserve,
        historyWindow,
        tokenBreakdown,
    };
}
