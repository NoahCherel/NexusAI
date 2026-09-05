/**
 * OpenRouter Batch API (`/api/beta/batches`) — pure helpers shared by the edge routes and
 * the tests. The envelope builder fixes the key order the API requires; the normalizer
 * turns a raw batch object into the small status payload the client polls for.
 *
 * Lifecycle: validating → in_progress → finalizing → completed. Terminal states are
 * completed | failed | expired | cancelled. Results come back inline on the batch object;
 * there is no separate results endpoint and no documented cancel.
 */

export const OPENROUTER_BATCHES_URL = 'https://openrouter.ai/api/beta/batches';

/**
 * OpenRouter lists batch pricing as a model variant (`google/gemini-3.8-flash:batch`).
 * Picking such a model IS the choice of the Batch API; there is no separate toggle.
 */
export function isBatchModel(model: string | undefined | null): boolean {
    return typeof model === 'string' && /:batch$/i.test(model.trim());
}

/** The live-endpoint slug behind a `:batch` variant (`google/gemini-3.8-flash`). */
export function stripBatchSuffix(model: string): string {
    return model.trim().replace(/:batch$/i, '');
}

export type BatchPendingStatus = 'validating' | 'in_progress' | 'finalizing' | 'cancelling';
export type BatchTerminalStatus = 'completed' | 'failed' | 'expired' | 'cancelled';

export interface BatchRequestCounts {
    total: number;
    completed: number;
    failed: number;
}

export interface BatchUsage {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
    cost?: number;
}

export type BatchStatusPayload =
    | { status: BatchPendingStatus; requestCounts: BatchRequestCounts }
    | {
          status: 'completed';
          content: string;
          reasoning?: string;
          usage: BatchUsage;
          requestCounts: BatchRequestCounts;
      }
    | { status: 'failed' | 'expired' | 'cancelled'; error: string };

/** What the waiting line shows while a batch is pending. */
export type BatchWaitStep = 'validating' | 'in_progress' | 'finalizing';

/** Pending statuses collapse onto three visible steps (`cancelling` reads as validation). */
export const BATCH_PENDING_STEP: Record<BatchPendingStatus, BatchWaitStep> = {
    validating: 'validating',
    cancelling: 'validating',
    in_progress: 'in_progress',
    finalizing: 'finalizing',
};

export const BATCH_STEP_LABELS: Record<BatchWaitStep, string> = {
    validating: 'validation',
    in_progress: 'en cours',
    finalizing: 'finalisation',
};

// ---------------------------------------------------------------------------------------
// Route helpers (edge-safe). Both /api/batch routes speak to OpenRouter the same way and
// hand the client the same error shape as /api/chat: { error, upstreamStatus, retryAfter }.
// ---------------------------------------------------------------------------------------

export function openRouterHeaders(apiKey: string, origin: string): Record<string, string> {
    return {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': origin,
        'X-Title': 'NexusAI',
    };
}

export function jsonResponse(payload: unknown, status: number): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** The /api/chat-compatible failure body for a non-2xx OpenRouter answer. */
export function upstreamFailure(
    upstream: Response,
    payload: unknown,
    fallback: string
): { error: string; upstreamStatus: number; retryAfter?: number } {
    const raw = upstream.headers.get('retry-after');
    const retryAfter = raw ? Number(raw) : NaN;
    return {
        error: describeError(payload, `${fallback} (${upstream.status})`),
        upstreamStatus: upstream.status,
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    };
}

/**
 * The submit body. `endpoint` and `model` MUST be serialized before `requests`: the API
 * stream-parses the array and returns 400 when it appears first. JSON.stringify preserves
 * insertion order, so the order of the literal below is load-bearing.
 */
export function buildBatchEnvelope(
    model: string,
    customId: string,
    body: Record<string, unknown>
): {
    endpoint: '/v1/chat/completions';
    model: string;
    requests: { custom_id: string; body: Record<string, unknown> }[];
} {
    // The per-request model may be omitted (inherits) but must match when present; drop it
    // so the batch-level value is the single source of truth.
    const requestBody = { ...body };
    delete requestBody.model;
    return {
        endpoint: '/v1/chat/completions',
        model,
        requests: [{ custom_id: customId, body: requestBody }],
    };
}

const PENDING: readonly string[] = ['validating', 'in_progress', 'finalizing', 'cancelling'];

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readCounts(raw: Record<string, unknown>): BatchRequestCounts {
    const counts = asRecord(raw.request_counts) ?? {};
    return {
        total: asNumber(counts.total) ?? 0,
        completed: asNumber(counts.completed) ?? 0,
        failed: asNumber(counts.failed) ?? 0,
    };
}

/**
 * A readable message out of whatever OpenRouter put in `error`: a string, `{ message }`,
 * `{ error: string | { message } }`, or nothing.
 */
export function describeError(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.trim()) return value;
    const rec = asRecord(value);
    if (!rec) return fallback;
    if (typeof rec.message === 'string' && rec.message.trim()) return rec.message;
    if (rec.error !== undefined && rec.error !== null) return describeError(rec.error, fallback);
    return fallback;
}

/** Same rule as the streaming route: `reasoning`, else the text parts of `reasoning_details`. */
function readReasoning(message: Record<string, unknown>): string | undefined {
    if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
        return message.reasoning;
    }
    if (Array.isArray(message.reasoning_details)) {
        const parts = message.reasoning_details
            .map((detail) => asRecord(detail))
            .filter((d): d is Record<string, unknown> => !!d)
            .filter((d) => d.type === 'reasoning.text' && typeof d.text === 'string')
            .map((d) => d.text as string);
        if (parts.length > 0) return parts.join('');
    }
    return undefined;
}

/** Turn the raw batch object returned by OpenRouter into what the client needs. */
export function normalizeBatchStatus(raw: unknown): BatchStatusPayload {
    const batch = asRecord(raw);
    if (!batch) return { status: 'failed', error: 'Réponse batch OpenRouter illisible.' };

    const status = typeof batch.status === 'string' ? batch.status : '';
    const counts = readCounts(batch);

    if (PENDING.includes(status)) {
        return { status: status as BatchPendingStatus, requestCounts: counts };
    }

    if (status === 'expired' || status === 'cancelled') {
        return {
            status,
            error: describeError(
                batch.error,
                status === 'expired'
                    ? 'Le batch OpenRouter a expiré avant de produire une réponse.'
                    : 'Le batch OpenRouter a été annulé.'
            ),
        };
    }

    if (status !== 'completed') {
        return {
            status: 'failed',
            error: describeError(
                batch.error,
                `Batch OpenRouter en échec (${status || 'inconnu'}).`
            ),
        };
    }

    // completed — but a single-request batch is only useful if that request succeeded.
    const results = Array.isArray(batch.results) ? batch.results : [];
    const first = asRecord(results[0]);
    if (!first) {
        return { status: 'failed', error: 'Batch terminé sans résultat.' };
    }
    if (first.error != null || counts.failed > 0) {
        return {
            status: 'failed',
            error: describeError(first.error, 'La requête du batch a échoué.'),
        };
    }

    const response = asRecord(first.response);
    const body = asRecord(response?.body);
    const choices = Array.isArray(body?.choices) ? body.choices : [];
    const message = asRecord(asRecord(choices[0])?.message);
    if (!message) {
        return { status: 'failed', error: 'Résultat du batch sans message.' };
    }
    const content = typeof message.content === 'string' ? message.content : '';

    const batchUsage = asRecord(batch.usage) ?? {};
    const bodyUsage = asRecord(body?.usage) ?? {};
    const details = asRecord(bodyUsage.prompt_tokens_details);
    const usage: BatchUsage = {
        promptTokens: asNumber(batchUsage.prompt_tokens) ?? asNumber(bodyUsage.prompt_tokens) ?? 0,
        completionTokens:
            asNumber(batchUsage.completion_tokens) ?? asNumber(bodyUsage.completion_tokens) ?? 0,
        cachedTokens: asNumber(details?.cached_tokens),
        cost: asNumber(batchUsage.cost) ?? asNumber(bodyUsage.cost),
    };

    return {
        status: 'completed',
        content,
        reasoning: readReasoning(message),
        usage,
        requestCounts: counts,
    };
}
