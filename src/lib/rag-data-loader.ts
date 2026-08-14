import { getSummariesByConversation } from './db';
import type { MemorySummary } from '@/types/rag';

export interface RAGDataLoadResult {
    summaries: MemorySummary[];
    errors: {
        summaries?: unknown;
    };
}

/**
 * Load a conversation's Chronicle. Kept as a `allSettled` wrapper (rather than a bare await)
 * so a corrupt store degrades the memory panel to empty instead of throwing at render.
 */
export async function loadRagDataByConversation(
    conversationId: string
): Promise<RAGDataLoadResult> {
    const [summariesResult] = await Promise.allSettled([
        getSummariesByConversation(conversationId),
    ]);

    return {
        summaries: summariesResult.status === 'fulfilled' ? summariesResult.value : [],
        errors: {
            summaries: summariesResult.status === 'rejected' ? summariesResult.reason : undefined,
        },
    };
}
