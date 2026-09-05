'use client';

/**
 * One assembly of the conversation context, shared by the visible generation and by every
 * invisible agent of a directed beat.
 *
 * Before this module the composer went through `buildConversationPayload` (card, canon, arc,
 * lorebook, Chronicle, RP journal, relationships, engine contract, preset pre/post-history,
 * history window) while the Director and the character reflections got a hand-built JSON with
 * four to eight truncated messages and hard-coded samplers. The composer therefore wrote from
 * intentions decided by agents that could not remember the story.
 *
 * The rule here is identity by construction:
 * - `buildRetrievalStack` is computed ONCE per beat and passed to every call, so canon,
 *   lorebook and Chronicle cannot drift between agents (and the expensive parts — one
 *   embedding, the sticky-cast write — happen once).
 * - `buildSamplerParams` is the single definition of the sampler body; the foreground fetch
 *   and the background agents both send its result, so a preset change reaches both.
 * - `buildAgentPayload` runs the same builder in the same mode as the composer, with only the
 *   final `agentContract` block differing, and replays the beat's frozen history window.
 */

import type { CharacterCard } from '@/types/character';
import type { Conversation, Message } from '@/types/chat';
import type { APIPreset } from '@/types/preset';
import type { RPEngine } from '@/types/engine';
import type { Lorebook } from '@/types/character';
import { buildCanonOptions } from '@/lib/ai/canon-context';
import { resolveActiveLorebookEntries } from '@/lib/ai/rag-service';
import {
    buildChronicle,
    EMPTY_CHRONICLE,
    type ChronicleResult,
} from '@/lib/ai/hierarchical-summarizer';
import {
    buildConversationPayload,
    type BuildConversationPayloadResult,
    type CanonPayloadOptions,
} from '@/lib/ai/payload-builder';

export interface RetrievalStack {
    canonOptions: CanonPayloadOptions;
    activeEntries: Awaited<ReturnType<typeof resolveActiveLorebookEntries>>;
    /**
     * Lazy and memoised: the builder hands the budget it computed from the REAL system
     * prompt, the first call fixes the text, every later call of the beat gets the same
     * text back whatever budget it passes. Undefined when hierarchical summaries are off.
     */
    chronicle?: (budget: number) => Promise<ChronicleResult>;
}

export interface BuildRetrievalStackParams {
    character: CharacterCard;
    conversation: Conversation | undefined;
    /** The branch history this beat is generated from (trigger message last). */
    history: Message[];
    /** Ids of the whole active branch, for Chronicle branch filtering. */
    activeBranchMessageIds: string[];
    personaName?: string;
    preset: APIPreset | null;
    lorebook: Lorebook | null | undefined;
    enableHierarchicalSummaries: boolean;
    /**
     * Write the sticky-cast map back to the conversation. TRUE only for the visible turn:
     * an agent build must never mutate the store.
     */
    persistSticky?: boolean;
}

/**
 * Canon + lorebook + Chronicle for one beat. Costs one embedding (hybrid lorebook search)
 * and a few IndexedDB reads, so it is computed once and reused by every call of the beat.
 */
export async function buildRetrievalStack(
    params: BuildRetrievalStackParams
): Promise<RetrievalStack> {
    const {
        character,
        conversation,
        history,
        activeBranchMessageIds,
        personaName,
        preset,
        lorebook,
        enableHierarchicalSummaries,
        persistSticky = false,
    } = params;

    const canonOptions = await buildCanonOptions(
        character,
        conversation,
        history,
        personaName || 'the player',
        { persistSticky }
    );

    // Canon material also feeds the lorebook keyword scan: a dossier or journal note can
    // mention a term the raw transcript never spells out.
    const canonScanText = [
        ...(canonOptions.canonDossiers ?? []).map(
            (d) => `${d.character}\n${d.identity}\n${d.backstory}`
        ),
        ...Object.entries(canonOptions.rpJournal ?? {}).flatMap(([name, notes]) => [
            name,
            ...notes,
        ]),
        canonOptions.relationshipBlock ?? '',
    ]
        .filter(Boolean)
        .join('\n');

    const lastUserMsg = history[history.length - 1]?.content || '';
    const activeEntries = await resolveActiveLorebookEntries({
        messages: history,
        lorebook,
        preset,
        characterName: character.name,
        userPersonaName: personaName,
        hybrid: true,
        queryText: lastUserMsg,
        tokenBudget: preset?.lorebookTokenBudget ?? 2000,
        extraScanText: canonScanText || undefined,
    });

    let chronicle: RetrievalStack['chronicle'];
    if (enableHierarchicalSummaries && conversation) {
        const evicted = conversation.historyCutMessageId
            ? Math.max(
                  0,
                  history.findIndex((m) => m.id === conversation.historyCutMessageId)
              )
            : 0;
        let memo: Promise<ChronicleResult> | null = null;
        chronicle = (budget) => {
            memo ??= buildChronicle(conversation.id, budget, evicted, activeBranchMessageIds).catch(
                (error) => {
                    console.warn('[RetrievalStack] Chronicle failed:', error);
                    return EMPTY_CHRONICLE;
                }
            );
            return memo;
        };
    }

    return { canonOptions, activeEntries, chronicle };
}

/**
 * The sampler body. Single source of truth: the foreground `/api/chat` fetch and every
 * background agent send exactly this, so the active preset governs both.
 */
export interface SamplerParams {
    temperature: number;
    maxTokens: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    repetitionPenalty?: number;
    minP?: number;
    stoppingStrings?: string[];
    enableReasoning: boolean;
    useBatchMode: boolean;
}

export function buildSamplerParams(
    preset: APIPreset | null,
    settings: { temperature: number; enableReasoning: boolean; useBatchMode: boolean }
): SamplerParams {
    return {
        temperature: preset?.temperature ?? settings.temperature,
        maxTokens: preset?.maxOutputTokens ?? 2048,
        topP: preset?.topP,
        topK: preset?.topK,
        frequencyPenalty: preset?.frequencyPenalty,
        presencePenalty: preset?.presencePenalty,
        repetitionPenalty: preset?.repetitionPenalty,
        minP: preset?.minP,
        stoppingStrings: preset?.stoppingStrings,
        enableReasoning: preset?.enableReasoning ?? settings.enableReasoning,
        useBatchMode: preset?.useBatchMode ?? settings.useBatchMode,
    };
}

/**
 * Name-prefix assistant turns so a multi-speaker transcript stays attributable. Beat bubbles
 * are already grouped and tagged by `projectSceneBeatsForContext`, so they are left alone.
 */
export function withSpeakerPrefixes(history: Message[]): Message[] {
    return history.map((m) =>
        m.role === 'assistant' && m.speaker && !m.sceneBeatId
            ? { ...m, content: `${m.speaker.name}: ${m.content}` }
            : m
    );
}

export interface AgentPayload {
    messages: { role: string; content: string }[];
    stablePrefixLength: number;
    windowStartMessageId?: string;
    includedMessageCount: number;
    tokenBreakdown: BuildConversationPayloadResult['tokenBreakdown'];
    historyWindow: BuildConversationPayloadResult['historyWindow'];
}

export interface BuildAgentPayloadParams {
    stack: RetrievalStack;
    character: CharacterCard;
    conversation: Conversation | undefined;
    history: Message[];
    preset: APIPreset | null;
    engine: RPEngine | null;
    persona?: { name: string; bio: string; description?: string } | null;
    provider?: string;
    /** Style Guard rules of the branch. The composer carries them in its system prompt. */
    learnedBanList?: string[];
    /** The one block that differs between agents. */
    agentContract: string;
    /** Replay the window planned by the first build of the beat. */
    frozenWindow?: { startMessageId: string };
}

/**
 * The same payload the composer sends, with a different final instruction. Nothing here is
 * persisted: no history anchor, no reserve, no sticky cast, no momentum clear.
 */
export async function buildAgentPayload(params: BuildAgentPayloadParams): Promise<AgentPayload> {
    const { stack, character, conversation, preset, engine, persona, provider } = params;
    const result = await buildConversationPayload({
        mode: 'generate',
        character,
        activeEntries: stack.activeEntries,
        history: withSpeakerPrefixes(params.history),
        recentMessages: params.history,
        activePreset: preset,
        activeEngine: engine,
        learnedBanList: params.learnedBanList,
        userPersona: persona,
        longTermMemory: [...(conversation?.notes || []), ...(character.longTermMemory || [])],
        storyGuidance: conversation?.storyGuidance,
        scratchpad: conversation?.scratchpad,
        // An agent returns JSON, never a chat reply: it must not be asked for a scratchpad.
        enableScratchpad: false,
        canonOptions: stack.canonOptions,
        activeProvider: provider,
        maxContextTokens: preset?.maxContextTokens ?? 16384,
        maxOutputTokens: preset?.maxOutputTokens ?? 2048,
        historyCutMessageId: conversation?.historyCutMessageId,
        dynamicReserveTokens: conversation?.dynamicReserveTokens,
        agentContract: params.agentContract,
        frozenWindow: params.frozenWindow,
        retrieveChronicle: stack.chronicle,
    });
    return {
        messages: result.messagesPayload,
        stablePrefixLength: result.stablePrefixLength,
        windowStartMessageId: result.windowStartMessageId,
        includedMessageCount: result.includedMessageCount,
        tokenBreakdown: result.tokenBreakdown,
        historyWindow: result.historyWindow,
    };
}
