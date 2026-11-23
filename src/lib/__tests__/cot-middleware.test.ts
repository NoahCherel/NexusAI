import { describe, expect, it } from 'vitest';
import { normalizeCoT, splitStreamedReply } from '@/lib/ai/cot-middleware';

describe('normalizeCoT', () => {
    it('extracts hidden llm thinking divs from visible content', () => {
        const result = normalizeCoT(`Before
<div class="llm thinking" style="display: none">
  FINAL SILENT CHECK
</div>
After`);

        expect(result.content).toBe('Before\n\nAfter');
        expect(result.thought).toBe('FINAL SILENT CHECK');
        expect(result.hasThoughts).toBe(true);
    });
});

describe('splitStreamedReply', () => {
    it('never shows thought text when <think> spans several chunks', () => {
        let raw = '';
        for (const chunk of ['<think>I should be', ' sneaky here', '</think>Hello there.']) {
            raw += chunk;
            expect(splitStreamedReply(raw, 'openrouter').visible).not.toContain('sneaky');
        }
        const done = splitStreamedReply(raw, 'openrouter');
        expect(done.visible).toBe('Hello there.');
        expect(done.thought).toContain('I should be sneaky here');
    });

    it('joins reasoning that the server streams as many small <think> blocks', () => {
        // /api/chat wraps every reasoning delta in its own <think>…</think>.
        const raw = '<think>I think</think><think> this is</think><think> fine</think>Answer';
        const result = splitStreamedReply(raw, 'openrouter');
        expect(result.thought).toBe('I think this is fine');
        expect(result.visible).toBe('Answer');
    });

    it('keeps no thought text when the stream stops inside <think>', () => {
        const stopped = splitStreamedReply('Intro. <think>half a thought', 'openrouter');
        expect(stopped.visible).toBe('Intro. ');
        expect(stopped.thought).toBe('half a thought');
    });

    it('extracts the usage sentinel even after an unclosed thought', () => {
        const raw = '<think>all thought\n<|nexus_usage|>{"promptTokens":10,"completionTokens":2}';
        const result = splitStreamedReply(raw, 'openrouter');
        expect(result.usage?.promptTokens).toBe(10);
        expect(result.thought).not.toContain('nexus_usage');
    });
});
