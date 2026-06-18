import { describe, expect, it } from 'vitest';
import { normalizeCoT } from '@/lib/ai/cot-middleware';

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
