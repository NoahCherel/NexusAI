import { NextRequest } from 'next/server';

export const runtime = 'edge';

// Fetches the models included in the user's NanoGPT subscription.
// We use the SUBSCRIPTION endpoint (not /api/v1/models) so the list is exactly what the user's
// Pro plan covers. Normalizes the OpenAI-style response into the app's CustomModel shape.
export async function POST(req: NextRequest) {
    try {
        const { apiKey } = await req.json();

        if (!apiKey) {
            return new Response(JSON.stringify({ error: 'API key is required', models: [] }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const res = await fetch(
            'https://nano-gpt.com/api/subscription/v1/models?detailed=true',
            {
                method: 'GET',
                headers: { Authorization: `Bearer ${apiKey}` },
            }
        );

        if (!res.ok) {
            return new Response(
                JSON.stringify({ error: `NanoGPT models fetch failed (${res.status})`, models: [] }),
                { status: res.status, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const json = await res.json();

        // The response is OpenAI-shaped: { data: [{ id, name?, ... }] }. Be tolerant about the
        // wrapper key in case NanoGPT returns `models` or a bare array.
        const raw: unknown[] = Array.isArray(json)
            ? json
            : Array.isArray(json?.data)
              ? json.data
              : Array.isArray(json?.models)
                ? json.models
                : [];

        const models = raw
            .map((m) => {
                const item = m as Record<string, unknown>;
                const id = typeof item.id === 'string' ? item.id : null;
                if (!id) return null;
                const name =
                    (typeof item.name === 'string' && item.name) ||
                    (typeof item.id === 'string' && item.id) ||
                    id;
                return {
                    id: `nanogpt:${id}`,
                    name,
                    modelId: id,
                    provider: 'nanogpt' as const,
                    // Subscription-included models cost nothing extra per call; we surface them in a
                    // dedicated group, so the isFree flag is only used for the icon.
                    isFree: true,
                };
            })
            .filter(Boolean);

        return new Response(JSON.stringify({ models }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('NanoGPT models error:', error);
        return new Response(
            JSON.stringify({ error: 'Failed to fetch NanoGPT models', models: [] }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
