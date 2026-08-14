'use client';

/**
 * Background memory pipeline for the chat page:
 * - owns the Chronicle's auto-summary effect (L0 Fragment → L1 Section → L2 Arc), and
 * - exposes `runPostBeat` (arc capture, momentum, relations) so the generation flow has a
 *   single post-response entry point.
 *
 * Everything here runs on the unified background layer (backgroundAICall resolves its own
 * keys — NanoGPT quota or free OpenRouter rotation).
 */

import { useEffect, useRef } from 'react';
import type { CharacterCard } from '@/types/character';
import type { Message } from '@/types/chat';
import { useSettingsStore } from '@/stores/settings-store';
import { useChatStore } from '@/stores/chat-store';
import { backgroundAICall } from '@/lib/ai/background-ai';
import { getAdaptiveChunkSize } from '@/lib/ai/message-quality';

/**
 * Fragments produced in a single run while the Chronicle is behind the eviction boundary.
 * Bounded so a very stale conversation doesn't fire dozens of background calls at once —
 * `backgroundAICall` already rate-limits to one call every 2s, and the next sent message
 * resumes the catch-up.
 */
const CATCHUP_L0_PER_RUN = 3;
import {
    shouldCreateL0Summary,
    shouldCreateL1Summary,
    shouldCreateL2Summary,
    getNextChunkToSummarize,
    getL0SummariesForL1,
    getL1SummariesForL2,
    parseSummarizationResponse,
    buildL0Prompt,
    buildL1Prompt,
    buildL2Prompt,
    createSummary,
    DEFAULT_CHUNK_SIZE,
    SUMMARIZATION_PROMPT_L0,
    SUMMARIZATION_PROMPT_L1,
    SUMMARIZATION_PROMPT_L2,
} from '@/lib/ai/hierarchical-summarizer';
import { getSummariesByConversation } from '@/lib/db';
import { runPostBeatAnalyses, type PostBeatParams } from '@/lib/ai/post-beat';

export type { PostBeatParams };

interface UseBackgroundPipelineParams {
    character: CharacterCard | null | undefined;
    activeConversationId: string | null;
    /** Active-branch messages (drives the summary thresholds). */
    messages: Message[];
    /** Gate: no background work without a usable foreground key (historical behaviour). */
    currentApiKey: string | null;

}

export function useBackgroundPipeline({
    character,
    activeConversationId,
    messages,
    currentApiKey,
}: UseBackgroundPipelineParams): { runPostBeat: (params: PostBeatParams) => void } {
    const lastSummarizedCount = useRef(0); // Track last summarized message count

    // The count is per-conversation: without this reset, leaving a 300-message chat
    // would silently block summaries in any shorter conversation opened after it.
    useEffect(() => {
        lastSummarizedCount.current = 0;
    }, [activeConversationId]);
    const isSummarizingRef = useRef(false); // Concurrency guard for summarization

    // Hierarchical Auto-Summary & Fact Extraction Logic
    useEffect(() => {
        const { enableHierarchicalSummaries, backgroundModel } = useSettingsStore.getState();
        const runHierarchicalSummary = async () => {
            if (!enableHierarchicalSummaries) return;
            if (!character || !activeConversationId || messages.length === 0 || !currentApiKey)
                return;

            // Concurrency guard: prevent overlapping summary runs
            if (isSummarizingRef.current) return;

            // Skip if message count hasn't changed since last summarization
            if (messages.length <= lastSummarizedCount.current) return;

            isSummarizingRef.current = true;
            try {
                const existingSummaries = await getSummariesByConversation(activeConversationId);
                const { personas, activePersonaId } = useSettingsStore.getState();
                const activePersona = personas.find((p) => p.id === activePersonaId);
                // The persona stamped on the messages wins (persona-at-send-time); the
                // active persona is only the legacy fallback for unstamped messages.
                const lastUserSpeaker = [...messages]
                    .reverse()
                    .find((m) => m.role === 'user' && m.speaker?.name)?.speaker?.name;
                const userName = lastUserSpeaker || activePersona?.name || 'You';

                // Adaptive chunk size based on message quality/density
                const recentMsgs = messages.slice(-15);
                const adaptiveChunkSize = getAdaptiveChunkSize(
                    recentMsgs.map((m) => ({ role: m.role, content: m.content })),
                    DEFAULT_CHUNK_SIZE
                );

                // How far the Chronicle is BEHIND the eviction boundary. Messages past it have
                // left the verbatim window without ever being summarized — with facts and
                // vector chunks gone, nothing else remembers them. Normally this is 0 (the
                // pipeline runs far ahead of eviction), but it is reachable: memory switched
                // off for a while, no API key when those messages arrived, repeated background
                // failures, or a long imported conversation. Catching up one Fragment per sent
                // message would take 200 messages to recover 200; do several per run instead.
                const conv = useChatStore
                    .getState()
                    .conversations.find((c) => c.id === activeConversationId);
                const evictedCount = conv?.historyCutMessageId
                    ? Math.max(
                          0,
                          messages.findIndex((m) => m.id === conv.historyCutMessageId)
                      )
                    : 0;
                const coveredCount = existingSummaries
                    .filter((s) => s.level === 0)
                    .reduce((max, s) => Math.max(max, s.messageRange[1]), 0);
                const isBehind = evictedCount > coveredCount;
                const l0Budget = isBehind ? CATCHUP_L0_PER_RUN : 1;
                if (isBehind) {
                    console.warn(
                        `[Chronicle] Behind by ${evictedCount - coveredCount} evicted messages — catching up (up to ${l0Budget} fragments this run)`
                    );
                }

                // L0 fragments (adaptive frequency). Re-read after each one: the next chunk
                // starts where the summary just written ends.
                for (let produced = 0; produced < l0Budget; produced++) {
                    const current =
                        produced === 0
                            ? existingSummaries
                            : await getSummariesByConversation(activeConversationId);
                    if (!shouldCreateL0Summary(messages.length, current, adaptiveChunkSize)) break;

                    const chunk = getNextChunkToSummarize(messages, current, adaptiveChunkSize);
                    if (!chunk) break;

                    const startIdx = current
                        .filter((s) => s.level === 0)
                        .reduce((max, s) => Math.max(max, s.messageRange[1]), 0);
                    const endIdx = startIdx + chunk.length;

                    console.log(
                        `[RAG] Creating L0 summary for messages ${startIdx}-${endIdx} (adaptive chunk=${adaptiveChunkSize})`
                    );
                    lastSummarizedCount.current = messages.length;

                    const result = await backgroundAICall({
                        systemPrompt: SUMMARIZATION_PROMPT_L0,
                        userPrompt: buildL0Prompt(chunk, character.name, userName),
                        temperature: 0.3,
                        backgroundModel,
                    });
                    if (!result) break; // model unavailable — stop rather than hammer it

                    const parsed = parseSummarizationResponse(result.content);
                    if (!parsed) continue;

                    const summary = await createSummary(
                        activeConversationId,
                        0,
                        parsed.summary,
                        parsed.keyFacts,
                        [startIdx, endIdx],
                        [],
                        messages.map((m) => m.id)
                    );
                    console.log('[RAG] L0 summary created:', summary.id);
                }

                // Check L1 (section summary from L0s)
                const updatedSummaries = await getSummariesByConversation(activeConversationId);
                if (shouldCreateL1Summary(updatedSummaries)) {
                    const l0s = getL0SummariesForL1(updatedSummaries);
                    if (l0s) {
                        console.log('[RAG] Creating L1 summary from', l0s.length, 'L0 summaries');
                        const prompt = buildL1Prompt(l0s);

                        const result = await backgroundAICall({
                            systemPrompt: SUMMARIZATION_PROMPT_L1,
                            userPrompt: prompt,
                            temperature: 0.3,
                            backgroundModel,
                        });

                        if (result) {
                            const parsed = parseSummarizationResponse(result.content);
                            if (parsed) {
                                const range: [number, number] = [
                                    Math.min(...l0s.map((s) => s.messageRange[0])),
                                    Math.max(...l0s.map((s) => s.messageRange[1])),
                                ];
                                await createSummary(
                                    activeConversationId,
                                    1,
                                    parsed.summary,
                                    parsed.keyFacts,
                                    range,
                                    l0s.map((s) => s.id),
                                    messages.map((m) => m.id)
                                );
                                console.log('[RAG] L1 summary created');
                            }
                        }
                    }
                } else {
                    console.log('[RAG] L1 not needed yet');
                }

                // Check L2 (arc summary from L1s)
                const finalSummaries = await getSummariesByConversation(activeConversationId);
                if (shouldCreateL2Summary(finalSummaries)) {
                    const l1s = getL1SummariesForL2(finalSummaries);
                    if (l1s) {
                        console.log(
                            '[RAG] Creating L2 arc summary from',
                            l1s.length,
                            'L1 summaries'
                        );
                        const prompt = buildL2Prompt(l1s);

                        const result = await backgroundAICall({
                            systemPrompt: SUMMARIZATION_PROMPT_L2,
                            userPrompt: prompt,
                            temperature: 0.3,
                            backgroundModel,
                        });

                        if (result) {
                            const parsed = parseSummarizationResponse(result.content);
                            if (parsed) {
                                const range: [number, number] = [
                                    Math.min(...l1s.map((s) => s.messageRange[0])),
                                    Math.max(...l1s.map((s) => s.messageRange[1])),
                                ];
                                await createSummary(
                                    activeConversationId,
                                    2,
                                    parsed.summary,
                                    parsed.keyFacts,
                                    range,
                                    l1s.map((s) => s.id),
                                    messages.map((m) => m.id)
                                );
                                console.log('[RAG] L2 arc summary created');
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('[RAG] Hierarchical summary error:', error);
            } finally {
                // ALWAYS record the evaluated length — the effect re-fires on every
                // stream chunk (messages identity changes), and without this the "no
                // summary due" path re-ran its IndexedDB reads dozens of times per reply.
                lastSummarizedCount.current = Math.max(
                    lastSummarizedCount.current,
                    messages.length
                );
                isSummarizingRef.current = false;
            }
        };

        runHierarchicalSummary();
    }, [messages, character, activeConversationId, currentApiKey]);

    return { runPostBeat: runPostBeatAnalyses };
}
