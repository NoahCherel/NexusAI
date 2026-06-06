import { describe, it, expect } from 'vitest';
import {
    seedAxesFromNature,
    ensureRelationships,
    formatRelationshipBlock,
} from '@/lib/ai/relationship-context';
import { makeRelationship } from '@/lib/ai/relationship-engine';
import { USER_REL_KEY, type DirectedRelationship } from '@/types/chat';
import type { CanonDossier } from '@/types/canon';

function dossier(name: string, rels: { name: string; nature: string }[] = []): CanonDossier {
    return {
        work: 'naruto',
        character: name,
        timelineCap: 'S1E1',
        identity: `${name} is a shinobi.`,
        backstory: '',
        relationships: rels,
        fetchedAt: 0,
        stub: false,
        enabled: true,
    };
}

describe('seedAxesFromNature', () => {
    it('seeds a rival as high respect, low trust', () => {
        const a = seedAxesFromNature('bitter rival');
        expect(a.respect).toBeGreaterThan(40);
        expect(a.trust ?? 0).toBeLessThan(20);
    });

    it('seeds family as high trust + affection', () => {
        const a = seedAxesFromNature('younger sister, devoted');
        expect(a.trust).toBeGreaterThan(40);
        expect(a.affection).toBeGreaterThan(40);
    });

    it('seeds an enemy as negative trust and affection', () => {
        const a = seedAxesFromNature('sworn enemy');
        expect((a.trust ?? 0)).toBeLessThan(0);
        expect((a.affection ?? 0)).toBeLessThan(0);
    });
});

describe('ensureRelationships', () => {
    it('creates {{user}}↔char (both directions) as neutral strangers', () => {
        const { relationships, changed } = ensureRelationships(undefined, ['Naruto'], []);
        expect(changed).toBe(true);
        const userToNaruto = relationships.find((r) => r.from === USER_REL_KEY && r.to === 'Naruto');
        const narutoToUser = relationships.find((r) => r.from === 'Naruto' && r.to === USER_REL_KEY);
        expect(userToNaruto?.axes.trust).toBe(0); // the player earns everything
        expect(narutoToUser?.axes.trust).toBe(0);
    });

    it('seeds cast↔cast from the canon dossier relationships', () => {
        const dossiers = [
            dossier('Sasuke', [{ name: 'Naruto', nature: 'rival' }]),
            dossier('Naruto', [{ name: 'Sasuke', nature: 'best friend and rival' }]),
        ];
        const { relationships } = ensureRelationships(undefined, ['Sasuke', 'Naruto'], dossiers);
        const sasukeToNaruto = relationships.find((r) => r.from === 'Sasuke' && r.to === 'Naruto');
        expect(sasukeToNaruto?.seededFromCanon).toBe(true);
        expect(sasukeToNaruto?.axes.respect).toBeGreaterThan(40);
    });

    it('does not duplicate or overwrite existing relationships', () => {
        const existing: DirectedRelationship[] = [
            makeRelationship('Naruto', USER_REL_KEY, { trust: 50 }),
        ];
        const { relationships, changed } = ensureRelationships(existing, ['Naruto'], []);
        // Naruto→user kept as-is (trust 50), only the missing user→Naruto added.
        expect(relationships.find((r) => r.from === 'Naruto' && r.to === USER_REL_KEY)?.axes.trust).toBe(50);
        expect(changed).toBe(true);
        expect(relationships.filter((r) => r.from === 'Naruto' && r.to === USER_REL_KEY)).toHaveLength(1);
    });
});

describe('formatRelationshipBlock', () => {
    const userName = 'Kael';

    it('shows NPC→player even when neutral (enforces stranger treatment)', () => {
        const rels = [makeRelationship('Naruto', USER_REL_KEY)];
        const block = formatRelationshipBlock(rels, ['Naruto'], userName);
        expect(block).toContain('Naruto → Kael');
        expect(block).toContain('trust 0');
        expect(block).toContain('NOT mutual');
    });

    it('hides an unset player→NPC bond (AI must not author the player feelings)', () => {
        const rels = [makeRelationship(USER_REL_KEY, 'Naruto')];
        const block = formatRelationshipBlock(rels, ['Naruto'], userName);
        expect(block).toBe('');
    });

    it('shows a player→NPC bond once the user has set it', () => {
        const rels = [makeRelationship(USER_REL_KEY, 'Naruto', { affection: 30 })];
        const block = formatRelationshipBlock(rels, ['Naruto'], userName);
        expect(block).toContain('Kael → Naruto');
    });

    it('only includes relationships among active characters', () => {
        const rels = [
            makeRelationship('Naruto', USER_REL_KEY, { trust: 10 }),
            makeRelationship('Gaara', USER_REL_KEY, { trust: -10 }),
        ];
        const block = formatRelationshipBlock(rels, ['Naruto'], userName); // Gaara not on stage
        expect(block).toContain('Naruto → Kael');
        expect(block).not.toContain('Gaara');
    });

    it('surfaces the recent ledger reason for consistency', () => {
        const rel = makeRelationship('Naruto', USER_REL_KEY);
        rel.ledger.push({ ts: 1, axis: 'trust', delta: -10, reason: 'lied about the mission' });
        const block = formatRelationshipBlock([rel], ['Naruto'], userName);
        expect(block).toContain('lied about the mission');
    });
});
