/**
 * What actually leaves the browser for an invisible agent. The claim under test is narrow and
 * checkable: an agent sends the same messages and the same preset samplers as the visible
 * reply, and it reports what it cost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundAICall } from '@/lib/ai/background-ai';
import { callStructuredAgent, DirectedSceneError } from '@/lib/ai/directed-scene';
import type { AgentPayload, SamplerParams } from '@/lib/ai/conversation-context';
import { useSettingsStore } from '@/stores/settings-store';

// The key vault is not what this file is about; the request body is.
vi.mock('@/lib/crypto', () => ({
    decryptApiKey: vi.fn(async () => 'test-key'),
    encryptApiKey: vi.fn(async (k: string) => k),
    validateApiKey: vi.fn(() => ({ isValid: true })),
}));

const route = {
    provider: 'openrouter' as const,
    model: 'test/model',
    billingScope: 'free' as const,
    routing: 'openrouter-free' as const,
    resolvedAt: 0,
};

const sampler: SamplerParams = {
    temperature: 0.77,
    maxTokens: 512,
    topP: 0.91,
    topK: 42,
    frequencyPenalty: 0.3,
    presencePenalty: 0.2,
    repetitionPenalty: 1.1,
    minP: 0.05,
    stoppingStrings: ['###'],
    enableReasoning: true,
    useFlexTier: false,
};

const payload: AgentPayload = {
    messages: [
        { role: 'system', content: 'SHARED SYSTEM' },
        { role: 'user', content: 'We reach the gate.' },
        { role: 'system', content: '[BEAT DIRECTOR]' },
    ],
    stablePrefixLength: 2,
    windowStartMessageId: 'm1',
    includedMessageCount: 1,
    tokenBreakdown: {
        system: 10,
        rag: 0,
        history: 20,
        postHistory: 5,
        total: 35,
        dynamicReserve: 5,
        historyBudget: 100,
        historyTarget: 90,
        historyHeadroom: 80,
    },
    historyWindow: { action: 'unchanged', reason: 'stable', recoverableMessageCount: 0 },
};

/** A streamed body, optionally closed by the usage sentinel the route appends. */
function streamed(text: string): Response {
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => {
                let done = false;
                return {
                    read: async () => {
                        if (done) return { done: true, value: undefined };
                        done = true;
                        return { done: false, value: new TextEncoder().encode(text) };
                    },
                };
            },
        },
    } as unknown as Response;
}

let bodies: Record<string, unknown>[] = [];

beforeEach(() => {
    bodies = [];
    useSettingsStore.setState({
        apiKeys: [{ provider: 'openrouter', encryptedKey: 'plain:key', label: 'test' }],
    } as never);
    vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)));
            return streamed(
                '{"sceneGoal":"ok"}\n<|nexus_usage|>{"promptTokens":1234,"completionTokens":56}'
            );
        })
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('an invisible agent request', () => {
    it('sends the shared messages and every preset sampler, not a synthetic prompt', async () => {
        const usages: unknown[] = [];
        const result = await callStructuredAgent({
            context: { buildPayload: async () => payload, sampler, route },
            contract: '[BEAT DIRECTOR]',
            parse: (raw) => JSON.parse(raw) as { sceneGoal: string },
            stage: 'director',
            failureMessage: 'no answer',
            onUsage: (usage) => usages.push(usage),
        });

        expect(result.sceneGoal).toBe('ok');
        expect(bodies).toHaveLength(1);
        const body = bodies[0];
        // The whole conversation, system message included — not one synthetic user turn.
        expect(body.messages).toEqual(payload.messages);
        expect(body.systemPrompt).toBeUndefined();
        // The preset governs the agent exactly as it governs the visible reply.
        expect(body).toMatchObject({
            temperature: 0.77,
            maxTokens: 512,
            topP: 0.91,
            topK: 42,
            frequencyPenalty: 0.3,
            presencePenalty: 0.2,
            repetitionPenalty: 1.1,
            minP: 0.05,
            stoppingStrings: ['###'],
            enableReasoning: true,
            model: 'test/model',
        });
        // Cache boundary so the shared prefix is reusable across the beat's agents.
        expect(body.cachePrefixLength).toBe(2);
        // Reasoning is never silently switched off, as it is for extraction agents.
        expect(body.disableReasoning).toBeUndefined();
        // Real provider numbers, not an estimate.
        expect(usages).toEqual([{ promptTokens: 1234, completionTokens: 56, estimated: false }]);
    });

    it('retries a malformed answer exactly once, with the correction appended', async () => {
        const contracts: string[] = [];
        let call = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: string, init: RequestInit) => {
                const body = JSON.parse(String(init.body)) as {
                    messages: { content: string }[];
                };
                contracts.push(body.messages.at(-1)!.content);
                call++;
                return streamed(call === 1 ? 'sorry, here you go: {}' : '{"sceneGoal":"fixed"}');
            })
        );

        const result = await callStructuredAgent({
            context: {
                buildPayload: async (contract) => ({
                    ...payload,
                    messages: [
                        ...payload.messages.slice(0, -1),
                        { role: 'system', content: contract },
                    ],
                }),
                sampler,
                route,
            },
            contract: '[BEAT DIRECTOR]',
            parse: (raw) => {
                if (!raw.trim().startsWith('{')) {
                    throw new DirectedSceneError('texte hors JSON', 'validation');
                }
                return JSON.parse(raw) as { sceneGoal: string };
            },
            stage: 'director',
            failureMessage: 'no answer',
        });

        expect(result.sceneGoal).toBe('fixed');
        expect(contracts).toHaveLength(2);
        expect(contracts[1]).toContain('[CORRECTION]');
        expect(contracts[1]).toContain('texte hors JSON');
    });

    it('estimates usage when the provider reports none', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => streamed('{"sceneGoal":"ok"}'))
        );
        const usages: { estimated?: boolean; promptTokens?: number }[] = [];
        await callStructuredAgent({
            context: { buildPayload: async () => payload, sampler, route },
            contract: '[BEAT DIRECTOR]',
            parse: (raw) => JSON.parse(raw) as unknown,
            stage: 'director',
            failureMessage: 'no answer',
            onUsage: (usage) => usages.push(usage),
        });
        expect(usages[0].estimated).toBe(true);
        expect(usages[0].promptTokens).toBe(payload.tokenBreakdown.total);
    });

    it('turns a context-length rejection into a non-retryable route error that names the model', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    ({
                        ok: false,
                        status: 400,
                        json: async () => ({
                            error: "This model's maximum context length is 8192 tokens.",
                            upstreamStatus: 400,
                        }),
                    }) as unknown as Response
            )
        );
        await expect(
            callStructuredAgent({
                context: { buildPayload: async () => payload, sampler, route },
                contract: '[BEAT DIRECTOR]',
                parse: (raw) => JSON.parse(raw) as unknown,
                stage: 'director',
                failureMessage: 'no answer',
            })
        ).rejects.toMatchObject({
            name: 'DirectedSceneError',
            stage: 'route',
            retryable: false,
            message: expect.stringContaining('test/model'),
        });
    });

    it('keeps the legacy single-prompt shape for the small extraction agents', async () => {
        await backgroundAICall({
            systemPrompt: 'You extract facts.',
            userPrompt: 'BEAT TEXT',
            route,
            temperature: 0.2,
            maxTokens: 300,
        });
        const body = bodies[0];
        expect(body.systemPrompt).toBe('You extract facts.');
        expect(body.messages).toEqual([{ role: 'user', content: 'BEAT TEXT' }]);
        expect(body.temperature).toBe(0.2);
        expect(body.topP).toBeUndefined();
    });

    it('forwards the preset flex tier like the visible reply does', async () => {
        await callStructuredAgent({
            context: {
                buildPayload: async () => payload,
                sampler: { ...sampler, useFlexTier: true },
                route,
            },
            contract: '[BEAT DIRECTOR]',
            parse: (raw) => JSON.parse(raw) as unknown,
            stage: 'director',
            failureMessage: 'no answer',
        });
        expect(bodies[0].useFlexTier).toBe(true);
    });
});
