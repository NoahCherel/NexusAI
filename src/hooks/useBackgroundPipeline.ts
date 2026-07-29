'use client';

/**
 * Background memory pipeline for the chat page:
 * - owns the hierarchical auto-summary effect (L0 chunk → L1 section → L2 arc), and
 * - exposes `runPostBeat` (arc capture, momentum, relations, fact extraction) so the
 *   generation flow has a single post-response entry point.
 *
 * Everything here runs on the unified background layer (backgroundAICall resolves its own
 * keys — NanoGPT quota or free OpenRouter rotation).
 */

import { useEffect, useRef } from 'react';
import type { CharacterCard } from '@/types/character';
import type { Message } from '@/types/chat';
import { useSettingsStore } from '@/stores/settings-store';
import { backgroundAICall } from '@/lib/ai/background-ai';
import { embedText } from '@/lib/ai/embedding-service';
import { indexMessageChunk } from '@/lib/ai/rag-service';
import { getAdaptiveChunkSize } from '@/lib/ai/message-quality';
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
    /** Current location, recorded as metadata on indexed chunks. */
    worldStateLocation: string;
}

export function useBackgroundPipeline({
    character,
    activeConversationId,
    messages,
    currentApiKey,
    worldStateLocation,
}: UseBackgroundPipelineParams): { runPostBeat: (params: PostBeatParams) => void } {
    const lastSummarizedCount = useRef(0); // Track last summarized message count
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
                const userName = activePersona?.name || 'You';

                // Adaptive chunk size based on message quality/density
                const recentMsgs = messages.slice(-15);
                const adaptiveChunkSize = getAdaptiveChunkSize(
                    recentMsgs.map((m) => ({ role: m.role, content: m.content })),
                    DEFAULT_CHUNK_SIZE
                );

                // Check L0 (chunk summary with adaptive frequency)
                if (shouldCreateL0Summary(messages.length, existingSummaries, adaptiveChunkSize)) {
                    const chunk = getNextChunkToSummarize(
                        messages,
                        existingSummaries,
                        adaptiveChunkSize
                    );
                    if (chunk) {
                        const l0Summaries = existingSummaries.filter((s) => s.level === 0);
                        // Use actual coverage from existing summaries
                        const startIdx =
                            l0Summaries.length > 0
                                ? Math.max(...l0Summaries.map((s) => s.messageRange[1]))
                                : 0;
                        const endIdx = startIdx + chunk.length;

                        console.log(
                            `[RAG] Creating L0 summary for messages ${startIdx}-${endIdx} (adaptive chunk=${adaptiveChunkSize})`
                        );
                        lastSummarizedCount.current = messages.length;

                        const prompt = buildL0Prompt(chunk, character.name, userName);

                        const result = await backgroundAICall({
                            systemPrompt: SUMMARIZATION_PROMPT_L0,
                            userPrompt: prompt,
                            temperature: 0.3,
                            backgroundModel,
                        });

                        if (result) {
                            const parsed = parseSummarizationResponse(result.content);

                            if (parsed) {
                                const embedding = await embedText(parsed.summary);
                                const summary = await createSummary(
                                    activeConversationId,
                                    0,
                                    parsed.summary,
                                    parsed.keyFacts,
                                    [startIdx, endIdx],
                                    [],
                                    embedding
                                );

                                // Also index as a vector chunk for retrieval (with branch path)
                                const branchPath = messages.map((m) => m.id);
                                await indexMessageChunk(
                                    chunk,
                                    activeConversationId,
                                    parsed.summary,
                                    {
                                        characters: [character.name],
                                        location: worldStateLocation,
                                        importance: 5,
                                    },
                                    branchPath
                                );

                                // NOTE: keyFacts deliberately do NOT become WorldFacts —
                                // fact-extractor (post-beat) is the single producer. The
                                // keyFacts stay inside the summary (searchable via its
                                // embedding); a second producer here created duplicates.

                                console.log('[RAG] L0 summary created:', summary.id);
                            }
                        }
                    }
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
                                const embedding = await embedText(parsed.summary);
                                await createSummary(
                                    activeConversationId,
                                    1,
                                    parsed.summary,
                                    parsed.keyFacts,
                                    range,
                                    l0s.map((s) => s.id),
                                    embedding
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
                                const embedding = await embedText(parsed.summary);
                                await createSummary(
                                    activeConversationId,
                                    2,
                                    parsed.summary,
                                    parsed.keyFacts,
                                    range,
                                    l1s.map((s) => s.id),
                                    embedding
                                );
                                console.log('[RAG] L2 arc summary created');
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('[RAG] Hierarchical summary error:', error);
            } finally {
                isSummarizingRef.current = false;
            }
        };

        runHierarchicalSummary();
    }, [messages, character, activeConversationId, currentApiKey, worldStateLocation]);

    return { runPostBeat: runPostBeatAnalyses };
}
