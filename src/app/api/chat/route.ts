import OpenAI from 'openai';
import { NextRequest } from 'next/server';
import {
    applyClaudeCacheBreakpoints,
    buildOpenRouterChatBody,
    isClaudeModelId,
    withSystemMessage,
    type OpenRouterMessageParam,
    type OpenRouterRequestBody,
} from '@/lib/ai/openrouter-request';

export const runtime = 'edge';

// Type for OpenRouter's extended message with reasoning
type OpenRouterMessage = OpenAI.Chat.Completions.ChatCompletionMessage & {
    reasoning?: string;
    reasoning_details?: unknown;
};

export function nanogptBaseURL(billingScope?: string): string {
    return billingScope === 'paygo'
        ? 'https://nano-gpt.com/api/v1'
        : 'https://nano-gpt.com/api/subscription/v1';
}

export async function POST(req: NextRequest) {
    try {
        // The client body uses the same field names as `OpenRouterChatParams`, so the
        // OpenRouter branch forwards it whole; the other providers pick what they need.
        const params = await req.json();
        const {
            messages,
            provider,
            model,
            temperature,
            maxTokens,
            topP,
            frequencyPenalty,
            presencePenalty,
            stoppingStrings,
            apiKey,
            systemPrompt,
            userPersona,
            // NanoGPT calls selected from the subscription model list must use the
            // subscription-only endpoint. `paygo` is reserved for a future explicit UI.
            billingScope,
            // Number of leading messages forming the cache-stable prefix (system + history).
            // Used to place explicit cache_control breakpoints for Claude models.
            cachePrefixLength,
        } = params;

        if (!apiKey) {
            return new Response(JSON.stringify({ error: 'API key is required' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const origin = req.headers.get('origin') || 'http://localhost:3000';

        // Build system message (only if provided explicit systemPrompt or userPersona)
        const fullMessages = withSystemMessage(
            messages as OpenRouterMessageParam[],
            systemPrompt,
            userPersona
        );

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

            // One builder for the live stream and the Batch API (see /api/batch).
            requestBody = buildOpenRouterChatBody({
                ...params,
                messages: fullMessages,
                model: effectiveModelId,
                mode: 'stream',
            });
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
                stream_options: { include_usage: true },
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
            applyClaudeCacheBreakpoints(fullMessages, cachePrefixLength);
            requestBody = {
                model: effectiveModelId.startsWith('anthropic/')
                    ? effectiveModelId
                    : `anthropic/${effectiveModelId}`,
                messages: fullMessages,
                temperature: temperature ?? 0.8,
                max_tokens: maxTokens ?? 4096,
                top_p: topP,
                stop: stoppingStrings,
                stream_options: { include_usage: true },
                usage: { include: true },
            };
        } else if (provider === 'nanogpt') {
            // NanoGPT is OpenAI-compatible. Model IDs are namespaced (e.g. "openai/gpt-5.2") and
            // MUST be passed through intact — the truncation above only runs for
            // openai/anthropic, so `effectiveModelId` is already the untouched id here.
            client = new OpenAI({
                baseURL: nanogptBaseURL(billingScope),
                apiKey,
            });
            // A Claude model on NanoGPT still benefits from explicit cache breakpoints.
            if (isClaudeModelId(String(effectiveModelId))) {
                applyClaudeCacheBreakpoints(fullMessages, cachePrefixLength);
            }
            // Usage reporting is skipped defensively for NanoGPT (compatibility unverified —
            // a 400 here would break the user's main RP flow); the client estimates locally.
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
        const upstream = error as {
            status?: number;
            message?: string;
            headers?: Headers | { get?: (name: string) => string | null };
        };
        const upstreamStatus =
            typeof upstream.status === 'number' && upstream.status >= 400
                ? upstream.status
                : undefined;
        const retryAfterRaw = upstream.headers?.get?.('retry-after');
        const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
        return new Response(
            JSON.stringify({
                error: error instanceof Error ? error.message : 'Internal server error',
                upstreamStatus,
                retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
            }),
            {
                status: upstreamStatus ?? 500,
                headers: { 'Content-Type': 'application/json' },
            }
        );
    }
}
