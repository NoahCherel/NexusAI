// Single assembly point for the prompt payload across generation, preview, and
// impersonation. Centralises the RP-engine layer, the system prompt, the (mode-aware)
// behavioural contract, RAG budgeting, and final payload construction so the three call
// sites can't drift apart or double-inject.

import type { CharacterCard, LorebookEntry } from '@/types/character';
import type { Message, WorldState } from '@/types/chat';
import type { APIPreset } from '@/types/preset';
import type { RPEngine } from '@/types/engine';
import type { ContextSection } from '@/types/rag';
import { buildSystemPrompt, buildRAGEnhancedPayload } from '@/lib/ai/context-builder';
import { buildEngineSystemBlock, buildEnginePostHistory } from '@/lib/ai/rp-engine';
import { countTokens } from '@/lib/tokenizer';

type SystemPromptOptions = NonNullable<Parameters<typeof buildSystemPrompt>[3]>;

export type ConversationMode = 'generate' | 'preview' | 'impersonate';

export interface BuildConversationPayloadParams {
    mode: ConversationMode;
    character: CharacterCard;
    worldState: WorldState;
    activeEntries: LorebookEntry[];
    /** Messages placed after the system prompt (history / simulated history). */
    history: Message[];
    /** Messages used to resolve recency-sensitive blocks; defaults to `history`. */
    recentMessages?: Message[];
    activePreset: APIPreset | null;
    activeEngine: RPEngine | null;
    userPersona?: { name: string; bio: string; description?: string } | null;
    longTermMemory?: string[];
    storyGuidance?: string;
    scratchpad?: string;
    /** Canon Codex options spread into buildSystemPrompt (may carry `injectionMeta`). */
    canonOptions?: Partial<SystemPromptOptions> & { injectionMeta?: unknown };
    assistantPrefill?: string;
    activeProvider?: string;
    maxContextTokens: number;
    maxOutputTokens: number;
    /**
     * Optional RAG retrieval. Invoked with a budget once the system prompt size is known.
     * Omit (e.g. impersonation) to skip RAG entirely.
     */
    retrieveRag?: (ragBudget: number) => Promise<ContextSection[]>;
}

export interface BuildConversationPayloadResult {
    /** The assembled system prompt BEFORE RAG sections are folded in (for the preview UI). */
    systemPrompt: string;
    /** The merged post-history block (engine contract + user's preset post-history). */
    effectivePostHistory?: string;
    ragSections: ContextSection[];
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
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function buildConversationPayload(
    params: BuildConversationPayloadParams
): Promise<BuildConversationPayloadResult> {
    const {
        mode,
        character,
        worldState,
        activeEntries,
        history,
        activePreset,
        activeEngine,
        userPersona,
        longTermMemory,
        storyGuidance,
        scratchpad,
        canonOptions,
        assistantPrefill,
        activeProvider,
        maxContextTokens,
        maxOutputTokens,
        retrieveRag,
    } = params;

    const recentMessages = params.recentMessages ?? history;
    const isImpersonation = mode === 'impersonate';
    const userName = userPersona?.name;

    // Engine system block carries the player-facing contract ("never write the player").
    // Impersonation must NOT receive it — it writes the player on purpose.
    const engineSystemBlock =
        activeEngine && !isImpersonation
            ? buildEngineSystemBlock(activeEngine, { userName })
            : undefined;

    let systemPrompt = buildSystemPrompt(character, worldState, activeEntries, {
        template: activePreset?.systemPromptTemplate,
        preHistory: activePreset?.preHistoryInstructions,
        postHistory: activePreset?.postHistoryInstructions,
        userPersona,
        longTermMemory,
        recentMessages,
        excludePostHistory: true,
        storyGuidance,
        // Impersonation writes the player. It must neither emit a new <scratchpad> nor SEE
        // the prior one — that scratchpad holds the AI's private plans/secrets, and feeding
        // it to the player model would be metagaming.
        scratchpad: isImpersonation ? undefined : scratchpad,
        engineSystemBlock,
        suppressScratchpadInstruction: isImpersonation,
        ...(canonOptions ?? {}),
    });

    // Mode-aware behavioural contract, placed AFTER history (strongest position) and merged
    // with the user's own post-history instructions (never replacing them).
    let contractBlock: string | undefined;
    if (isImpersonation) {
        // Strip the default template's "Do not speak for <user>." so it can't contradict the
        // impersonation contract, then assert the inverted contract after history.
        if (userName) {
            systemPrompt = systemPrompt.replace(
                new RegExp(`\\s*Do not speak for ${escapeRegExp(userName)}\\.?`, 'gi'),
                ''
            );
        }
        systemPrompt = systemPrompt.replace(/\s*Do not speak for \{\{user\}\}\.?/gi, '');

        // Precedence: a custom impersonationPrompt (explicit user config) wins; then the
        // engine's inverted contract; then a sane default.
        contractBlock = activePreset?.impersonationPrompt
            ? `[SYSTEM: ${activePreset.impersonationPrompt.replace(/\{\{user\}\}/gi, userName || 'User')}]`
            : activeEngine
              ? buildEnginePostHistory(activeEngine, 'impersonate', { userName })
              : `[SYSTEM: ${'Write the next message for {{user}}. Stay in character as {{user}}. Do not respond as the AI/Assistant, and do not write or decide for the other characters.'.replace(
                    /\{\{user\}\}/gi,
                    userName || 'User'
                )}]`;
    } else if (activeEngine) {
        contractBlock = buildEnginePostHistory(activeEngine, 'generate', { userName });
    }

    // For impersonation the inverted contract must be the FINAL instruction so a
    // contradictory user post-history can't reclaim priority; for generation the engine
    // checklist leads and the user's post-history follows.
    const effectivePostHistory =
        (isImpersonation
            ? [activePreset?.postHistoryInstructions, contractBlock]
            : [contractBlock, activePreset?.postHistoryInstructions]
        )
            .filter(Boolean)
            .join('\n\n') || undefined;

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

    const { messagesPayload, includedMessageCount, droppedMessageCount, tokenBreakdown } =
        buildRAGEnhancedPayload(systemPrompt, ragSections, history, {
            maxContextTokens,
            maxOutputTokens,
            postHistoryInstructions: effectivePostHistory,
            assistantPrefill,
            activeProvider,
        });

    return {
        systemPrompt,
        effectivePostHistory,
        ragSections,
        messagesPayload,
        includedMessageCount,
        droppedMessageCount,
        tokenBreakdown,
    };
}
