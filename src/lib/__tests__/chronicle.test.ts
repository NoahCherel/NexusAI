import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemorySummary } from '@/types/rag';
import { countTokens } from '@/lib/tokenizer';

vi.mock('@/lib/db', () => ({
    getSummariesByConversation: vi.fn(),
    saveSummary: vi.fn(),
}));

import { getSummariesByConversation } from '@/lib/db';
import { buildChronicle } from '@/lib/ai/hierarchical-summarizer';

const mockedGet = vi.mocked(getSummariesByConversation);

let seq = 0;
function summary(
    level: 0 | 1 | 2,
    range: [number, number],
    content: string,
    extra: Partial<MemorySummary> = {}
): MemorySummary {
    return {
        id: extra.id ?? `s${level}-${range[0]}-${++seq}`,
        conversationId: 'conv-1',
        level,
        messageRange: range,
        content,
        keyFacts: [],
        childIds: [],
        createdAt: seq,
        ...extra,
    };
}

/** Text of a believable size for the level (Arcs ~250-350 words, Sections ~150-250). */
const prose = (label: string, words: number) => `${label}. ` + `récit détaillé de la scène `.repeat(words / 5);

/** Arc 1 over messages 1-150, with its three Sections and fifteen Fragments underneath. */
function fullPyramid(): MemorySummary[] {
    const arc = summary(2, [0, 150], prose('ARC-TEXT', 300), { id: 'arc-1' });
    const sections = [
        summary(1, [0, 50], prose('SECTION-A', 200), { id: 'sec-a' }),
        summary(1, [50, 100], prose('SECTION-B', 200), { id: 'sec-b' }),
        summary(1, [100, 150], prose('SECTION-C', 200), { id: 'sec-c' }),
    ];
    const fragments = Array.from({ length: 15 }, (_, i) =>
        summary(0, [i * 10, (i + 1) * 10], prose(`FRAG-${i}`, 60))
    );
    return [arc, ...sections, ...fragments];
}

describe('buildChronicle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seq = 0;
    });

    it('returns nothing while the verbatim window still holds everything', async () => {
        mockedGet.mockResolvedValue(fullPyramid());
        const r = await buildChronicle('conv-1', 5000, 0, undefined);
        expect(r.text).toBe('');
        expect(r.stats.arcs).toBe(0);
    });

    it('renders the pyramid AS a pyramid: preamble, nesting, 1-based inclusive ranges', async () => {
        mockedGet.mockResolvedValue(fullPyramid());
        const r = await buildChronicle('conv-1', 20_000, 200, undefined);

        // The preamble is what tells the model the levels are the same events at two zooms.
        expect(r.text).toContain('[CHRONICLE');
        expect(r.text).toContain('OVERLAP');
        expect(r.text).toContain('NEVER treat an Arc and');

        // Stored range [0,150] is 0-based, end-exclusive → "messages 1-150" for the model.
        expect(r.text).toContain('■ ARC 1 — messages 1-150');
        expect(r.text).toContain('▸ Section 1 — messages 1-50');
        expect(r.text).toContain('▸ Section 2 — messages 51-100');
        expect(r.text).toContain('▸ Section 3 — messages 101-150');

        // Sections are nested under their Arc, i.e. they come after it in the text.
        expect(r.text.indexOf('■ ARC 1')).toBeLessThan(r.text.indexOf('▸ Section 1'));
        expect(r.stats.arcs).toBe(1);
        expect(r.stats.sections).toBe(3);
    });

    it('never re-injects Fragments already covered by a Section', async () => {
        // The old two-hop childIds lookup reported "uncovered" whenever the intermediate
        // Section was filtered out, and emitted the Arc PLUS its own Fragments.
        mockedGet.mockResolvedValue(fullPyramid());
        const r = await buildChronicle('conv-1', 20_000, 200, undefined);

        expect(r.stats.fragments).toBe(0);
        expect(r.text).not.toContain('FRAG-0');
        expect(r.text).not.toContain('Recent fragments');
    });

    it('bridges the gap between the last Section and the verbatim window', async () => {
        // Sections stop at 150; messages 150-180 are only covered by Fragments.
        const pyramid = fullPyramid();
        const trailing = [
            summary(0, [150, 160], prose('BRIDGE-A', 60)),
            summary(0, [160, 170], prose('BRIDGE-B', 60)),
        ];
        mockedGet.mockResolvedValue([...pyramid, ...trailing]);

        const r = await buildChronicle('conv-1', 20_000, 175, undefined);

        expect(r.stats.fragments).toBe(2);
        expect(r.text).toContain('▸ Recent fragments — messages 151-170');
        expect(r.text).toContain('BRIDGE-A');
        expect(r.text).toContain('BRIDGE-B');
    });

    it('drops the OLDEST Sections first and says so, rather than leaving a hole', async () => {
        mockedGet.mockResolvedValue(fullPyramid());
        // Enough for the Arc and roughly one Section.
        const r = await buildChronicle('conv-1', 900, 200, undefined);

        expect(r.stats.omittedSections).toBeGreaterThan(0);
        expect(r.text).toContain('(this period is covered by the Arc above)');
        // The Arc survives — it is the spine.
        expect(r.text).toContain('■ ARC 1');
        // The most recent Section is the one kept.
        if (r.stats.sections > 0) expect(r.text).toContain('SECTION-C');
    });

    it('marks a Section that still overlaps the live window', async () => {
        mockedGet.mockResolvedValue(fullPyramid());
        // Cut at 120: Section 3 ([100,150]) straddles the boundary.
        const r = await buildChronicle('conv-1', 20_000, 120, undefined);
        expect(r.text).toContain('also appears in full above');
    });

    it('never exceeds its budget, at any budget', async () => {
        mockedGet.mockResolvedValue(fullPyramid());
        for (const budget of [80, 200, 500, 900, 1500, 3000, 8000]) {
            const r = await buildChronicle('conv-1', budget, 200, undefined);
            expect(countTokens(r.text)).toBeLessThanOrEqual(budget);
        }
    });

    it('reports messages evicted without ever being summarized', async () => {
        // Fragments only reach message 150, but 190 messages have left the window.
        mockedGet.mockResolvedValue(fullPyramid());
        const r = await buildChronicle('conv-1', 20_000, 190, undefined);
        expect(r.stats.uncoveredEvictedMessages).toBe(40);
    });

    it('reports no gap when the summaries have kept up', async () => {
        mockedGet.mockResolvedValue(fullPyramid());
        const r = await buildChronicle('conv-1', 20_000, 120, undefined);
        expect(r.stats.uncoveredEvictedMessages).toBe(0);
    });

    it('drops summaries from abandoned branches, keeping legacy ones', async () => {
        const mine = summary(1, [0, 50], prose('MINE', 100), { branchPath: ['m1', 'm2'] });
        const other = summary(1, [50, 100], prose('OTHER', 100), { branchPath: ['x9'] });
        const legacy = summary(1, [100, 150], prose('LEGACY', 100));
        mockedGet.mockResolvedValue([mine, other, legacy]);

        const r = await buildChronicle('conv-1', 20_000, 200, ['m1', 'm2', 'm3']);

        expect(r.text).toContain('MINE');
        expect(r.text).not.toContain('OTHER');
        expect(r.text).toContain('LEGACY');
    });

    it('lists the Arcs it had to omit instead of renumbering silently', async () => {
        const arcs = [
            summary(2, [0, 150], prose('ARC-ONE', 300), { id: 'a1' }),
            summary(2, [150, 300], prose('ARC-TWO', 300), { id: 'a2' }),
            summary(2, [300, 450], prose('ARC-THREE', 300), { id: 'a3' }),
        ];
        mockedGet.mockResolvedValue(arcs);

        const r = await buildChronicle('conv-1', 500, 500, undefined);

        expect(r.stats.omittedArcs).toBeGreaterThan(0);
        expect(r.text).toContain('omitted for space');
    });
});
