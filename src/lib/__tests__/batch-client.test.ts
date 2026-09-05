/**
 * The client half of Batch mode: what leaves the browser on submit, how the wait paces its
 * polls, and which terminal states fall back to a live reply versus surface an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BatchFailedError,
    BatchUnsupportedError,
    formatElapsed,
    pollDelayMs,
    submitBatchReply,
    waitForBatchReply,
} from '@/lib/ai/batch-client';

interface Call {
    url: string;
    body: Record<string, unknown>;
}

let calls: Call[] = [];

function jsonResponse(payload: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    } as unknown as Response;
}

/** Queue of responses for /api/batch/status, consumed in order (last one repeats). */
function mockStatuses(statuses: unknown[]) {
    let i = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, body: JSON.parse(String(init.body)) });
            const next = statuses[Math.min(i, statuses.length - 1)];
            i++;
            return typeof next === 'function' ? (next as () => Response)() : jsonResponse(next);
        })
    );
}

beforeEach(() => {
    calls = [];
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('submitBatchReply', () => {
    it('posts the request body plus customId to /api/batch and returns the batch id', async () => {
        mockStatuses([{ batchId: 'batch_42', status: 'validating' }]);
        const result = await submitBatchReply({
            messages: [{ role: 'user', content: 'hi' }],
            model: 'openai/gpt-4o-mini',
            apiKey: 'k',
            customId: 'msg-1',
        });
        expect(result).toEqual({ batchId: 'batch_42' });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('/api/batch');
        expect(calls[0].body).toMatchObject({ customId: 'msg-1', model: 'openai/gpt-4o-mini' });
    });

    it('turns a 4xx rejection into BatchUnsupportedError so the caller can go live', async () => {
        mockStatuses([
            () => jsonResponse({ error: 'model not batchable', upstreamStatus: 400 }, 400),
        ]);
        await expect(
            submitBatchReply({ messages: [], model: 'm', apiKey: 'k', customId: 'c' })
        ).rejects.toBeInstanceOf(BatchUnsupportedError);
    });

    it('retries a 429 once before succeeding', async () => {
        mockStatuses([
            () => jsonResponse({ error: 'slow down', upstreamStatus: 429, retryAfter: 1 }, 429),
            { batchId: 'b', status: 'validating' },
        ]);
        const pending = submitBatchReply({ messages: [], model: 'm', apiKey: 'k', customId: 'c' });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toEqual({ batchId: 'b' });
        expect(calls).toHaveLength(2);
    });

    it('does not retry an authentication failure', async () => {
        mockStatuses([() => jsonResponse({ error: 'bad key', upstreamStatus: 401 }, 401)]);
        await expect(
            submitBatchReply({ messages: [], model: 'm', apiKey: 'k', customId: 'c' })
        ).rejects.toThrow('bad key');
        expect(calls).toHaveLength(1);
    });
});

describe('poll cadence', () => {
    it('starts at 3 s, then 5 s in the first minute, 10 s until five minutes, then 20 s', () => {
        expect(pollDelayMs(0, 0)).toBe(3_000);
        expect(pollDelayMs(1, 3_000)).toBe(5_000);
        expect(pollDelayMs(5, 59_000)).toBe(5_000);
        expect(pollDelayMs(6, 61_000)).toBe(10_000);
        expect(pollDelayMs(20, 5 * 60_000 + 1)).toBe(20_000);
    });
});

describe('waitForBatchReply', () => {
    const done = {
        status: 'completed',
        content: 'The gate opens.',
        reasoning: 'thinking',
        usage: { promptTokens: 10, completionTokens: 5, cost: 0.001 },
        requestCounts: { total: 1, completed: 1, failed: 0 },
    };

    it('polls /api/batch/status with the key in the body, reports steps, and resolves on completed', async () => {
        mockStatuses([
            { status: 'validating', requestCounts: { total: 1, completed: 0, failed: 0 } },
            { status: 'in_progress', requestCounts: { total: 1, completed: 0, failed: 0 } },
            { status: 'finalizing', requestCounts: { total: 1, completed: 1, failed: 0 } },
            done,
        ]);
        const steps: string[] = [];
        const pending = waitForBatchReply({
            apiKey: 'k',
            batchId: 'batch_42',
            onStep: (step) => steps.push(step),
        });
        await vi.advanceTimersByTimeAsync(3_000); // validating
        await vi.advanceTimersByTimeAsync(5_000); // in_progress
        await vi.advanceTimersByTimeAsync(5_000); // finalizing
        await vi.advanceTimersByTimeAsync(5_000); // completed
        await expect(pending).resolves.toEqual({
            content: 'The gate opens.',
            reasoning: 'thinking',
            usage: { promptTokens: 10, completionTokens: 5, cost: 0.001 },
        });
        expect(calls.every((c) => c.url === '/api/batch/status')).toBe(true);
        expect(calls[0].body).toEqual({ apiKey: 'k', batchId: 'batch_42' });
        expect(steps).toEqual(['validating', 'in_progress', 'finalizing']);
    });

    it('waits 3 s before the first poll', async () => {
        mockStatuses([done]);
        const pending = waitForBatchReply({ apiKey: 'k', batchId: 'b' });
        await vi.advanceTimersByTimeAsync(2_999);
        expect(calls).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(calls).toHaveLength(1);
    });

    it('maps a failed batch to BatchUnsupportedError (nothing billed → replay live)', async () => {
        mockStatuses([{ status: 'failed', error: 'validation failed' }]);
        const pending = waitForBatchReply({ apiKey: 'k', batchId: 'b' });
        const outcome = pending.catch((e) => e);
        await vi.advanceTimersByTimeAsync(3_000);
        const error = await outcome;
        expect(error).toBeInstanceOf(BatchUnsupportedError);
        expect(error.message).toBe('validation failed');
    });

    it('maps expired / cancelled to BatchFailedError', async () => {
        mockStatuses([{ status: 'expired', error: 'expired before completion' }]);
        const pending = waitForBatchReply({ apiKey: 'k', batchId: 'b' });
        const outcome = pending.catch((e) => e);
        await vi.advanceTimersByTimeAsync(3_000);
        const error = await outcome;
        expect(error).toBeInstanceOf(BatchFailedError);
        expect(error.terminal).toBe('expired');
    });

    it('survives transient poll failures and keeps going', async () => {
        mockStatuses([
            () => jsonResponse({ error: 'upstream hiccup', upstreamStatus: 502 }, 502),
            done,
        ]);
        const pending = waitForBatchReply({ apiKey: 'k', batchId: 'b' });
        await vi.advanceTimersByTimeAsync(3_000);
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(pending).resolves.toMatchObject({ content: 'The gate opens.' });
        expect(calls).toHaveLength(2);
    });

    it('stops polling and rejects with AbortError when the signal fires', async () => {
        mockStatuses([
            { status: 'in_progress', requestCounts: { total: 1, completed: 0, failed: 0 } },
        ]);
        const controller = new AbortController();
        const pending = waitForBatchReply({ apiKey: 'k', batchId: 'b', signal: controller.signal });
        const outcome = pending.catch((e) => e);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(calls).toHaveLength(1);
        controller.abort();
        const error = await outcome;
        expect(error.name).toBe('AbortError');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls).toHaveLength(1);
    });
});

describe('formatElapsed', () => {
    it('renders mm:ss', () => {
        expect(formatElapsed(0)).toBe('0:00');
        expect(formatElapsed(59_999)).toBe('0:59');
        expect(formatElapsed(134_000)).toBe('2:14');
    });
});
