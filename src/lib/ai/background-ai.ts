/**
 * Shared utility for background AI calls (summarization, fact extraction, etc.)
 *
 * Routing (settings.backgroundProvider):
 * - 'auto' (default): NanoGPT subscription quota when a key exists — much better models
 *   (DeepSeek V4, GLM, …) at no marginal cost — falling back to free OpenRouter models.
 * - 'nanogpt': NanoGPT first, free OpenRouter models as an error/quota fallback.
 * - 'openrouter-free': legacy behaviour, free OpenRouter rotation only.
 * Web-search calls (canon retrieval) ALWAYS run on OpenRouter — the `web` plugin is
 * OpenRouter-specific.
 *
 * Features:
 * - Model fallback chain: tries multiple models in order
 * - Exponential backoff on 429 rate limits
 * - Global rate limiter to space out requests
 * - Streaming response reading
 */

import { useSettingsStore } from '@/stores';
import { decryptApiKey } from '@/lib/crypto';
import { NANOGPT_USAGE_REFRESH_EVENT } from '@/lib/ai/nanogpt-usage';

// Fallback model chain — tried in order, skips on 429
const FREE_MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-r1-0528:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'qwen/qwen3-8b:free',
];

// Global request queue to avoid concurrent rate limit hits
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 2000; // Min 2s between background AI calls

async function waitForSlot(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    lastRequestTime = Date.now();
}

interface BackgroundAIOptions {
    systemPrompt: string;
    userPrompt: string;
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
}

interface BackgroundAIResult {
    content: string;
    usedModel: string;
    usedProvider: 'nanogpt' | 'openrouter';
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

interface ChainAttemptParams {
    provider: 'nanogpt' | 'openrouter';
    apiKey: string;
    models: string[];
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    maxTokens: number;
    maxRetries: number;
    thinkTagStrategy: 'remove-blocks' | 'remove-tags';
    webSearch: boolean;
    webMaxResults?: number;
    disableReasoning: boolean;
}

/** Try each model in order against /api/chat; returns the first non-empty cleaned response. */
async function tryModelChain(params: ChainAttemptParams): Promise<BackgroundAIResult | null> {
    const {
        provider,
        apiKey,
        models,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
        maxRetries,
        thinkTagStrategy,
        webSearch,
        webMaxResults,
        disableReasoning,
    } = params;

    for (const model of models) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Wait for global rate limit slot
                await waitForSlot();

                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: userPrompt }],
                        provider,
                        model,
                        apiKey,
                        systemPrompt,
                        temperature,
                        maxTokens,
                        // Flex tier + web_search times out (504): the slow flex queue plus the
                        // server-side search loop exceeds the deadline. Never combine them.
                        // Flex is OpenRouter-only.
                        useFlexTier:
                            provider === 'openrouter' && !webSearch
                                ? useSettingsStore.getState().useFlexTier
                                : false,
                        webSearch: provider === 'openrouter' ? webSearch : false,
                        webMaxResults,
                        disableReasoning,
                    }),
                });

                if (response.ok) {
                    const text = await readStreamFull(response);
                    const cleaned = normalizeThinkText(text, thinkTagStrategy).trim();
                    if (cleaned) {
                        return { content: cleaned, usedModel: model, usedProvider: provider };
                    }
                    // Empty response — try next model
                    break;
                }

                if (response.status === 429) {
                    if (attempt < maxRetries) {
                        // Exponential backoff: 3s, 6s
                        const delay = 3000 * Math.pow(2, attempt);
                        console.warn(
                            `[BackgroundAI] 429 on ${provider}/${model}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
                        );
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    // Exhausted retries for this model, try next
                    console.warn(
                        `[BackgroundAI] 429 on ${provider}/${model}, exhausted retries, trying next model`
                    );
                    break;
                }

                // Other error — try next model
                console.warn(
                    `[BackgroundAI] ${response.status} on ${provider}/${model}, trying next model`
                );
                break;
            } catch (err) {
                console.warn(`[BackgroundAI] Error on ${provider}/${model}:`, err);
                break;
            }
        }
    }
    return null;
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
    } = options;

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
    };

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
}

/**
 * Normalize model thinking tags according to the chosen strategy.
 * In remove-blocks mode, if everything is inside <think> tags and result becomes empty,
 * fall back to remove-tags to avoid losing usable structured output.
 */
function normalizeThinkText(
    text: string,
    strategy: 'remove-blocks' | 'remove-tags'
): string {
    if (strategy === 'remove-tags') {
        return text.replace(/<\/?think>/gi, '');
    }

    const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (withoutBlocks) return withoutBlocks;

    // Fallback: some models place all useful output inside <think> tags.
    return text.replace(/<\/?think>/gi, '');
}

/**
 * Read a streaming response body to completion.
 */
async function readStreamFull(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';

    const decoder = new TextDecoder();
    let text = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); // Flush

    return text;
}
