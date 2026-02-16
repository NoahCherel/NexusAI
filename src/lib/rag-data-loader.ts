import { getFactsByConversation, getSummariesByConversation } from './db';
import type { WorldFact, MemorySummary } from '@/types/rag';

export interface RAGDataLoadResult {
    facts: WorldFact[];
    summaries: MemorySummary[];
    errors: {
        facts?: unknown;
        summaries?: unknown;
    };
}

export async function loadRagDataByConversation(
    conversationId: string
): Promise<RAGDataLoadResult> {
    const [factsResult, summariesResult] = await Promise.allSettled([
        getFactsByConversation(conversationId),
        getSummariesByConversation(conversationId),
    ]);

    return {
        facts: factsResult.status === 'fulfilled' ? factsResult.value : [],
        summaries: summariesResult.status === 'fulfilled' ? summariesResult.value : [],
        errors: {
            facts: factsResult.status === 'rejected' ? factsResult.reason : undefined,
            summaries: summariesResult.status === 'rejected' ? summariesResult.reason : undefined,
        },
    };
}
