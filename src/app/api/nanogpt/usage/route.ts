import { NextRequest } from 'next/server';

export const runtime = 'edge';

// Returns the user's NanoGPT subscription usage (quota remaining) as RAW JSON.
// We deliberately do NOT remap fields server-side: the published docs and the live Pro plan
// disagree on the schema (docs say "operations" daily/monthly; the Pro plan advertises weekly
// input tokens), so the client picks the right window/unit from whatever the live API returns.
export async function POST(req: NextRequest) {
    try {
        const { apiKey } = await req.json();

        if (!apiKey) {
            return new Response(JSON.stringify({ error: 'API key is required' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const res = await fetch('https://nano-gpt.com/api/subscription/v1/usage', {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (!res.ok) {
            return new Response(
                JSON.stringify({ error: `NanoGPT usage fetch failed (${res.status})` }),
                { status: res.status, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const json = await res.json();
        return new Response(JSON.stringify(json), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('NanoGPT usage error:', error);
        return new Response(JSON.stringify({ error: 'Failed to fetch NanoGPT usage' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
