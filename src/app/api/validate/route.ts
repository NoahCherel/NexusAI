import { NextRequest } from 'next/server';

export const runtime = 'edge';

/**
 * Why a key can be refused. `invalid` = the provider said no (401/403). `unreachable` = we never
 * got an answer we can trust (429, 5xx, network). Collapsing the two made a rate-limited provider
 * look like a bad key, and users deleted working keys because of it.
 */
type ValidationReason = 'invalid' | 'unreachable';

function reply(isValid: boolean, reason?: ValidationReason, status = 200) {
    return new Response(JSON.stringify(reason ? { isValid, reason } : { isValid }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

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
            // The key-scoped endpoint, NOT `/models`: the model catalogue is public and answers
            // 200 to an unauthenticated request, so it validated literally any string.
            // `/key` describes the calling key and returns 401 when there is none.
            openrouter: 'https://openrouter.ai/api/v1/key',
            openai: 'https://api.openai.com/v1/models',
            // Use the PROTECTED subscription endpoint: it returns 401 without a key, so a bad key
            // actually fails. The public .../api/v1/models endpoint answers 200 even without a key
            // and would validate anything (false positive). Side effect: a NanoGPT key without an
            // active subscription will fail validation, which is fine — the feature targets Pro.
            nanogpt: 'https://nano-gpt.com/api/subscription/v1/usage',
        };

        if (!(provider in endpoints)) {
            return new Response(JSON.stringify({ error: 'Unknown provider', isValid: false }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const response = await fetch(endpoints[provider as keyof typeof endpoints], {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (response.ok) return reply(true);
        if (response.status === 401 || response.status === 403) return reply(false, 'invalid');
        return reply(false, 'unreachable');
    } catch (error) {
        console.error('Validation error:', error);
        return reply(false, 'unreachable', 500);
    }
}
