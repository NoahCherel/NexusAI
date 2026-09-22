/**
 * Full Chronicle rebuild — the "Réindexer la conversation" action.
 *
 * The rebuild used to delete the whole Chronicle first and write the new summaries one by one
 * as the provider answered. Anything that went wrong after that first delete — a conversation
 * too short to produce a single fragment, a provider outage, a closed tab — left the user with
 * a Chronicle that was empty or half-written, and no way back.
 *
 * So the work is split in three, and only the last one touches the database:
 *   1. `planChronicleRebuild` decides whether a rebuild can produce anything at all;
 *   2. `buildChronicleReplacement` builds the entire replacement in memory (network only);
 *   3. `replaceSummariesForConversation` (in `@/lib/db`) swaps it in inside one transaction.
 */

import type { Message } from '@/types';
import type { MemorySummary, SummaryLevel } from '@/types/rag';
import {
    DEFAULT_CHUNK_SIZE,
    SUMMARIZATION_PROMPT_L0,
    SUMMARIZATION_PROMPT_L1,
    SUMMARIZATION_PROMPT_L2,
    buildL0Prompt,
    buildL1Prompt,
    buildL2Prompt,
    getL0SummariesForL1,
    getL1SummariesForL2,
    parseSummarizationResponse,
} from './hierarchical-summarizer';
import { getAdaptiveChunkSize } from './message-quality';

export type ChronicleRebuildPlan =
    | { canRun: true; chunkSize: number; totalChunks: number }
    | { canRun: false; reason: string };

/**
 * Can a rebuild produce anything? Answered BEFORE any mutation, because the answer "no" used to
 * arrive after the old Chronicle had already been deleted.
 */
export function planChronicleRebuild(
    messages: Pick<Message, 'role' | 'content'>[]
): ChronicleRebuildPlan {
    if (messages.length === 0) {
        return { canRun: false, reason: 'Aucun message à indexer.' };
    }

    // Same adaptive sizing as the live pipeline — a fixed 10 here produced a Chronicle that did
    // not line up with the one the background pipeline would have written.
    const chunkSize = getAdaptiveChunkSize(
        messages.slice(-15).map((m) => ({ role: m.role, content: m.content })),
        DEFAULT_CHUNK_SIZE
    );
    const totalChunks = Math.floor(messages.length / chunkSize);

    if (totalChunks <= 0) {
        return {
            canRun: false,
            reason: `Pas assez de messages pour un fragment de résumé (${chunkSize} requis, ${messages.length} disponibles).`,
        };
    }

    return { canRun: true, chunkSize, totalChunks };
}

/** One summarization round-trip. Injected so the rebuild can be tested without a provider. */
export type SummarizerCall = (args: {
    systemPrompt: string;
    userPrompt: string;
}) => Promise<string | null>;

export interface ChronicleBuildOptions {
    conversationId: string;
    /** The active-branch messages, in order. */
    messages: Message[];
    characterName: string;
    userName: string;
    plan: { chunkSize: number; totalChunks: number };
    call: SummarizerCall;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
}

export interface ChronicleBuildResult {
    /** The complete replacement Chronicle: fragments, then sections, then arcs. */
    summaries: MemorySummary[];
    /** Chunks whose provider call or parse failed. They are simply absent from the rebuild. */
    failedChunks: number;
}

function newSummary(
    conversationId: string,
    level: SummaryLevel,
    content: string,
    keyFacts: string[],
    messageRange: [number, number],
    childIds: string[],
    branchPath: string[]
): MemorySummary {
    return {
        id: crypto.randomUUID(),
        conversationId,
        level,
        messageRange,
        content,
        keyFacts,
        childIds,
        createdAt: Date.now(),
        branchPath,
    };
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Réindexation annulée.', 'AbortError');
}

/**
 * Build the replacement Chronicle in memory. Writes nothing: on any throw the stored Chronicle
 * is still the one the user had before pressing the button.
 */
export async function buildChronicleReplacement(
    options: ChronicleBuildOptions
): Promise<ChronicleBuildResult> {
    const { conversationId, messages, characterName, userName, plan, call, onProgress, signal } =
        options;
    const branchPath = messages.map((m) => m.id);
    const built: MemorySummary[] = [];
    let failedChunks = 0;

    // ---- L0: fragments ----
    for (let i = 0; i < plan.totalChunks; i++) {
        assertNotAborted(signal);
        const startIdx = i * plan.chunkSize;
        const chunk = messages.slice(startIdx, startIdx + plan.chunkSize);
        if (chunk.length < plan.chunkSize) break;

        onProgress?.(`Résumé du fragment ${i + 1}/${plan.totalChunks}…`);

        const raw = await call({
            systemPrompt: SUMMARIZATION_PROMPT_L0,
            userPrompt: buildL0Prompt(chunk, characterName, userName),
        });
        const parsed = raw ? parseSummarizationResponse(raw) : null;
        if (!parsed) {
            failedChunks++;
            console.warn(`[ChronicleRebuild] Chunk ${i + 1}: no usable summary`);
            continue;
        }

        built.push(
            newSummary(
                conversationId,
                0,
                parsed.summary,
                parsed.keyFacts,
                [startIdx, startIdx + chunk.length],
                [],
                branchPath
            )
        );
    }

    // ---- L1 / L2: roll-ups, read from the in-memory list rather than from the database ----
    for (const level of [1, 2] as const) {
        const pick = level === 1 ? getL0SummariesForL1 : getL1SummariesForL2;
        const systemPrompt = level === 1 ? SUMMARIZATION_PROMPT_L1 : SUMMARIZATION_PROMPT_L2;
        const buildPrompt = level === 1 ? buildL1Prompt : buildL2Prompt;

        onProgress?.(level === 1 ? 'Création des sections…' : 'Création des arcs…');

        for (;;) {
            assertNotAborted(signal);
            const children = pick(built);
            if (!children) break;

            const raw = await call({
                systemPrompt,
                userPrompt: buildPrompt(children),
            });
            const parsed = raw ? parseSummarizationResponse(raw) : null;
            // A failed roll-up must stop this level: retrying would pick the same children
            // forever, and there is no partial state to salvage.
            if (!parsed) break;

            built.push(
                newSummary(
                    conversationId,
                    level,
                    parsed.summary,
                    parsed.keyFacts,
                    [
                        Math.min(...children.map((s) => s.messageRange[0])),
                        Math.max(...children.map((s) => s.messageRange[1])),
                    ],
                    children.map((s) => s.id),
                    branchPath
                )
            );
        }
    }

    return { summaries: built, failedChunks };
}
