/**
 * Exporting a conversation used to drop its Chronicle. That was harmless while facts and
 * vector chunks could rebuild themselves; now the Chronicle IS the long-term memory, it can be
 * edited by hand, and regenerating it costs dozens of background calls.
 */

import { describe, it, expect, vi } from 'vitest';
import type { MemorySummary } from '@/types/rag';

vi.mock('@/stores', () => ({ useChatStore: {}, useCharacterStore: {} }));
vi.mock('@/lib/db', () => ({ getSummariesByConversation: vi.fn(), saveSummary: vi.fn() }));
vi.mock('@/components/ui/api-notification', () => ({ useNotificationStore: {} }));

import { remapSummariesForImport } from '@/lib/conversation-transfer';

function summary(
    id: string,
    level: 0 | 1 | 2,
    range: [number, number],
    childIds: string[] = [],
    extra: Partial<MemorySummary> = {}
): MemorySummary {
    return {
        id,
        conversationId: 'old-conv',
        level,
        messageRange: range,
        content: `content of ${id}`,
        keyFacts: [`fact of ${id}`],
        childIds,
        createdAt: 1,
        branchPath: ['old-m1', 'old-m2'],
        ...extra,
    };
}

/** Arc → 3 Sections → 6 Fragments. */
function pyramid(): MemorySummary[] {
    const frags = Array.from({ length: 6 }, (_, i) =>
        summary(`f${i}`, 0, [i * 10, (i + 1) * 10])
    );
    const sections = [
        summary('s0', 1, [0, 20], ['f0', 'f1']),
        summary('s1', 1, [20, 40], ['f2', 'f3']),
        summary('s2', 1, [40, 60], ['f4', 'f5'], { isManuallyEdited: true, editedAt: 999 }),
    ];
    const arc = summary('a0', 2, [0, 60], ['s0', 's1', 's2']);
    return [...frags, ...sections, arc];
}

describe('remapSummariesForImport', () => {
    const NEW_CONV = 'new-conv';
    const NEW_MESSAGES = ['n1', 'n2', 'n3'];

    it('re-keys every summary onto the new conversation', () => {
        const out = remapSummariesForImport(pyramid(), NEW_CONV, NEW_MESSAGES);

        expect(out).toHaveLength(10);
        for (const s of out) {
            expect(s.conversationId).toBe(NEW_CONV);
            expect(s.branchPath).toEqual(NEW_MESSAGES);
        }
        // Fresh ids, none reused from the export.
        const oldIds = new Set(pyramid().map((s) => s.id));
        for (const s of out) expect(oldIds.has(s.id)).toBe(false);
    });

    it('remaps childIds so the nesting survives — no dangling references', () => {
        const out = remapSummariesForImport(pyramid(), NEW_CONV, NEW_MESSAGES);
        const byId = new Map(out.map((s) => [s.id, s]));

        const arc = out.find((s) => s.level === 2)!;
        expect(arc.childIds).toHaveLength(3);
        for (const childId of arc.childIds) {
            const child = byId.get(childId);
            expect(child).toBeDefined();
            expect(child!.level).toBe(1);
        }

        // And one level down: each Section still points at its two Fragments.
        for (const childId of arc.childIds) {
            const section = byId.get(childId)!;
            expect(section.childIds).toHaveLength(2);
            for (const grandChildId of section.childIds) {
                expect(byId.get(grandChildId)?.level).toBe(0);
            }
        }
    });

    it('preserves ranges, content and the hand-edited flag', () => {
        const out = remapSummariesForImport(pyramid(), NEW_CONV, NEW_MESSAGES);

        const arc = out.find((s) => s.level === 2)!;
        expect(arc.messageRange).toEqual([0, 60]);
        expect(arc.content).toBe('content of a0');
        expect(arc.keyFacts).toEqual(['fact of a0']);

        const edited = out.filter((s) => s.isManuallyEdited);
        expect(edited).toHaveLength(1);
        expect(edited[0].editedAt).toBe(999);
    });

    it('drops references to children that were not exported, rather than dangling', () => {
        const orphanParent = summary('s9', 1, [0, 20], ['missing-1', 'f0']);
        const out = remapSummariesForImport([summary('f0', 0, [0, 10]), orphanParent], NEW_CONV, []);

        const section = out.find((s) => s.level === 1)!;
        expect(section.childIds).toHaveLength(1);
        expect(out.find((s) => s.id === section.childIds[0])?.level).toBe(0);
    });

    it('handles an empty Chronicle without throwing', () => {
        expect(remapSummariesForImport([], NEW_CONV, NEW_MESSAGES)).toEqual([]);
    });
});
