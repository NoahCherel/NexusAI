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
     * Optional RAG retrieval. Invoked with a budget once the system prompt size is known.
     * Omit (e.g. impersonation) to skip RAG entirely.
     */
    retrieveRag?: (ragBudget: number) => Promise<ContextSection[]>;
}

export interface BuildConversationPayloadResult {
    /** The STABLE system prompt (cache prefix) — per-turn material is in effectivePostHistory. */
    systemPrompt: string;
    /** The merged dynamic zone: per-turn context + engine contract + preset post-history. */
    effectivePostHistory?: string;
    ragSections: ContextSection[];
    messagesPayload: { role: string; content: string }[];
    includedMessageCount: number;
    droppedMessageCount: number;
    /** system + included history — cache_control anchor for Claude models. */
    stablePrefixLength: number;
    /** Set when the history window moved; caller persists it on the conversation. */
    suggestedCutMessageId?: string;
    tokenBreakdown: {
        system: number;
        rag: number;
        history: number;
        postHistory: number;
        total: number;
    };
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
        retrieveRag,
    } = params;

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
        // A custom prompt remains authoritative; the neutral context only tells the model that
        // this is fictional drafting, then the user's configured instruction closes the request.
        // Avoid calling this "impersonation" in model-facing text: some models interpret that
        // as identity impersonation instead of collaborative drafting for a fictional persona.
        contractBlock = customImpersonationPrompt
            ? `${draftingContext}\n\n${customImpersonationPrompt}`
            : defaultDraftingContract;
    } else if (activeEngine) {
        contractBlock = buildEnginePostHistory(activeEngine, 'generate', { userName });
    }

    // RAG retrieval (optional), budgeted from the now-known system prompt size.
    let ragSections: ContextSection[] = [];
    if (retrieveRag) {
        const systemTokens = countTokens(systemPrompt);
        const proportional = Math.floor(
            (maxContextTokens - systemTokens - maxOutputTokens) * 0.25
        );
        const minimum = Math.floor(maxContextTokens * 0.15);
        const ragBudget = Math.max(proportional, minimum);
        if (ragBudget > 50) {
            try {
                ragSections = await retrieveRag(ragBudget);
            } catch (err) {
                console.warn('[RAG] Context retrieval failed:', err);
            }
        }
    }

    // DYNAMIC zone: everything per-turn, rendered once after the history. Impersonation
    // stays context-light (no canon/RAG/journal) as before.
    const dynamicBlock = buildDynamicContextBlock({
        lorebookEntries: templatePlacesLorebook ? undefined : activeEntries,
        longTermMemory: templatePlacesMemory ? undefined : longTermMemory,
        rpJournal: isImpersonation ? undefined : canon.rpJournal,
        activeCastNames: (canon.canonDossiers ?? []).map((d) => d.character),
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
    const effectivePostHistory =
        (isImpersonation
            ? [dynamicBlock, activePreset?.postHistoryInstructions, contractBlock]
            : [
                  dynamicBlock,
                  contractBlock,
                  activePreset?.postHistoryInstructions,
                  sceneSpeakerBlock,
                  sceneNarratorBlock,
                  sceneEnsembleBlock,
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
        tokenBreakdown,
    } = buildRAGEnhancedPayload(systemPrompt, ragSections, history, {
        maxContextTokens,
        maxOutputTokens,
        postHistoryInstructions: effectivePostHistory,
        // A second system message after history is not portable across OpenAI-compatible
        // providers. A final user drafting request is both valid chat structure and explicit.
        postHistoryRole: isImpersonation ? 'user' : 'system',
        assistantPrefill,
        activeProvider,
        historyCutMessageId: params.historyCutMessageId,
    });

    return {
        systemPrompt,
        effectivePostHistory,
        ragSections,
        messagesPayload,
        includedMessageCount,
        droppedMessageCount,
        stablePrefixLength,
        suggestedCutMessageId,
        tokenBreakdown,
    };
}
