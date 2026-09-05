/**
 * The Batch API envelope and the status normalizer. The order of the envelope keys is a
 * protocol requirement (OpenRouter stream-parses `requests` and rejects it when it comes
 * first), so it is asserted, not assumed.
 */
import { describe, expect, it } from 'vitest';
import {
    buildBatchEnvelope,
    describeError,
    normalizeBatchStatus,
    upstreamFailure,
} from '@/lib/ai/openrouter-batch';

describe('route helpers', () => {
    it('reads a message out of every error shape OpenRouter uses', () => {
        expect(describeError('plain', 'fb')).toBe('plain');
        expect(describeError({ message: 'top' }, 'fb')).toBe('top');
        expect(describeError({ error: 'nested string' }, 'fb')).toBe('nested string');
        expect(describeError({ error: { code: 400, message: 'nested object' } }, 'fb')).toBe(
            'nested object'
        );
        expect(describeError({ error: null }, 'fb')).toBe('fb');
        expect(describeError(undefined, 'fb')).toBe('fb');
    });

    it('builds the /api/chat-compatible failure body with retry-after', () => {
        const upstream = {
            status: 429,
            headers: new Headers({ 'retry-after': '7' }),
        } as unknown as Response;
        expect(upstreamFailure(upstream, { error: { message: 'slow down' } }, 'Batch')).toEqual({
            error: 'slow down',
            upstreamStatus: 429,
            retryAfter: 7,
        });
        const silent = { status: 502, headers: new Headers() } as unknown as Response;
        expect(upstreamFailure(silent, {}, 'Batch')).toEqual({
            error: 'Batch (502)',
            upstreamStatus: 502,
            retryAfter: undefined,
        });
    });
});

describe('buildBatchEnvelope', () => {
    it('serializes endpoint and model BEFORE requests, and drops the per-request model', () => {
        const envelope = buildBatchEnvelope('openai/gpt-4o', 'msg-1', {
            model: 'openai/gpt-4o',
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0.5,
        });
        expect(Object.keys(envelope)).toEqual(['endpoint', 'model', 'requests']);
        expect(JSON.stringify(envelope).indexOf('"endpoint"')).toBeLessThan(
            JSON.stringify(envelope).indexOf('"requests"')
        );
        expect(envelope.endpoint).toBe('/v1/chat/completions');
        expect(envelope.requests).toEqual([
            {
                custom_id: 'msg-1',
                body: { messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 },
            },
        ]);
    });
});

describe('normalizeBatchStatus', () => {
    const completed = {
        id: 'batch_1',
        object: 'batch',
        status: 'completed',
        request_counts: { total: 1, completed: 1, failed: 0 },
        usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540, cost: 0.0021 },
        results: [
            {
                id: 'req_1',
                custom_id: 'msg-1',
                response: {
                    status_code: 200,
                    request_id: 'gen-1',
                    body: {
                        id: 'gen-1',
                        choices: [
                            {
                                message: {
                                    role: 'assistant',
                                    content: 'She lowers the blade.',
                                    reasoning_details: [
                                        { type: 'reasoning.text', text: 'Think A. ' },
                                        { type: 'reasoning.summary', summary: 'ignored' },
                                        { type: 'reasoning.text', text: 'Think B.' },
                                    ],
                                },
                            },
                        ],
                        usage: {
                            prompt_tokens: 1200,
                            completion_tokens: 340,
                            prompt_tokens_details: { cached_tokens: 900 },
                        },
                    },
                },
                error: null,
            },
        ],
        error: null,
    };

    it('extracts content, reasoning text parts, and batch-level usage from a completed batch', () => {
        const payload = normalizeBatchStatus(completed);
        expect(payload).toEqual({
            status: 'completed',
            content: 'She lowers the blade.',
            reasoning: 'Think A. Think B.',
            usage: { promptTokens: 1200, completionTokens: 340, cachedTokens: 900, cost: 0.0021 },
            requestCounts: { total: 1, completed: 1, failed: 0 },
        });
    });

    it('prefers the plain `reasoning` field when present', () => {
        const raw = structuredClone(completed);
        raw.results[0].response.body.choices[0].message = {
            role: 'assistant',
            content: 'ok',
            reasoning: 'plain reasoning',
        } as never;
        const payload = normalizeBatchStatus(raw);
        expect(payload.status).toBe('completed');
        if (payload.status === 'completed') expect(payload.reasoning).toBe('plain reasoning');
    });

    it('passes pending states through with their counts', () => {
        expect(
            normalizeBatchStatus({
                status: 'in_progress',
                request_counts: { total: 1, completed: 0, failed: 0 },
            })
        ).toEqual({ status: 'in_progress', requestCounts: { total: 1, completed: 0, failed: 0 } });
        expect(normalizeBatchStatus({ status: 'validating' }).status).toBe('validating');
    });

    it('turns a completed batch whose only request errored into a failure with the reason', () => {
        const raw = structuredClone(completed);
        raw.results[0] = {
            ...raw.results[0],
            response: null as never,
            error: { code: 400, message: 'Model does not support batching' } as never,
        };
        raw.request_counts = { total: 1, completed: 0, failed: 1 };
        expect(normalizeBatchStatus(raw)).toEqual({
            status: 'failed',
            error: 'Model does not support batching',
        });
    });

    it('reports failed / expired / cancelled with a readable message', () => {
        expect(
            normalizeBatchStatus({ status: 'failed', error: { message: 'validation failed' } })
        ).toEqual({ status: 'failed', error: 'validation failed' });
        const expired = normalizeBatchStatus({ status: 'expired', error: null });
        expect(expired.status).toBe('expired');
        if (expired.status === 'expired') expect(expired.error).toMatch(/expiré/);
        expect(normalizeBatchStatus({ status: 'cancelled' }).status).toBe('cancelled');
    });

    it('fails safely on garbage', () => {
        expect(normalizeBatchStatus(null).status).toBe('failed');
        expect(normalizeBatchStatus({ status: 'completed', results: [] }).status).toBe('failed');
    });
});
