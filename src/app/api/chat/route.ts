import OpenAI from 'openai';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

// Type for OpenRouter's extended message with reasoning
type OpenRouterMessage = OpenAI.Chat.Completions.ChatCompletionMessage & {
    reasoning?: string;
    reasoning_details?: unknown;
};

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
        } = await req.json();

        console.log(
            `[API] Request: provider=${provider}, model=${model}, temp=${temperature}, maxTokens=${maxTokens}, reasoning=${enableReasoning}`
        );

        if (!apiKey) {
            return new Response(JSON.stringify({ error: 'API key is required' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const origin = req.headers.get('origin') || 'http://localhost:3000';

        // Build system message
        let effectiveSystem = systemPrompt || 'You are a helpful AI assistant.';
        if (userPersona) {
            effectiveSystem += `\n\n[USER INFO]\nName: ${userPersona.name}\nBio: ${userPersona.bio}\n\n[INSTRUCTION]\nAdapt your responses to address the user as "${userPersona.name}" and take into account their bio.`;
        }

        // Build messages array with system prompt
        const fullMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: effectiveSystem },
            ...messages,
        ];

        // Determine effective model ID
        let effectiveModelId = model;
        if (provider === 'openai' || provider === 'anthropic') {
            if (model.includes('/')) {
                effectiveModelId = model.split('/').pop() || model;
            }
        }

        // Configure client based on provider
        let client: OpenAI;
        let requestBody: any;

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
            } as any;

            // Add OpenRouter-specific parameters
            if (topK) requestBody.top_k = topK;
            if (minP) requestBody.min_p = minP;
            if (repetitionPenalty) requestBody.repetition_penalty = repetitionPenalty;

            // Add reasoning configuration per OpenRouter docs
            if (enableReasoning) {
                const isGeminiModel = effectiveModelId.toLowerCase().includes('gemini');
                const isDeepSeekModel = effectiveModelId.toLowerCase().includes('deepseek');
                const isAnthropicModel = effectiveModelId.toLowerCase().includes('claude') || effectiveModelId.toLowerCase().includes('anthropic');
                const isOpenAIReasoning = effectiveModelId.toLowerCase().includes('o1') || effectiveModelId.toLowerCase().includes('o3');

                if (isGeminiModel) {
                    // Gemini thinking models support max_tokens
                    requestBody.reasoning = {
                        enabled: true,
                        max_tokens: Math.min(maxTokens ? Math.floor(maxTokens * 0.5) : 4096, 8192),
                    };
                } else if (isDeepSeekModel) {
                    // DeepSeek R1 uses effort
                    requestBody.reasoning = {
                        effort: 'medium',
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
                console.log(`[API] Reasoning config for ${model}:`, requestBody.reasoning);
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
                model: effectiveModelId.startsWith('anthropic/') ? effectiveModelId : `anthropic/${effectiveModelId}`,
                messages: fullMessages,
                temperature: temperature ?? 0.8,
                max_tokens: maxTokens ?? 4096,
                top_p: topP,
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
                try {
                    for await (const chunk of stream) {
                        const delta = chunk.choices[0]?.delta;
                        
                        if (delta?.content) {
                            controller.enqueue(encoder.encode(delta.content));
                        }

                        // Handle reasoning tokens from OpenRouter
                        const extendedDelta = delta as any;
                        if (extendedDelta?.reasoning) {
                            // Wrap reasoning in special tags for client-side parsing
                            controller.enqueue(encoder.encode(`<think>${extendedDelta.reasoning}</think>`));
                        }
                        if (extendedDelta?.reasoning_details) {
                            // Handle reasoning_details array format
                            const details = extendedDelta.reasoning_details;
                            if (Array.isArray(details)) {
                                for (const detail of details) {
                                    if (detail.type === 'reasoning.text' && detail.text) {
                                        controller.enqueue(encoder.encode(`<think>${detail.text}</think>`));
                                    }
                                }
                            }
                        }

                        if (chunk.choices[0]?.finish_reason) {
                            break;
                        }
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
                'Connection': 'keep-alive',
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
