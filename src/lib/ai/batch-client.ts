/**
 * Client side of the OpenRouter Batch mode: submit one visible reply (or impersonation
 * draft) through `/api/batch`, then poll `/api/batch/status` until the batch settles.
 *
 * Only the foreground uses this. Background agents need their answer within the beat and
 * keep the live route.
 */

import { abortableDelay } from '@/lib/ai/abortable-delay';
import {
    BATCH_PENDING_STEP,
    type BatchStatusPayload,
    type BatchUsage,
    type BatchWaitStep,
} from '@/lib/ai/openrouter-batch';

export { BATCH_STEP_LABELS, type BatchWaitStep } from '@/lib/ai/openrouter-batch';

/**
 * The batch produced nothing and nothing was billed: the model rejected batching at submit
 * (4xx) or the batch failed at validation. The caller runs the same reply live instead.
 */
export class BatchUnsupportedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BatchUnsupportedError';
    }
}

/** The batch reached a terminal state without a usable answer (expired, cancelled). */
export class BatchFailedError extends Error {
    constructor(
        message: string,
        readonly terminal: 'expired' | 'cancelled'
    ) {
        super(message);
        this.name = 'BatchFailedError';
    }
}

export interface BatchReplyResult {
    content: string;
    reasoning?: string;
    usage: BatchUsage;
}

const UNSUPPORTED_STATUSES = [400, 404, 422];
const TRANSIENT_STATUSES = [408, 429, 500, 502, 503, 504];
const SUBMIT_RETRIES = 2;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/** 3 s, then 5 s for the first minute, then 10 s, capped at 20 s. */
export function pollDelayMs(attempt: number, elapsedMs: number): number {
    if (attempt === 0) return 3_000;
    if (elapsedMs < 60_000) return 5_000;
    if (elapsedMs < 5 * 60_000) return 10_000;
    return 20_000;
}

function backoffMs(attempt: number, retryAfter: unknown): number {
    const ra = Number(retryAfter);
    return Number.isFinite(ra) && ra > 0
        ? ra * 1000
        : 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

interface RouteReply {
    ok: boolean;
    /** The route's status, or the upstream one when the route forwarded it. */
    status: number;
    message: string;
    payload: Record<string, unknown>;
}

/** POST JSON to one of our routes and read its answer in the shape every route shares. */
async function postJson(
    url: string,
    body: unknown,
    fallback: string,
    signal?: AbortSignal
): Promise<RouteReply> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
        ok: response.ok,
        status:
            typeof payload.upstreamStatus === 'number' ? payload.upstreamStatus : response.status,
        message:
            typeof payload.error === 'string' && payload.error
                ? payload.error
                : `${fallback} (${response.status}).`,
        payload,
    };
}

/**
 * Submit the request body (the very object the streaming path sends to /api/chat, plus
 * `customId`). Resolves with the OpenRouter batch id.
 */
export async function submitBatchReply(
    body: Record<string, unknown> & { customId: string },
    signal?: AbortSignal
): Promise<{ batchId: string }> {
    for (let attempt = 0; ; attempt++) {
        const reply = await postJson('/api/batch', body, 'Échec de l’envoi du batch', signal);

        if (reply.ok) {
            const batchId = reply.payload.batchId;
            if (typeof batchId !== 'string' || !batchId) {
                throw new Error('Le batch OpenRouter a été accepté sans identifiant.');
            }
            return { batchId };
        }
        if (UNSUPPORTED_STATUSES.includes(reply.status)) {
            throw new BatchUnsupportedError(reply.message);
        }
        if (TRANSIENT_STATUSES.includes(reply.status) && attempt < SUBMIT_RETRIES) {
            await abortableDelay(backoffMs(attempt, reply.payload.retryAfter), signal);
            continue;
        }
        throw new Error(reply.message);
    }
}

/**
 * Poll until the batch settles. `onStep` fires on every observed step change (and once
 * right away) with the elapsed time since `submittedAt`.
 */
export async function waitForBatchReply(options: {
    apiKey: string;
    batchId: string;
    signal?: AbortSignal;
    submittedAt?: number;
    onStep?: (step: BatchWaitStep, elapsedMs: number) => void;
}): Promise<BatchReplyResult> {
    const { apiKey, batchId, signal, onStep } = options;
    const startedAt = options.submittedAt ?? Date.now();

    let lastStep: BatchWaitStep | null = null;
    const report = (step: BatchWaitStep) => {
        if (step === lastStep) return;
        lastStep = step;
        onStep?.(step, Date.now() - startedAt);
    };
    report('validating');

    // Network blips and upstream 5xx are retried on the normal cadence; only a streak of
    // them gives up, with the last reason.
    let failures = 0;
    const transient = (reason: string) => {
        if (++failures > MAX_CONSECUTIVE_POLL_FAILURES) {
            throw new Error(`Impossible de suivre le batch OpenRouter : ${reason}`);
        }
    };

    for (let attempt = 0; ; attempt++) {
        await abortableDelay(pollDelayMs(attempt, Date.now() - startedAt), signal);

        let reply: RouteReply;
        try {
            reply = await postJson(
                '/api/batch/status',
                { apiKey, batchId },
                'Suivi du batch en erreur',
                signal
            );
        } catch (error) {
            if (isAbort(error)) throw error;
            transient(error instanceof Error ? error.message : String(error));
            continue;
        }

        if (!reply.ok) {
            if (reply.status === 401 || reply.status === 403) throw new Error(reply.message);
            if (reply.status === 404) {
                throw new BatchFailedError(
                    'Le batch OpenRouter n’existe plus (identifiant inconnu).',
                    'cancelled'
                );
            }
            transient(reply.message);
            continue;
        }
        failures = 0;

        const payload = reply.payload as unknown as BatchStatusPayload;
        if (payload.status in BATCH_PENDING_STEP) {
            report(BATCH_PENDING_STEP[payload.status as keyof typeof BATCH_PENDING_STEP]);
            continue;
        }
        switch (payload.status) {
            case 'completed':
                return {
                    content: payload.content,
                    reasoning: payload.reasoning,
                    usage: payload.usage,
                };
            case 'failed':
                // Nothing produced, nothing billed: the caller replays the reply live.
                throw new BatchUnsupportedError(payload.error);
            case 'expired':
            case 'cancelled':
                throw new BatchFailedError(payload.error, payload.status);
            default:
                throw new Error('Statut de batch OpenRouter inconnu.');
        }
    }
}

/** mm:ss for the waiting line. */
export function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
