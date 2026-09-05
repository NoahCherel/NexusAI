/**
 * Shared utility for background AI calls (summarization, fact extraction, etc.)
 *
 * Routing (settings.backgroundProvider):
 * - 'auto' (default): NanoGPT subscription quota when a key exists — much better models
 *   (DeepSeek V4, GLM, …) at no marginal cost — falling back to free OpenRouter models.
 * - 'nanogpt': NanoGPT only when resolving a frozen scene route.
 * - 'openrouter-free': legacy behaviour, free OpenRouter rotation only.
 * Web-search calls (canon retrieval) ALWAYS run on OpenRouter — the `web` plugin is
 * OpenRouter-specific.
 *
 * Features:
 * - Model fallback chain for non-critical background jobs
 * - Bounded retry/backoff on transient provider errors
 * - Provider-aware priority scheduler and concurrency limits
 * - Streaming response reading
 */

import { useSettingsStore } from '@/stores';
import type { CustomModel } from '@/stores/settings-store';
import { decryptApiKey } from '@/lib/crypto';
import { NANOGPT_USAGE_REFRESH_EVENT } from '@/lib/ai/nanogpt-usage';
import { extractUsageSentinel } from '@/lib/ai/usage-sentinel';
import { abortableDelay } from '@/lib/ai/abortable-delay';
import type { BackgroundRouteSnapshot } from '@/types/scene';
import type { SamplerParams } from '@/lib/ai/conversation-context';
import {
    noteProviderRateLimit,
    scheduleBackgroundRequest,
    type BackgroundPriority,
} from '@/lib/ai/background-scheduler';

/**
 * The frozen route's model cannot hold the payload. Only raised in full-payload mode: a
 * legacy extraction call keeps its null-on-failure contract.
 */
export class BackgroundContextLengthError extends Error {
    constructor(
        readonly model: string,
        readonly detail: string
    ) {
        super(detail);
        this.name = 'BackgroundContextLengthError';
    }
}

const CONTEXT_LENGTH_PATTERN =
    /context.length|context.window|maximum context|max(?:imum)?_?tokens|too many tokens|token limit|exceeds? the (?:model|context)|prompt is too long|input is too long/i;

// Fallback model chain — tried in order, skips on 429
const FREE_MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-r1-0528:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'qwen/qwen3-8b:free',
];

export interface BackgroundAIOptions {
    /**
     * Legacy single-turn mode: a synthetic user message plus a separate system prompt. Kept
     * for the small extraction agents (relationships, facts, canon retrieval).
     */
    systemPrompt: string;
    userPrompt: string;
    /**
     * Full-payload mode. When present it REPLACES systemPrompt/userPrompt: the messages are
     * sent as-is (system already at [0]) exactly like the visible generation, so an invisible
     * agent shares the composer's context byte for byte. Pair it with `sampler` so the
     * active preset governs the call too.
     */
    messages?: { role: string; content: string }[];
    /** Preset-derived sampler body (see buildSamplerParams). Overrides temperature/maxTokens. */
    sampler?: SamplerParams;
    /** system + history boundary, for provider prompt caching. */
    cachePrefixLength?: number;
    /**
     * Optional pre-resolved OpenRouter key. When omitted, keys are resolved from settings.
     * (Legacy param — only affects the OpenRouter path.)
     */
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
    /** Override the OpenRouter-path model chain */
    models?: string[];
    /** Max retries per model on 429 */
    maxRetries?: number;
    /** User-chosen OpenRouter background model override (from settings). */
    backgroundModel?: string | null;
    /**
     * How to process <think> tags in model output:
     * - remove-blocks: remove <think>...</think> blocks (default)
     * - remove-tags: keep text but strip only the <think> tags
     */
    thinkTagStrategy?: 'remove-blocks' | 'remove-tags';
    /** Enable web search (canon retrieval). Forces the OpenRouter path. */
    webSearch?: boolean;
    /** Max results per web search call (default 5). */
    webMaxResults?: number;
    /** Turn model thinking off (structured/extraction calls). Defaults to true when webSearch. */
    disableReasoning?: boolean;
    /** Freeze a previously resolved provider/model. No model or provider fallback is used. */
    route?: BackgroundRouteSnapshot;
    signal?: AbortSignal;
    priority?: BackgroundPriority;
    /** Total deadline for this logical call, including queueing and retries. */
    timeoutMs?: number;
}

export interface BackgroundAIResult {
    content: string;
    usedModel: string;
    usedProvider: 'nanogpt' | 'openrouter';
    /** Provider-reported token usage. Absent on NanoGPT, which emits no sentinel. */
    usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number };
}

/** Decrypt the stored key for a provider, or null when absent/broken. */
async function resolveKey(provider: 'openrouter' | 'nanogpt'): Promise<string | null> {
    const cfg = useSettingsStore.getState().apiKeys.find((k) => k.provider === provider);
    if (!cfg) return null;
    try {
        const key = await decryptApiKey(cfg.encryptedKey);
        return key || null;
    } catch {
        return null;
    }
}

/**
 * Pick the NanoGPT model for background work: the user's explicit choice, else a cheap
 * capable model from their subscription list (fetched into settings.nanogptModels).
 */
function pickNanogptBackgroundModel(): string | null {
    const { nanogptBackgroundModel, nanogptModels } = useSettingsStore.getState();
    if (nanogptBackgroundModel) return nanogptBackgroundModel;
    if (nanogptModels.length === 0) return null;
    const preferences = [/deepseek/i, /glm/i, /qwen/i, /flash/i, /mini/i];
    for (const re of preferences) {
        const hit = nanogptModels.find((m) => re.test(m.modelId) || re.test(m.name));
        if (hit) return hit.modelId;
    }
    return nanogptModels[0].modelId;
}

let lastNanoModelRefresh = 0;

async function refreshNanogptSubscriptionModels(apiKey: string): Promise<void> {
    const settings = useSettingsStore.getState();
    if (settings.nanogptModels.length > 0 && Date.now() - lastNanoModelRefresh < 5 * 60_000) {
        return;
    }
    const response = await fetch('/api/nanogpt/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
    });
    if (!response.ok) {
        if (settings.nanogptModels.length > 0) {
            lastNanoModelRefresh = Date.now();
            console.warn(
                `[BackgroundAI] NanoGPT model refresh failed (${response.status}); using the last verified cached list.`
            );
            return;
        }
        throw new Error(
            `Impossible de vérifier les modèles inclus dans l’abonnement NanoGPT (${response.status}).`
        );
    }
    const payload = (await response.json()) as { models?: unknown };
    if (!Array.isArray(payload.models)) {
        throw new Error('La liste des modèles NanoGPT incluse dans l’abonnement est invalide.');
    }
    useSettingsStore.getState().setNanogptModels(payload.models as CustomModel[]);
    lastNanoModelRefresh = Date.now();
}

interface ChainAttemptParams {
    provider: 'nanogpt' | 'openrouter';
    apiKey: string;
    models: string[];
    systemPrompt: string;
    userPrompt: string;
    /** Full-payload mode: sent verbatim instead of systemPrompt + a synthetic user turn. */
    messages?: { role: string; content: string }[];
    sampler?: SamplerParams;
    cachePrefixLength?: number;
    temperature: number;
    maxTokens: number;
    maxRetries: number;
    thinkTagStrategy: 'remove-blocks' | 'remove-tags';
    webSearch: boolean;
    webMaxResults?: number;
    disableReasoning: boolean;
    billingScope?: 'subscription' | 'free';
    signal?: AbortSignal;
    priority?: BackgroundPriority;
}

/** Try each model in order against /api/chat; returns the first non-empty cleaned response. */
async function tryModelChain(params: ChainAttemptParams): Promise<BackgroundAIResult | null> {
    const {
        provider,
        apiKey,
        models,
        systemPrompt,
        userPrompt,
        messages,
        sampler,
        cachePrefixLength,
        temperature,
        maxTokens,
        maxRetries,
        thinkTagStrategy,
        webSearch,
        webMaxResults,
        disableReasoning,
        billingScope,
        signal,
        priority,
    } = params;

    for (const model of models) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const scheduled = await scheduleBackgroundRequest({
                    provider,
                    priority,
                    signal,
                    // Hold the semaphore until the streamed body is fully consumed. `fetch`
                    // alone resolves at headers and would make long generations appear done,
                    // defeating the provider-wide concurrency ceiling.
                    task: async () => {
                        const response = await fetch('/api/chat', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                // Full-payload mode carries its own system message at [0];
                                // legacy mode sends one synthetic user turn plus a system
                                // prompt the route prepends.
                                messages: messages ?? [{ role: 'user', content: userPrompt }],
                                provider,
                                model,
                                apiKey,
                                systemPrompt: messages ? undefined : systemPrompt,
                                cachePrefixLength,
                                // The preset governs an agent exactly as it governs the
                                // visible reply; legacy callers keep their own two knobs.
                                temperature: sampler?.temperature ?? temperature,
                                maxTokens: sampler?.maxTokens ?? maxTokens,
                                topP: sampler?.topP,
                                topK: sampler?.topK,
                                frequencyPenalty: sampler?.frequencyPenalty,
                                presencePenalty: sampler?.presencePenalty,
                                repetitionPenalty: sampler?.repetitionPenalty,
                                minP: sampler?.minP,
                                stoppingStrings: sampler?.stoppingStrings,
                                enableReasoning: sampler?.enableReasoning,
                                billingScope:
                                    provider === 'nanogpt'
                                        ? (billingScope ?? 'subscription')
                                        : undefined,
                                // Flex tier + web_search times out (504): the slow flex queue
                                // plus the server-side search loop exceeds the deadline.
                                useFlexTier:
                                    provider === 'openrouter' && !webSearch
                                        ? (sampler?.useFlexTier ??
                                          useSettingsStore.getState().useFlexTier)
                                        : false,
                                webSearch: provider === 'openrouter' ? webSearch : false,
                                webMaxResults,
                                // The visible generation never sends this; a full-payload
                                // agent must not be silently stripped of reasoning either.
                                disableReasoning: sampler ? undefined : disableReasoning,
                            }),
                            signal,
                        });
                        if (response.ok) {
                            const stream = await readStreamFull(response);
                            return { response, text: stream.clean, usage: stream.usage };
                        }
                        const errorPayload = (await response.json().catch(() => ({}))) as Record<
                            string,
                            unknown
                        >;
                        return { response, errorPayload };
                    },
                });
                const { response } = scheduled;

                if (response.ok) {
                    const cleaned = normalizeThinkText(
                        scheduled.text ?? '',
                        thinkTagStrategy
                    ).trim();
                    if (cleaned) {
                        return {
                            content: cleaned,
                            usedModel: model,
                            usedProvider: provider,
                            usage: scheduled.usage,
                        };
                    }
                    // Empty response — try next model
                    break;
                }

                const errorPayload = scheduled.errorPayload ?? {};
                const upstreamStatus =
                    typeof errorPayload.upstreamStatus === 'number'
                        ? errorPayload.upstreamStatus
                        : response.status;
                const retryable = [408, 429, 500, 503].includes(upstreamStatus);
                if (upstreamStatus === 429) noteProviderRateLimit(provider);

                if (retryable) {
                    if (attempt < maxRetries) {
                        const retryAfter = Number(errorPayload.retryAfter);
                        const delay =
                            Number.isFinite(retryAfter) && retryAfter > 0
                                ? retryAfter * 1000
                                : 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
                        console.warn(
                            `[BackgroundAI] ${upstreamStatus} on ${provider}/${model}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
                        );
                        await abortableDelay(delay, signal);
                        continue;
                    }
                    console.warn(
                        `[BackgroundAI] ${upstreamStatus} on ${provider}/${model}, retries exhausted`
                    );
                    break;
                }

                // A full-payload agent that does not fit its model is a configuration
                // problem, not a transient one: surface it instead of a silent null.
                const detail = typeof errorPayload.error === 'string' ? errorPayload.error : '';
                if (
                    messages &&
                    (upstreamStatus === 400 || upstreamStatus === 413) &&
                    CONTEXT_LENGTH_PATTERN.test(detail)
                ) {
                    throw new BackgroundContextLengthError(model, detail);
                }

                // Other error — try next model
                console.warn(
                    `[BackgroundAI] ${response.status} on ${provider}/${model}, trying next model`
                );
                break;
            } catch (err) {
                if (err instanceof BackgroundContextLengthError) throw err;
                console.warn(`[BackgroundAI] Error on ${provider}/${model}:`, err);
                break;
            }
        }
    }
    return null;
}

/** Resolve the user's background choice once; critical scene calls reuse this snapshot. */
export async function resolveBackgroundRoute(
    options: {
        refreshSubscriptionModels?: boolean;
    } = {}
): Promise<BackgroundRouteSnapshot | null> {
    const settings = useSettingsStore.getState();
    const routing = settings.backgroundProvider ?? 'auto';
    if (routing === 'auto' || routing === 'nanogpt') {
        const key = await resolveKey('nanogpt');
        if (key && options.refreshSubscriptionModels) {
            await refreshNanogptSubscriptionModels(key);
        }
        const model = key ? pickNanogptBackgroundModel() : null;
        if (key && model) {
            const refreshedSettings = useSettingsStore.getState();
            if (
                refreshedSettings.nanogptBackgroundModel &&
                !refreshedSettings.nanogptModels.some(
                    (candidate) => candidate.modelId === refreshedSettings.nanogptBackgroundModel
                )
            ) {
                throw new Error(
                    `Le modèle NanoGPT « ${refreshedSettings.nanogptBackgroundModel} » n’est plus inclus dans l’abonnement. Choisissez un autre modèle background.`
                );
            }
            return {
                provider: 'nanogpt',
                model,
                billingScope: 'subscription',
                routing,
                resolvedAt: Date.now(),
            };
        }
        if (routing === 'nanogpt') return null;
    }

    const openRouterKey = await resolveKey('openrouter');
    if (!openRouterKey) return null;
    return {
        provider: 'openrouter',
        model: settings.backgroundModel || FREE_MODELS[0],
        billingScope: 'free',
        routing,
        resolvedAt: Date.now(),
    };
}

/**
 * Make a background AI call with provider routing, model fallback and rate limit handling.
 * Returns cleaned text (thinking tags removed) or null on total failure.
 */
export async function backgroundAICall(
    options: BackgroundAIOptions
): Promise<BackgroundAIResult | null> {
    const {
        systemPrompt,
        userPrompt,
        temperature = 0.3,
        maxTokens = 2000,
        models,
        maxRetries = 2,
        thinkTagStrategy = 'remove-blocks',
        webSearch = false,
        webMaxResults,
        disableReasoning = webSearch, // canon/extraction calls don't need thinking
        route,
        signal,
        priority = 'background',
        messages,
        sampler,
        cachePrefixLength,
        // A full-payload agent sends the whole conversation; 90 s is the small-extraction
        // budget and is not enough for a 30k-token prompt on a slow free model.
        timeoutMs = messages ? 240_000 : 90_000,
    } = options;
    // Safari < 17.4 has neither AbortSignal.timeout nor AbortSignal.any.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combineController = new AbortController();
    const abortCombined = () => combineController.abort();
    signal?.addEventListener('abort', abortCombined, { once: true });
    timeoutController.signal.addEventListener('abort', abortCombined, { once: true });
    if (signal?.aborted || timeoutController.signal.aborted) abortCombined();
    const effectiveSignal = combineController.signal;

    try {
        const settings = useSettingsStore.getState();
        // Persisted stores from before this field existed may miss it despite the default.
        const routing = settings.backgroundProvider ?? 'auto';

        const shared = {
            systemPrompt,
            userPrompt,
            temperature,
            maxTokens,
            maxRetries,
            thinkTagStrategy,
            webSearch,
            webMaxResults,
            disableReasoning,
            messages,
            sampler,
            cachePrefixLength,
            signal: effectiveSignal,
            priority,
        };

        // A critical caller already resolved the route. Try exactly that route/model and return
        // failure to the caller; never drift to a different provider halfway through a beat.
        if (route) {
            const routeKey = await resolveKey(route.provider);
            if (!routeKey) return null;
            return tryModelChain({
                ...shared,
                provider: route.provider,
                apiKey: routeKey,
                models: [route.model],
                billingScope: route.billingScope,
                webSearch: false,
            });
        }

        // 1. NanoGPT path — never for web search (the `web` plugin is OpenRouter-only).
        if (!webSearch && (routing === 'auto' || routing === 'nanogpt')) {
            const nanoKey = await resolveKey('nanogpt');
            const nanoModel = nanoKey ? pickNanogptBackgroundModel() : null;
            if (nanoKey && nanoModel) {
                const result = await tryModelChain({
                    ...shared,
                    provider: 'nanogpt',
                    apiKey: nanoKey,
                    models: [nanoModel],
                    billingScope: 'subscription',
                });
                if (result) {
                    // Quota was consumed — ask the usage badge to refetch.
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new Event(NANOGPT_USAGE_REFRESH_EVENT));
                    }
                    return result;
                }
                console.warn(
                    '[BackgroundAI] NanoGPT background path failed — falling back to OpenRouter'
                );
            }
        }

        // 2. OpenRouter path (free rotation, or the user's OpenRouter background override).
        const orKey = options.apiKey || (await resolveKey('openrouter'));
        if (!orKey) {
            console.error('[BackgroundAI] No usable API key for background call');
            return null;
        }

        const fallbackModels = models ?? FREE_MODELS;
        // An explicit `models` list (e.g. canon retrieval's grounding model) is authoritative —
        // the settings-level OpenRouter override only reorders the default free chain.
        const orOverride = models ? null : (options.backgroundModel ?? settings.backgroundModel);
        const modelChain = orOverride
            ? [orOverride, ...fallbackModels.filter((m) => m !== orOverride)]
            : fallbackModels;

        const result = await tryModelChain({
            ...shared,
            provider: 'openrouter',
            apiKey: orKey,
            models: modelChain,
        });
        if (!result) console.error('[BackgroundAI] All models exhausted');
        return result;
    } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abortCombined);
        timeoutController.signal.removeEventListener('abort', abortCombined);
    }
}

/**
 * Normalize model thinking tags according to the chosen strategy.
 * In remove-blocks mode, if everything is inside <think> tags and result becomes empty,
 * fall back to remove-tags to avoid losing usable structured output.
 */
function normalizeThinkText(text: string, strategy: 'remove-blocks' | 'remove-tags'): string {
    if (strategy === 'remove-tags') {
        return text.replace(/<\/?think>/gi, '');
    }

    const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (withoutBlocks) return withoutBlocks;

    // Fallback: some models place all useful output inside <think> tags.
    return text.replace(/<\/?think>/gi, '');
}

/**
 * Read a streaming response body to completion. Strips the trailing `<|nexus_usage|>`
 * sentinel — background consumers parse this text as JSON (Director) or store it verbatim
 * (extractors), so the raw sentinel must NEVER leak through. A paid background model's
 * real cost still counts toward the weekly OpenRouter budget.
 */
async function readStreamFull(response: Response): Promise<{
    clean: string;
    usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number };
}> {
    const reader = response.body?.getReader();
    if (!reader) return { clean: '' };

    const decoder = new TextDecoder();
    let text = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); // Flush

    const { clean, usage } = extractUsageSentinel(text);
    if (usage?.cost && usage.cost > 0) {
        try {
            useSettingsStore.getState().addWeeklySpend(usage.cost);
        } catch {
            /* store unavailable (tests/SSR) — accounting is best-effort */
        }
    }
    return {
        clean,
        usage: usage
            ? {
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  cachedTokens: usage.cachedTokens,
              }
            : undefined,
    };
}
