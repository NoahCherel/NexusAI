import { describe, it, expect, vi } from 'vitest';

// canon-context transitively imports db + background-ai via canon-retrieval; stub them so the
// pure matching helpers can be imported without a real IndexedDB / network.
vi.mock('@/lib/db', () => ({
    getCanonDossiersByWork: vi.fn(async () => []),
    getArcOutline: vi.fn(async () => undefined),
    getCanonDossier: vi.fn(async () => undefined),
    saveCanonDossier: vi.fn(),
    saveArcOutline: vi.fn(),
    canonKey: (w: string, c: string) => `${w}::${c}`,
}));
vi.mock('@/lib/ai/background-ai', () => ({ backgroundAICall: vi.fn(async () => null) }));

import { nameMatchTokens, nameMatchesText } from '@/lib/ai/canon-context';

describe('nameMatchTokens', () => {
    it('keeps full name + distinctive first name', () => {
        expect(nameMatchTokens('Ino Yamanaka')).toEqual(['ino yamanaka', 'ino']);
    });
    it('drops the ambiguous bare "A" and uses parenthetical title instead', () => {
        const t = nameMatchTokens('A (Fourth Raikage)');
        expect(t).not.toContain('a');
        expect(t).toContain('raikage');
    });
    it('handles "Killer B" (single-letter trailing word dropped)', () => {
        expect(nameMatchTokens('Killer B')).toEqual(['killer b', 'killer']);
    });
});

describe('nameMatchesText — whole-word only', () => {
    const lc = (s: string) => s.toLowerCase();

    it('does NOT match "Ino" inside "shinobi"', () => {
        expect(nameMatchesText('Ino Yamanaka', lc('They trained as a shinobi all night.'))).toBe(false);
    });
    it('matches "Ino" as a standalone word', () => {
        expect(nameMatchesText('Ino Yamanaka', lc('Ino smiled at the gate.'))).toBe(true);
    });
    it('does NOT match the Raikage "A" against every stray "a"', () => {
        expect(nameMatchesText('A (Fourth Raikage)', lc('A man walked across a field.'))).toBe(false);
    });
    it('matches the Raikage via the "Raikage" alias', () => {
        expect(nameMatchesText('A (Fourth Raikage)', lc('The Raikage slammed his fist down.'))).toBe(
            true
        );
    });
    it('matches a normal single-word name with word boundaries', () => {
        expect(nameMatchesText('Naruto', lc('Then Naruto grinned.'))).toBe(true);
        expect(nameMatchesText('Naruto', lc('narutopedia is a wiki'))).toBe(false);
    });
    it('matches names next to punctuation', () => {
        expect(nameMatchesText('Sasuke', lc('"Sasuke!" she shouted.'))).toBe(true);
    });
});
