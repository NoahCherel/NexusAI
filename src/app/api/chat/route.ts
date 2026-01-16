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
            apiKey,
            systemPrompt,
            userPersona,
            enableReasoning,
        } = await req.json();

        console.log(
            `[API] Request: provider=${provider}, model=${model}, reasoning=${enableReasoning}, persona=${userPersona?.name}`
        );

        if (!apiKey) {
            return new Response(JSON.stringify({ error: 'API key is required' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // OpenRouter Configuration
        // We use createOpenAI aimed at OpenRouter to have full control over extraBody if needed,
        // or ensure 'include_reasoning' is passed correctly.

        let modelInstance;

        if (provider === 'openrouter') {
            // For OpenRouter, we need to pass 'include_reasoning: true' in the body.
            // The most reliable way with AI SDK is to use the 'openai' provider with custom baseURL
            // and pass 'extraBody' in the model config if supported, or rely on 'providerOptions'.
            // However, strictly speaking, 'include_reasoning' is a non-standard parameter.

            // Let's try to override the specific call options.
            // Since streamText doesn't support extraBody directly, we rely on the provider.

            const openRouterClient = createOpenRouter({
                apiKey,
                headers: {
                    'HTTP-Referer': 'http://localhost:3000',
                    'X-Title': 'NexusAI',
                },
            });

            modelInstance = openRouterClient(model);
        } else if (provider === 'openai') {
            modelInstance = createOpenAI({ apiKey })(model);
        } else if (provider === 'anthropic') {
            modelInstance = createAnthropic({ apiKey })(model);
        } else {
            throw new Error('Invalid provider');
        }

        // Inject Persona into System Prompt or Context
        let effectiveSystem = systemPrompt || 'You are a helpful AI assistant.';
        if (userPersona) {
            effectiveSystem += `\n\n[USER INFO]\nName: ${userPersona.name}\nBio: ${userPersona.bio}\n\n[INSTRUCTION]\nAdapt your responses to address the user as "${userPersona.name}" and take into account their bio.`;
        }

        // Prepare parameters
        // Note: 'include_reasoning' is specific to OpenRouter via extraBody or provider options usually
        // But the AI SDK abstracts this.
        // For OpenRouter, we might need to pass it in extraBody if the SDK doesn't map it.
        // DeepSeek R1 via OpenRouter uses 'include_reasoning: true' to show thoughts in the response body field 'reasoning'.

        const result = streamText({
            model: modelInstance,
            messages,
            system: effectiveSystem,
            temperature,
            maxTokens: 4096,
            // Attempt to pass reasoning parameters
            // Check if enableReasoning is true
            // We use 'experimental_providerMetadata' which relies on the provider implementation.
            // For OpenRouter, we will try commonly used keys.
            experimental_providerMetadata: enableReasoning
                ? {
                      openrouter: {
                          includeReasoning: true,
                          include_reasoning: true, // Try both snake_case and camelCase
                          reasoning: { effort: 'medium' }, // Try new standard just in case
                      },
                      openai: {
                          include_reasoning: true,
                      },
                  }
                : {},
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
