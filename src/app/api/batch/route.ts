import { NextRequest } from 'next/server';
import { buildOpenRouterChatBody, withSystemMessage } from '@/lib/ai/openrouter-request';
import {
    buildBatchEnvelope,
    jsonResponse,
    openRouterHeaders,
    upstreamFailure,
    OPENROUTER_BATCHES_URL,
} from '@/lib/ai/openrouter-batch';

export const runtime = 'edge';

/**
 * Submit ONE chat completion to the OpenRouter Batch API. Same body as /api/chat plus
 * `customId` (the target message id). Returns `{ batchId, status }` on acceptance (202),
 * and the same `{ error, upstreamStatus, retryAfter }` shape as /api/chat otherwise so the
 * client can tell "this model cannot batch" (4xx) from "try again" (429/5xx).
 */
export async function POST(req: NextRequest) {
    try {
        const params = await req.json();
        const { apiKey, model, messages, systemPrompt, userPersona, customId } = params;

        if (!apiKey) return jsonResponse({ error: 'API key is required' }, 401);
        if (!model || !Array.isArray(messages)) {
            return jsonResponse({ error: 'model and messages are required' }, 400);
        }

        const body = buildOpenRouterChatBody({
            ...params,
            messages: withSystemMessage(messages, systemPrompt, userPersona),
            mode: 'batch',
        });
        const envelope = buildBatchEnvelope(
            model,
            typeof customId === 'string' && customId ? customId : crypto.randomUUID(),
            body
        );

        const upstream = await fetch(OPENROUTER_BATCHES_URL, {
            method: 'POST',
            headers: openRouterHeaders(
                apiKey,
                req.headers.get('origin') || 'http://localhost:3000'
            ),
            body: JSON.stringify(envelope),
        });
        const payload = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

        if (!upstream.ok) {
            return jsonResponse(
                upstreamFailure(upstream, payload, 'OpenRouter batch error'),
                upstream.status
            );
        }
        if (typeof payload.id !== 'string') {
            return jsonResponse(
                { error: 'OpenRouter a accepté le batch sans renvoyer son id.' },
                502
            );
        }
        return jsonResponse({ batchId: payload.id, status: payload.status ?? 'validating' }, 202);
    } catch (error) {
        console.error('Batch submit error:', error);
        return jsonResponse(
            { error: error instanceof Error ? error.message : 'Internal server error' },
            500
        );
    }
}
