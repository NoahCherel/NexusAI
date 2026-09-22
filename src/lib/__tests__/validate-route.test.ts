import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/validate/route';

/**
 * OpenRouter used to be validated against `/models`, which is a public catalogue: it answers 200
 * without any key, so every string the user pasted was saved as a valid key.
 */
const request = (body: unknown) => ({ json: async () => body }) as NextRequest;

/** Stubs `fetch` with a fixed status and returns the list of URLs it is asked for. */
const respondWith = (status: number) => {
    const urls: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            urls.push(url);
            return new Response('{}', { status });
        })
    );
    return urls;
};

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/validate', () => {
    it('asks the key-scoped OpenRouter endpoint, not the public model catalogue', async () => {
        const urls = respondWith(200);
        const body = await (await POST(request({ provider: 'openrouter', apiKey: 'sk-x' }))).json();

        expect(urls).toEqual(['https://openrouter.ai/api/v1/key']);
        expect(body).toEqual({ isValid: true });
    });

    it('reports a rejected key as invalid', async () => {
        respondWith(401);
        const body = await (await POST(request({ provider: 'openrouter', apiKey: 'nope' }))).json();
        expect(body).toEqual({ isValid: false, reason: 'invalid' });
    });

    it('reports a rate-limited provider as unreachable, not as a bad key', async () => {
        respondWith(429);
        const body = await (await POST(request({ provider: 'openrouter', apiKey: 'sk-x' }))).json();
        expect(body).toEqual({ isValid: false, reason: 'unreachable' });
    });

    it('reports a network failure as unreachable', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('fetch failed');
            })
        );
        const response = await POST(request({ provider: 'openrouter', apiKey: 'sk-x' }));
        expect(await response.json()).toEqual({ isValid: false, reason: 'unreachable' });
    });

    it('rejects an unknown provider instead of fetching undefined', async () => {
        const urls = respondWith(200);
        const response = await POST(request({ provider: 'wat', apiKey: 'sk-x' }));

        expect(response.status).toBe(400);
        expect(urls).toEqual([]);
    });

    it('rejects a request with no key', async () => {
        const response = await POST(request({ provider: 'openrouter' }));
        expect(response.status).toBe(400);
    });
});
