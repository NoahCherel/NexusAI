/**
 * The OpenRouter chat request body, built once for both transports:
 * - `stream`: the live `/api/chat` route (SSE, usage sentinel at the end);
 * - `batch`: one request inside a `POST /api/beta/batches` envelope (no stream, no
 *   stream_options — the batch reports usage at its own level).
 *
 * Edge-safe and store-free: imported by the API routes and by the unit tests.
 */

export type OpenRouterRequestBody = Record<string, unknown>;

/** A chat message as sent by the client; content may already be multipart. */
export interface OpenRouterMessageParam {
    role: string;
    content: unknown;
    [key: string]: unknown;
}

export interface UserPersonaParam {
    name: string;
    bio: string;
}

export interface OpenRouterChatParams {
    messages: OpenRouterMessageParam[];
    model: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    repetitionPenalty?: number;
    minP?: number;
    stoppingStrings?: string[];
    systemPrompt?: string;
    userPersona?: UserPersonaParam;
    enableReasoning?: boolean;
    disableReasoning?: boolean;
    /** OpenRouter flex tier: cheaper, slower capacity on the same live request. */
    useFlexTier?: boolean;
    webSearch?: boolean;
    webMaxResults?: number;
    /** Number of leading messages forming the cache-stable prefix (system + history). */
    cachePrefixLength?: number;
    mode: 'stream' | 'batch';
}

/** The system message the route prepends when a caller sends a separate systemPrompt/persona. */
export function buildSystemMessage(systemPrompt?: string, userPersona?: UserPersonaParam): string {
    let effectiveSystem = systemPrompt || '';
    if (userPersona) {
        const prefix = effectiveSystem ? '\n\n' : '';
        effectiveSystem += `${prefix}[USER INFO]\nName: ${userPersona.name}\nBio: ${userPersona.bio}\n\n[INSTRUCTION]\nAdapt your responses to address the user as "${userPersona.name}" and take into account their bio.`;
    }
    return effectiveSystem;
}

/** Prepend the constructed system message (if any) to a copy of the messages. */
export function withSystemMessage(
    messages: OpenRouterMessageParam[],
    systemPrompt?: string,
    userPersona?: UserPersonaParam
): OpenRouterMessageParam[] {
    const full = [...messages];
    const system = buildSystemMessage(systemPrompt, userPersona);
    if (system) full.unshift({ role: 'system', content: system });
    return full;
}

/** OpenRouter's `reasoning` object for a model family. Mirrors the OpenRouter docs. */
export function buildReasoningConfig(
    modelId: string,
    maxTokens: number | undefined
): Record<string, unknown> {
    const lower = modelId.toLowerCase();
    const isGeminiModel = lower.includes('gemini');
    const isDeepSeekModel = lower.includes('deepseek');
    const isAnthropicModel = lower.includes('claude') || lower.includes('anthropic');
    const isOpenAIReasoning = lower.includes('o1') || lower.includes('o3');

    if (isGeminiModel) {
        // Gemini thinking models support max_tokens
        return {
            enabled: true,
            max_tokens: Math.min(maxTokens ? Math.floor(maxTokens * 0.5) : 4096, 8192),
        };
    }
    if (isDeepSeekModel) return { effort: 'high' }; // DeepSeek R1 uses effort
    if (isAnthropicModel) {
        // Anthropic models use max_tokens
        return { max_tokens: Math.min(maxTokens ? Math.floor(maxTokens * 0.5) : 4096, 8000) };
    }
    if (isOpenAIReasoning) return { effort: 'high' }; // OpenAI o-series uses effort
    return { effort: 'medium' }; // Default: enable with medium effort
}

export function isClaudeModelId(modelId: string): boolean {
    return /claude|anthropic/i.test(modelId);
}

/**
 * Explicit prompt-cache breakpoints for Claude models (OpenRouter passes `cache_control`
 * through to Anthropic). Marks the system message and the last message of the stable
 * prefix; Anthropic then prefix-matches on earlier breakpoints as the window grows.
 * Requires multipart content. Mutates the given messages in place.
 */
export function applyClaudeCacheBreakpoints(
    messages: OpenRouterMessageParam[],
    cachePrefixLength: number | undefined
): void {
    if (typeof cachePrefixLength !== 'number' || cachePrefixLength < 1) return;
    const marks = new Set([0, Math.min(cachePrefixLength, messages.length) - 1]);
    for (const i of marks) {
        const m = messages[i];
        if (m && typeof m.content === 'string') {
            m.content = [
                {
                    type: 'text',
                    text: m.content,
                    cache_control: { type: 'ephemeral' },
                },
            ];
        }
    }
}

/**
 * The full OpenRouter chat body. `messages` must already carry the system message (see
 * `withSystemMessage`). Same knobs in both modes; only the transport fields differ.
 */
export function buildOpenRouterChatBody(params: OpenRouterChatParams): OpenRouterRequestBody {
    const {
        messages,
        model,
        temperature,
        maxTokens,
        topP,
        topK,
        frequencyPenalty,
        presencePenalty,
        repetitionPenalty,
        minP,
        stoppingStrings,
        enableReasoning,
        disableReasoning,
        useFlexTier,
        webSearch,
        webMaxResults,
        cachePrefixLength,
        mode,
    } = params;

    const fullMessages = messages.map((m) => ({ ...m }));
    if (isClaudeModelId(model)) applyClaudeCacheBreakpoints(fullMessages, cachePrefixLength);

    const body: OpenRouterRequestBody = {
        model,
        messages: fullMessages,
        temperature: temperature ?? 0.8,
        max_tokens: maxTokens ?? 4096,
        top_p: topP,
        frequency_penalty: frequencyPenalty,
        presence_penalty: presencePenalty,
        stop: stoppingStrings,
    };

    // OpenRouter-specific sampler parameters
    if (topK) body.top_k = topK;
    if (minP) body.min_p = minP;
    if (repetitionPenalty) body.repetition_penalty = repetitionPenalty;

    // Web search for canon retrieval. We use the `web` PLUGIN (search runs BEFORE the
    // model and results are injected as context) rather than the `openrouter:web_search`
    // server tool, because the server tool requires agentic tool-calling that some models
    // (DeepSeek) don't honour — they leak the tool call as text and never finish. The
    // plugin is model-agnostic and works for DeepSeek, Gemini, etc.
    if (webSearch) {
        body.plugins = [{ id: 'web', max_results: webMaxResults ?? 5 }];
    }

    if (disableReasoning) {
        // Structured/extraction calls (e.g. canon retrieval): turn thinking off so
        // reasoning tokens don't eat the output budget and truncate the JSON.
        body.reasoning = { enabled: false };
    } else if (enableReasoning) {
        body.reasoning = buildReasoningConfig(model, maxTokens);
    }

    if (mode === 'stream') {
        // Flex is a capacity grade of the live request; a batch is already discounted.
        if (useFlexTier) body.service_tier = 'flex';
        // Token usage reporting: the usage chunk at the end of the stream, plus the
        // accounted cost. Forwarded to the client as a trailing sentinel line.
        body.stream_options = { include_usage: true };
        body.usage = { include: true };
    }
    // Batch: no `stream`, no `stream_options`, no tier. The batch reports usage itself.

    return body;
}
