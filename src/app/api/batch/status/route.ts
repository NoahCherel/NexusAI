import { NextRequest } from 'next/server';
import {
    jsonResponse,
    normalizeBatchStatus,
    openRouterHeaders,
    upstreamFailure,
    OPENROUTER_BATCHES_URL,
} from '@/lib/ai/openrouter-batch';

export const runtime = 'edge';

/**
 * Poll one OpenRouter batch. POST (not GET) so the API key travels in the body like every
 * other route, never in a URL. Returns the normalized `BatchStatusPayload`.
 */
export async function POST(req: NextRequest) {
    try {
        const { apiKey, batchId } = await req.json();
        if (!apiKey) return jsonResponse({ error: 'API key is required' }, 401);
        if (typeof batchId !== 'string' || !batchId) {
            return jsonResponse({ error: 'batchId is required' }, 400);
        }

        const upstream = await fetch(`${OPENROUTER_BATCHES_URL}/${encodeURIComponent(batchId)}`, {
            headers: openRouterHeaders(
                apiKey,
                req.headers.get('origin') || 'http://localhost:3000'
            ),
        });
        const payload = await upstream.json().catch(() => ({}));

        if (!upstream.ok) {
            return jsonResponse(
                upstreamFailure(upstream, payload, 'OpenRouter batch status error'),
                upstream.status
            );
        }
        return jsonResponse(normalizeBatchStatus(payload), 200);
    } catch (error) {
        console.error('Batch status error:', error);
        return jsonResponse(
            { error: error instanceof Error ? error.message : 'Internal server error' },
            500
        );
    }
}
