import { describe, it, expect } from 'vitest';
import {
    seedAxesFromNature,
    mainCharacterBond,
    formatRelationshipBlock,
} from '@/lib/ai/relationship-context';
import { makeRelationship } from '@/lib/ai/relationship-engine';
import { USER_REL_KEY } from '@/types/chat';

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

describe('mainCharacterBond', () => {
    it('is the ONLY automatic pair: player ↔ the card character, both ways, neutral', () => {
        const bond = mainCharacterBond('Naruto');
        expect(bond).toHaveLength(2);
        const userToNaruto = bond.find((r) => r.from === USER_REL_KEY && r.to === 'Naruto');
        const narutoToUser = bond.find((r) => r.from === 'Naruto' && r.to === USER_REL_KEY);
        expect(userToNaruto?.axes.trust).toBe(0); // the player earns everything
        expect(narutoToUser?.axes.trust).toBe(0);
        // Never flagged as canon: nothing was read from a dossier.
        expect(bond.every((r) => !r.seededFromCanon)).toBe(true);
    });

    it('seeds nothing for a blank or sentinel name', () => {
        expect(mainCharacterBond('   ')).toEqual([]);
        expect(mainCharacterBond(USER_REL_KEY)).toEqual([]);
    });

    it('costs no prompt line until the user edits it (only the NPC side shows)', () => {
        const block = formatRelationshipBlock(mainCharacterBond('Naruto'), ['Naruto'], 'Kael');
        expect(block).toContain('Naruto → Kael');
        expect(block).not.toContain('Kael → Naruto');
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
