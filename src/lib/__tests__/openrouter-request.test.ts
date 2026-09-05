/**
 * One body builder for the live stream and the Batch API. The claim under test: the two
 * transports differ ONLY in their transport fields; every sampler knob, the reasoning
 * config and the Claude cache breakpoints are byte-identical.
 */
import { describe, expect, it } from 'vitest';
import {
    buildOpenRouterChatBody,
    buildSystemMessage,
    withSystemMessage,
    type OpenRouterChatParams,
} from '@/lib/ai/openrouter-request';

const base: Omit<OpenRouterChatParams, 'mode'> = {
    messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
    ],
    model: 'openai/gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 1024,
    topP: 0.9,
    topK: 40,
    frequencyPenalty: 0.1,
    presencePenalty: 0.2,
    repetitionPenalty: 1.05,
    minP: 0.03,
    stoppingStrings: ['###'],
    enableReasoning: true,
    cachePrefixLength: 2,
};

describe('buildOpenRouterChatBody', () => {
    it('sends the stream transport fields on the live route only', () => {
        const stream = buildOpenRouterChatBody({ ...base, mode: 'stream' });
        const batch = buildOpenRouterChatBody({ ...base, mode: 'batch' });

        expect(stream.stream_options).toEqual({ include_usage: true });
        expect(stream.usage).toEqual({ include: true });

        expect(batch).not.toHaveProperty('stream');
        expect(batch).not.toHaveProperty('stream_options');
        expect(batch).not.toHaveProperty('usage');
    });

    it('keeps every sampler knob and the reasoning config identical across transports', () => {
        const stream = buildOpenRouterChatBody({ ...base, mode: 'stream' });
        const batch = buildOpenRouterChatBody({ ...base, mode: 'batch' });
        const { stream_options: _s, usage: _u, ...streamRest } = stream;
        void _s;
        void _u;
        expect(batch).toEqual(streamRest);
        expect(batch).toMatchObject({
            model: 'openai/gpt-4o-mini',
            temperature: 0.7,
            max_tokens: 1024,
            top_p: 0.9,
            top_k: 40,
            min_p: 0.03,
            repetition_penalty: 1.05,
            frequency_penalty: 0.1,
            presence_penalty: 0.2,
            stop: ['###'],
            reasoning: { effort: 'medium' },
        });
    });

    it('sends the flex service tier on the live request only, and only when asked', () => {
        expect(buildOpenRouterChatBody({ ...base, mode: 'stream' })).not.toHaveProperty(
            'service_tier'
        );
        expect(
            buildOpenRouterChatBody({ ...base, useFlexTier: true, mode: 'stream' }).service_tier
        ).toBe('flex');
        // A batch is already discounted; the tier would be meaningless there.
        expect(
            buildOpenRouterChatBody({ ...base, useFlexTier: true, mode: 'batch' })
        ).not.toHaveProperty('service_tier');
    });

    it('picks the reasoning shape by model family', () => {
        const gemini = buildOpenRouterChatBody({
            ...base,
            model: 'google/gemini-2.5-flash',
            mode: 'batch',
        });
        expect(gemini.reasoning).toEqual({ enabled: true, max_tokens: 512 });
        const deepseek = buildOpenRouterChatBody({
            ...base,
            model: 'deepseek/deepseek-r1',
            mode: 'batch',
        });
        expect(deepseek.reasoning).toEqual({ effort: 'high' });
        const off = buildOpenRouterChatBody({ ...base, disableReasoning: true, mode: 'batch' });
        expect(off.reasoning).toEqual({ enabled: false });
    });

    it('marks Claude cache breakpoints the same way in both modes, without mutating the input', () => {
        const params = { ...base, model: 'anthropic/claude-sonnet-4' };
        const stream = buildOpenRouterChatBody({ ...params, mode: 'stream' });
        const batch = buildOpenRouterChatBody({ ...params, mode: 'batch' });
        const marked = (body: Record<string, unknown>) =>
            (body.messages as { content: unknown }[]).map((m) => m.content);
        expect(marked(stream)).toEqual(marked(batch));
        expect(marked(batch)[0]).toEqual([
            { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } },
        ]);
        expect(marked(batch)[1]).toEqual([
            { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
        ]);
        expect(marked(batch)[2]).toBe('Hi');
        // The caller's messages are untouched.
        expect(base.messages[0].content).toBe('SYSTEM');
    });

    it('adds the web plugin only when asked', () => {
        const plain = buildOpenRouterChatBody({ ...base, mode: 'batch' });
        expect(plain).not.toHaveProperty('plugins');
        const web = buildOpenRouterChatBody({
            ...base,
            webSearch: true,
            webMaxResults: 3,
            mode: 'stream',
        });
        expect(web.plugins).toEqual([{ id: 'web', max_results: 3 }]);
    });
});

describe('system message assembly', () => {
    it('prepends the persona block exactly like the route did', () => {
        const system = buildSystemMessage('You are X.', { name: 'Noah', bio: 'A player.' });
        expect(system.startsWith('You are X.\n\n[USER INFO]\nName: Noah\nBio: A player.')).toBe(
            true
        );
        const messages = withSystemMessage([{ role: 'user', content: 'hi' }], 'SYS');
        expect(messages[0]).toEqual({ role: 'system', content: 'SYS' });
        expect(withSystemMessage([{ role: 'user', content: 'hi' }])).toHaveLength(1);
    });
});
