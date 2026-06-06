/**
 * Tests the arc-name resolution layer used by `dueToAppear` — the part of the system that
 * decides "who should appear around this point in the timeline?". The user's GM emits
 * positions like "Naruto Shippuden, Season 1, Episode 1" rather than canonical arc names, so
 * the matcher has to be format-tolerant.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '@/lib/ai/context-builder';
import { resolveActiveArcNames } from '@/lib/ai/canon-context';
import type { CharacterCard } from '@/types/character';
import type { WorldState } from '@/types/chat';

const card: CharacterCard = {
    id: 'c1',
    name: 'NarutoRPG',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
};
const ws: WorldState = { inventory: [], location: '', relationships: {} };

const NARUTO_OUTLINE = `1. Kazekage Rescue Mission — Naruto returns to Konoha…
2. Tenchi Bridge Reconnaissance Mission — A new Team 7…
3. Akatsuki Suppression Mission — Naruto trains…
4. Itachi Pursuit Mission — Sasuke assembles Team Hebi…
5. Tale of Jiraiya the Gallant — Jiraiya infiltrates…
6. Fated Battle Between Brothers — Sasuke battles Itachi…`;

describe('resolveActiveArcNames — maps free-form positions to canonical arc names', () => {
    it('returns the first arc when the position is just an early episode (S1E1)', () => {
        const arcs = resolveActiveArcNames('Naruto Shippuden, Season 1, Episode 1', NARUTO_OUTLINE);
        expect(arcs).toEqual(['Kazekage Rescue Mission']);
    });

    it('handles short formats like "S1E5" and "Episode 7"', () => {
        expect(resolveActiveArcNames('S1E5', NARUTO_OUTLINE)).toEqual(['Kazekage Rescue Mission']);
        expect(resolveActiveArcNames('Episode 7', NARUTO_OUTLINE)).toEqual([
            'Kazekage Rescue Mission',
        ]);
    });

    it('uses an arc name verbatim when the position contains one', () => {
        expect(
            resolveActiveArcNames(
                'Itachi Pursuit Mission — episode 142',
                NARUTO_OUTLINE
            )
        ).toEqual(['Itachi Pursuit Mission']);
    });

    it('falls back gracefully when there is no outline and no arc name in the position', () => {
        expect(resolveActiveArcNames('somewhere unknown', undefined)).toEqual([]);
    });

    it('maps a higher episode number to a later arc via proportional bucketing', () => {
        const arcs = resolveActiveArcNames('Episode 80', NARUTO_OUTLINE);
        expect(arcs.length).toBe(1);
        // 80 ÷ 22 ≈ index 3 → "Itachi Pursuit Mission" (4th arc)
        expect(arcs[0]).toBe('Itachi Pursuit Mission');
    });
});

describe('Arc-block injection with free-form positions', () => {
    it('still injects the Director block with a free-form position like "Season 1, Episode 1"', () => {
        const prompt = buildSystemPrompt(card, ws, [], {
            template: '{{scenario}}',
            arc: {
                enabled: true,
                work: 'naruto',
                currentPosition: 'Naruto Shippuden, Season 1, Episode 1',
            },
            arcOutline: NARUTO_OUTLINE,
            dueToAppear: ['Gaara', 'Kankuro'], // these come from canon-context's resolver
        });
        expect(prompt).toContain('NARRATIVE DIRECTOR');
        expect(prompt).toContain('Naruto Shippuden, Season 1, Episode 1');
        expect(prompt).toContain('Kazekage Rescue Mission');
        expect(prompt).toContain('Gaara, Kankuro');
    });

    it('Director block is omitted when arc is disabled', () => {
        const prompt = buildSystemPrompt(card, ws, [], {
            template: '{{scenario}}',
            arc: { enabled: false, work: 'naruto' },
            arcOutline: NARUTO_OUTLINE,
            dueToAppear: ['Gaara'],
        });
        expect(prompt).not.toContain('NARRATIVE DIRECTOR');
    });
});
