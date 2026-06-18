import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
    try {
        const { provider, apiKey } = await req.json();

        if (!apiKey || !provider) {
            return new Response(JSON.stringify({ error: 'Missing parameters', isValid: false }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const endpoints = {
            openrouter: 'https://openrouter.ai/api/v1/models',
            openai: 'https://api.openai.com/v1/models',
            anthropic: 'https://api.anthropic.com/v1/messages', // Different check for Anthropic
            // Use the PROTECTED subscription endpoint: it returns 401 without a key, so a bad key
            // actually fails. The public .../api/v1/models endpoint answers 200 even without a key
            // and would validate anything (false positive). Side effect: a NanoGPT key without an
            // active subscription will fail validation, which is fine — the feature targets Pro.
            nanogpt: 'https://nano-gpt.com/api/subscription/v1/usage',
        };

        const headers: Record<string, string> = {
            openrouter: `Bearer ${apiKey}`,
            openai: `Bearer ${apiKey}`,
            anthropic: apiKey,
            nanogpt: `Bearer ${apiKey}`,
        };

        let response;

        if (provider === 'anthropic') {
            // Anthropic doesn't have a simple models endpoint, try a dummy message
            response = await fetch(endpoints.anthropic, {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'hi' }],
                }),
            });
        } else {
            response = await fetch(endpoints[provider as keyof typeof endpoints], {
                method: 'GET',
                headers: {
                    Authorization: headers[provider as keyof typeof headers],
                },
            });
        }

        return new Response(JSON.stringify({ isValid: response.ok }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('Validation error:', error);
        return new Response(JSON.stringify({ error: 'Validation failed', isValid: false }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
