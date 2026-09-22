import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import {
    buildChronicleReplacement,
    planChronicleRebuild,
    type SummarizerCall,
} from '@/lib/ai/chronicle-rebuild';

const messages = (count: number): Message[] =>
    Array.from({ length: count }, (_, i) => ({
        id: `m${i}`,
        conversationId: 'conv-1',
        parentId: i === 0 ? null : `m${i - 1}`,
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `Message ${i} — la troupe avança prudemment vers la salle scellée du sanctuaire.`,
        isActiveBranch: true,
        createdAt: new Date(i * 1000),
        messageOrder: i + 1,
        regenerationIndex: 0,
    }));

const answering = (summary: string): SummarizerCall =>
    vi.fn(async () => JSON.stringify({ summary, keyFacts: ['fait'] }));

describe('planChronicleRebuild', () => {
    it('refuses a conversation too short to produce a single fragment', () => {
        const plan = planChronicleRebuild(messages(4));
        expect(plan.canRun).toBe(false);
        // The refusal must be knowable BEFORE anything is deleted — this is the whole point.
        if (!plan.canRun) expect(plan.reason).toContain('Pas assez de messages');
    });

    it('refuses an empty conversation', () => {
        expect(planChronicleRebuild([]).canRun).toBe(false);
    });

    it('accepts a conversation long enough and reports the chunking it will use', () => {
        const plan = planChronicleRebuild(messages(60));
        expect(plan.canRun).toBe(true);
        if (plan.canRun) {
            expect(plan.chunkSize).toBeGreaterThan(0);
            expect(plan.totalChunks).toBe(Math.floor(60 / plan.chunkSize));
        }
    });
});

describe('buildChronicleReplacement', () => {
    const base = {
        conversationId: 'conv-1',
        characterName: 'Yuki',
        userName: 'Noah',
    };

    it('rolls fragments up into sections and arcs entirely in memory', async () => {
        const msgs = messages(30);
        const result = await buildChronicleReplacement({
            ...base,
            messages: msgs,
            plan: { chunkSize: 2, totalChunks: 15 },
            call: answering('résumé'),
        });

        const byLevel = (level: number) => result.summaries.filter((s) => s.level === level);
        expect(byLevel(0)).toHaveLength(15);
        expect(byLevel(1)).toHaveLength(3); // 5 fragments per section
        expect(byLevel(2)).toHaveLength(1); // 3 sections per arc
        expect(result.failedChunks).toBe(0);

        // Sections must point at the fragments actually built here, not at stored ids.
        const l0Ids = new Set(byLevel(0).map((s) => s.id));
        for (const section of byLevel(1)) {
            expect(section.childIds).toHaveLength(5);
            expect(section.childIds.every((id) => l0Ids.has(id))).toBe(true);
        }
        // Every summary carries the branch it was built from.
        expect(result.summaries.every((s) => s.branchPath?.length === msgs.length)).toBe(true);
    });

    it('reports the chunks the provider could not summarize instead of failing the rebuild', async () => {
        let call = 0;
        const result = await buildChronicleReplacement({
            ...base,
            messages: messages(8),
            plan: { chunkSize: 2, totalChunks: 4 },
            call: async () =>
                ++call === 2 ? null : JSON.stringify({ summary: 'ok', keyFacts: [] }),
        });

        expect(result.summaries.filter((s) => s.level === 0)).toHaveLength(3);
        expect(result.failedChunks).toBe(1);
    });

    it('returns nothing when every provider call fails, so the caller can keep the old Chronicle', async () => {
        const result = await buildChronicleReplacement({
            ...base,
            messages: messages(8),
            plan: { chunkSize: 2, totalChunks: 4 },
            call: async () => null,
        });

        expect(result.summaries).toEqual([]);
        expect(result.failedChunks).toBe(4);
    });

    it('stops on abort without leaving a half-built replacement behind', async () => {
        const controller = new AbortController();
        let call = 0;
        const build = buildChronicleReplacement({
            ...base,
            messages: messages(20),
            plan: { chunkSize: 2, totalChunks: 10 },
            signal: controller.signal,
            call: async () => {
                if (++call === 3) controller.abort();
                return JSON.stringify({ summary: 'ok', keyFacts: [] });
            },
        });

        await expect(build).rejects.toMatchObject({ name: 'AbortError' });
    });
});
