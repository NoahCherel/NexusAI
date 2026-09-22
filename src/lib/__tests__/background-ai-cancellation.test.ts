import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundRouteSnapshot } from '@/types/scene';

/**
 * The frozen-route path used to `return` the provider call instead of `return await`-ing it, so
 * the enclosing `finally` tore down the deadline and the abort listeners while the request was
 * still running: neither a timeout nor the caller's abort ever reached the provider.
 */
vi.mock('@/stores', () => ({
    useSettingsStore: {
        getState: () => ({
            apiKeys: [
                { provider: 'openrouter', encryptedKey: 'enc' },
                { provider: 'nanogpt', encryptedKey: 'enc' },
            ],
            backgroundProvider: 'auto',
            nanogptModels: [],
            backgroundModel: undefined,
        }),
    },
}));

vi.mock('@/lib/crypto', () => ({ decryptApiKey: async () => 'sk-test' }));

const { backgroundAICall } = await import('@/lib/ai/background-ai');

// NanoGPT rather than OpenRouter only so the two tests do not queue behind each other: the
// OpenRouter scheduler allows one start every two seconds.
const route: BackgroundRouteSnapshot = {
    provider: 'nanogpt',
    model: 'test/model',
    billingScope: 'subscription',
    routing: 'auto',
    resolvedAt: 0,
};

/** Never answers: the request is still in flight when the deadline or the caller's abort fires. */
function hangingFetch() {
    const seen: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        if (init?.signal) seen.push(init.signal);
        // Hangs like a slow provider, and rejects on abort like a real `fetch` — otherwise the
        // background scheduler's slot is never released and the next test cannot get one.
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true }
            );
        });
    });
    vi.stubGlobal('fetch', fetchMock);
    return seen;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

afterEach(() => vi.unstubAllGlobals());

describe('backgroundAICall on a frozen route', () => {
    it('still aborts the in-flight provider request when its own deadline passes', async () => {
        const seen = hangingFetch();
        void backgroundAICall({
            systemPrompt: 'sys',
            userPrompt: 'user',
            route,
            timeoutMs: 10,
        }).catch(() => {});

        await settled();
        expect(seen).toHaveLength(1);
        expect(seen[0].aborted).toBe(true);
    });

    it('still forwards the caller’s abort to the in-flight provider request', async () => {
        const seen = hangingFetch();
        const controller = new AbortController();
        void backgroundAICall({
            systemPrompt: 'sys',
            userPrompt: 'user',
            route,
            timeoutMs: 60_000,
            signal: controller.signal,
        }).catch(() => {});

        await settled();
        expect(seen).toHaveLength(1);
        expect(seen[0].aborted).toBe(false);

        controller.abort();
        await settled();
        expect(seen[0].aborted).toBe(true);
    });
});
