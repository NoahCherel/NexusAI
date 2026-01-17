import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

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

        let modelInstance;
        const extraBody: Record<string, any> = {};

        // Handle Provider-Specific Parameters
        if (repetitionPenalty) extraBody.repetition_penalty = repetitionPenalty;
        if (minP) extraBody.min_p = minP;
        if (topK) extraBody.top_k = topK; // Some providers need this in extraBody

        if (provider === 'openrouter') {
            const openRouterClient = createOpenRouter({
                apiKey,
                headers: {
                    'HTTP-Referer': 'http://localhost:3000',
                    'X-Title': 'NexusAI',
                },
            });

            // OpenRouter supports mapping extraBody via the provider config or specific options
            modelInstance = openRouterClient(model);
        } else if (provider === 'openai') {
            modelInstance = createOpenAI({ apiKey })(model);
        } else if (provider === 'anthropic') {
            modelInstance = createAnthropic({ apiKey })(model);
        } else {
            throw new Error('Invalid provider');
        }

        // Inject Persona into System Prompt
        let effectiveSystem = systemPrompt || 'You are a helpful AI assistant.';
        if (userPersona) {
            effectiveSystem += `\n\n[USER INFO]\nName: ${userPersona.name}\nBio: ${userPersona.bio}\n\n[INSTRUCTION]\nAdapt your responses to address the user as "${userPersona.name}" and take into account their bio.`;
        }

        // Prepare provider metadata for reasoning / specialized params
        const providerMetadata = {
            openrouter: {
                ...(enableReasoning ? { include_reasoning: true } : {}),
                ...extraBody, // Pass extra params like repetition_penalty here for OpenRouter
            },
            openai: {
                ...(enableReasoning ? { include_reasoning: true } : {}),
            },
        };

        const result = streamText({
            model: modelInstance,
            messages,
            system: effectiveSystem,
            temperature: temperature ?? 0.8,
            maxTokens: maxTokens ?? 4096,
            topP: topP,
            // Standard AI SDK params
            frequencyPenalty,
            presencePenalty,
            stopSequences: stoppingStrings,
            // Provider specific via metadata or internal casting (since streamText types are strict)
            experimental_providerMetadata: providerMetadata,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        return result.toTextStreamResponse();
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
