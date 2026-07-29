import OpenAI from 'openai';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

// Type for OpenRouter's extended message with reasoning
type OpenRouterMessage = OpenAI.Chat.Completions.ChatCompletionMessage & {
    reasoning?: string;
    reasoning_details?: unknown;
};

type OpenRouterRequestBody = Record<string, unknown>;

export async function POST(req: NextRequest) {
    try {
        const {
            messages,
            provider,
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
            apiKey,
            systemPrompt,
            userPersona,
            enableReasoning,
            useFlexTier,
            webSearch,
            webMaxResults,
            disableReasoning,
            // Number of leading messages forming the cache-stable prefix (system + history).
            // Used to place explicit cache_control breakpoints for Claude models.
            cachePrefixLength,
        } = await req.json();

        if (!apiKey) {
            return new Response(JSON.stringify({ error: 'API key is required' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const origin = req.headers.get('origin') || 'http://localhost:3000';

        // Build system message (only if provided explicit systemPrompt or userPersona)
        const fullMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [...messages];

        let effectiveSystem = '';
        if (systemPrompt) {
            effectiveSystem = systemPrompt;
        }

        if (userPersona) {
            // If we have an existing system prompt, append. If not, start one.
            const prefix = effectiveSystem ? '\n\n' : '';
            effectiveSystem += `${prefix}[USER INFO]\nName: ${userPersona.name}\nBio: ${userPersona.bio}\n\n[INSTRUCTION]\nAdapt your responses to address the user as "${userPersona.name}" and take into account their bio.`;
        }

        // Only prepend a system message if we actually constructed one
        if (effectiveSystem) {
            fullMessages.unshift({ role: 'system', content: effectiveSystem });
        }

        // Determine effective model ID
        let effectiveModelId = model;
        if (provider === 'openai' || provider === 'anthropic') {
            if (model.includes('/')) {
                effectiveModelId = model.split('/').pop() || model;
            }
        }

        // Configure client based on provider
        let client: OpenAI;
        let requestBody: OpenRouterRequestBody;

        if (provider === 'openrouter') {
            client = new OpenAI({
                baseURL: 'https://openrouter.ai/api/v1',
                apiKey,
                defaultHeaders: {
                    'HTTP-Referer': origin,
                    'X-Title': 'NexusAI',
                },
            });

            // Build request body for OpenRouter
            requestBody = {
                model: effectiveModelId,
                messages: fullMessages,
                temperature: temperature ?? 0.8,
                max_tokens: maxTokens ?? 4096,
                top_p: topP,
                frequency_penalty: frequencyPenalty,
                presence_penalty: presencePenalty,
                stop: stoppingStrings,
            } as OpenRouterRequestBody;

            // Add OpenRouter-specific parameters
            if (topK) requestBody.top_k = topK;
            if (minP) requestBody.min_p = minP;
            if (repetitionPenalty) requestBody.repetition_penalty = repetitionPenalty;
            if (useFlexTier) requestBody.service_tier = 'flex';

            // Web search for canon retrieval. We use the `web` PLUGIN (search runs BEFORE the
            // model and results are injected as context) rather than the `openrouter:web_search`
            // server tool, because the server tool requires agentic tool-calling that some models
            // (DeepSeek) don't honour — they leak the tool call as text and never finish. The
            // plugin is model-agnostic and works for DeepSeek, Gemini, etc.
            if (webSearch) {
                requestBody.plugins = [{ id: 'web', max_results: webMaxResults ?? 5 }];
            }

            // Add reasoning configuration per OpenRouter docs
            if (disableReasoning) {
                // Structured/extraction calls (e.g. canon retrieval): turn thinking off so
                // reasoning tokens don't eat the output budget and truncate the JSON.
                requestBody.reasoning = { enabled: false };
            } else if (enableReasoning) {
                const isGeminiModel = effectiveModelId.toLowerCase().includes('gemini');
                const isDeepSeekModel = effectiveModelId.toLowerCase().includes('deepseek');
                const isAnthropicModel =
                    effectiveModelId.toLowerCase().includes('claude') ||
                    effectiveModelId.toLowerCase().includes('anthropic');
                const isOpenAIReasoning =
                    effectiveModelId.toLowerCase().includes('o1') ||
                    effectiveModelId.toLowerCase().includes('o3');

                if (isGeminiModel) {
                    // Gemini thinking models support max_tokens
                    requestBody.reasoning = {
                        enabled: true,
                        max_tokens: Math.min(maxTokens ? Math.floor(maxTokens * 0.5) : 4096, 8192),
                    };
                } else if (isDeepSeekModel) {
                    // DeepSeek R1 uses effort
                    requestBody.reasoning = {
                        effort: 'high',
                    };
                } else if (isAnthropicModel) {
                    // Anthropic models use max_tokens
                    requestBody.reasoning = {
                        max_tokens: Math.min(maxTokens ? Math.floor(maxTokens * 0.5) : 4096, 8000),
                    };
                } else if (isOpenAIReasoning) {
                    // OpenAI o-series uses effort
                    requestBody.reasoning = {
                        effort: 'high',
                    };
                } else {
                    // Default: enable with medium effort
                    requestBody.reasoning = {
                        effort: 'medium',
                    };
                }
            }
        } else if (provider === 'openai') {
            client = new OpenAI({ apiKey });
            requestBody = {
                model: effectiveModelId,
                messages: fullMessages,
                temperature: temperature ?? 0.8,
                max_tokens: maxTokens ?? 4096,
                top_p: topP,
                frequency_penalty: frequencyPenalty,
                presence_penalty: presencePenalty,
                stop: stoppingStrings,
            };
        } else if (provider === 'anthropic') {
            // Use OpenRouter for Anthropic to maintain consistency
            client = new OpenAI({
                baseURL: 'https://openrouter.ai/api/v1',
                apiKey,
                defaultHeaders: {
                    'HTTP-Referer': origin,
                    'X-Title': 'NexusAI',
                },
            });
            requestBody = {
                model: effectiveModelId.startsWith('anthropic/')
                    ? effectiveModelId
                    : `anthropic/${effectiveModelId}`,
                messages: fullMessages,
                temperature: temperature ?? 0.8,
                max_tokens: maxTokens ?? 4096,
                top_p: topP,
                stop: stoppingStrings,
            };
        } else if (provider === 'nanogpt') {
            // NanoGPT is OpenAI-compatible. Model IDs are namespaced (e.g. "openai/gpt-5.2") and
            // MUST be passed through intact — the truncation above (line ~69) only runs for
            // openai/anthropic, so `effectiveModelId` is already the untouched id here.
            client = new OpenAI({
                baseURL: 'https://nano-gpt.com/api/v1',
                apiKey,
            });
            requestBody = {
                model: effectiveModelId,
                messages: fullMessages,
                temperature: temperature ?? 0.8,
                max_tokens: maxTokens ?? 4096,
                top_p: topP,
                frequency_penalty: frequencyPenalty,
                presence_penalty: presencePenalty,
                stop: stoppingStrings,
            };
        } else {
            throw new Error('Invalid provider');
        }

        // Explicit prompt-cache breakpoints for Claude models (OpenRouter passes
        // `cache_control` through to Anthropic). Mark the system message and the last
        // message of the stable prefix; Anthropic then prefix-matches on earlier
        // breakpoints as the window grows. Requires multipart content.
        const isClaudeModel =
            provider === 'anthropic' || /claude|anthropic/i.test(String(effectiveModelId));
        if (isClaudeModel && typeof cachePrefixLength === 'number' && cachePrefixLength >= 1) {
            const marks = new Set([0, Math.min(cachePrefixLength, fullMessages.length) - 1]);
            for (const i of marks) {
                const m = fullMessages[i] as { content: unknown };
                if (typeof m.content === 'string') {
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

        // Token usage reporting: ask for the usage chunk at the end of the stream, and (on
        // OpenRouter) for the accounted cost. Forwarded to the client as a trailing
        // sentinel line. NanoGPT is skipped defensively (compatibility unverified — a 400
        // here would break the user's main RP flow); the client estimates locally instead.
        if (provider === 'openrouter' || provider === 'anthropic' || provider === 'openai') {
            requestBody.stream_options = { include_usage: true };
        }
        if (provider === 'openrouter' || provider === 'anthropic') {
            requestBody.usage = { include: true };
        }

        // Create streaming response using OpenAI SDK
        // The stream: true option returns an AsyncIterable
        const stream = await client.chat.completions.create({
            ...requestBody,
            stream: true,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

        // Create a ReadableStream for SSE
        const encoder = new TextEncoder();
        const readableStream = new ReadableStream({
            async start(controller) {
                // The usage chunk arrives AFTER the finish_reason chunk — never break early.
                interface StreamUsage {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    prompt_tokens_details?: { cached_tokens?: number };
                    cost?: number;
                }
                let usageData: StreamUsage | null = null;
                try {
                    for await (const chunk of stream) {
                        const chunkUsage = (chunk as { usage?: StreamUsage }).usage;
                        if (chunkUsage) usageData = chunkUsage;

                        const delta = chunk.choices[0]?.delta;

                        if (delta?.content) {
                            controller.enqueue(encoder.encode(delta.content));
                        }

                        // Handle reasoning tokens from OpenRouter.
                        // `reasoning` and `reasoning_details` can both be present in the same
                        // delta (Gemini does this) — emit only one to avoid duplicating thinking.
                        const extendedDelta = delta as OpenRouterMessage;
                        if (extendedDelta?.reasoning) {
                            // Wrap reasoning in special tags for client-side parsing
                            controller.enqueue(
                                encoder.encode(`<think>${extendedDelta.reasoning}</think>`)
                            );
                        } else if (extendedDelta?.reasoning_details) {
                            // Handle reasoning_details array format
                            const details = extendedDelta.reasoning_details;
                            if (Array.isArray(details)) {
                                for (const detail of details) {
                                    if (detail.type === 'reasoning.text' && detail.text) {
                                        controller.enqueue(
                                            encoder.encode(`<think>${detail.text}</think>`)
                                        );
                                    }
                                }
                            }
                        }

                    }
                    // Trailing usage sentinel, parsed (and stripped) by the client.
                    if (usageData) {
                        controller.enqueue(
                            encoder.encode(
                                `\n<|nexus_usage|>${JSON.stringify({
                                    promptTokens: usageData.prompt_tokens,
                                    completionTokens: usageData.completion_tokens,
                                    cachedTokens: usageData.prompt_tokens_details?.cached_tokens,
                                    cost: usageData.cost,
                                })}`
                            )
                        );
                    }
                    controller.close();
                } catch (error) {
                    console.error('Stream error:', error);
                    controller.error(error);
                }
            },
        });

        return new Response(readableStream, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            },
        });
    } catch (error) {
        console.error('Chat API error:', error);
        return new Response(
            JSON.stringify({
                error: error instanceof Error ? error.message : 'Internal server error',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
