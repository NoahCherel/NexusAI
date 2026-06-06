/**
 * Verifies the two global toggles for the Canon Codex:
 *
 *   useCanonCodex      — master switch. When false, `buildCanonOptions` returns nothing,
 *                        so nothing canon-related ever reaches the prompt.
 *   useCanonAutoFetch  — when false, all web-fetch entry points return early without
 *                        spending API calls. Manual data already in DB is unaffected.
 *
 * The tests below stub IndexedDB (db) and the settings store, then assert behavior at the
 * two boundaries: prompt assembly and web retrieval.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildCanonOptions } from '@/lib/ai/canon-context';
import { fetchCharacterDossier, fetchCastRoster, fetchArcOutline } from '@/lib/ai/canon-retrieval';
import { useSettingsStore } from '@/stores/settings-store';
import type { CharacterCard } from '@/types/character';

// Stub the db module so we don't need a real IndexedDB.
vi.mock('@/lib/db', () => ({
    getCanonDossiersByWork: vi.fn(async () => [] as never[]),
    getArcOutline: vi.fn(async () => undefined),
    getCanonDossier: vi.fn(async () => undefined),
    saveCanonDossier: vi.fn(async () => undefined),
    saveArcOutline: vi.fn(async () => undefined),
    canonKey: (w: string, c: string) => `${w.toLowerCase()}::${c.toLowerCase()}`,
}));

// Spy on the background AI call; if either toggle is off, no fetch should reach it.
vi.mock('@/lib/ai/background-ai', () => ({
    backgroundAICall: vi.fn(async () => ({ content: '{}', usedModel: 'noop' })),
}));

import { backgroundAICall } from '@/lib/ai/background-ai';

const card: CharacterCard = {
    id: 'c1',
    name: 'NarutoRPG',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    work: 'naruto',
};

beforeEach(() => {
    vi.clearAllMocks();
    // Reset settings to defaults before each test.
    useSettingsStore.setState({ useCanonCodex: true, useCanonAutoFetch: true });
});

describe('useCanonCodex (master switch)', () => {
    it('returns empty options when off — nothing canon reaches the prompt', async () => {
        useSettingsStore.setState({ useCanonCodex: false });
        const opts = await buildCanonOptions(card, undefined, []);
        expect(opts).toEqual({});
    });

    it('returns full options when on', async () => {
        useSettingsStore.setState({ useCanonCodex: true });
        const opts = await buildCanonOptions(card, undefined, []);
        // The shape proves the path ran; canonDossiers is [] because we stubbed the DB empty.
        expect(opts.canonDossiers).toEqual([]);
        expect(opts.injectionMeta).toBeDefined();
        expect(opts.injectionMeta?.scanDepth).toBe(10);
    });
});

describe('useCanonAutoFetch (web fetch switch)', () => {
    it('fetchCharacterDossier does NOT call the model when off', async () => {
        useSettingsStore.setState({ useCanonAutoFetch: false });
        const result = await fetchCharacterDossier('naruto', 'Naruto Uzumaki', 'S1E1');
        expect(result).toBeNull();
        expect(backgroundAICall).not.toHaveBeenCalled();
    });

    it('fetchCastRoster does NOT call the model when off', async () => {
        useSettingsStore.setState({ useCanonAutoFetch: false });
        const result = await fetchCastRoster('naruto');
        expect(result).toEqual([]);
        expect(backgroundAICall).not.toHaveBeenCalled();
    });

    it('fetchArcOutline does NOT call the model when off', async () => {
        useSettingsStore.setState({ useCanonAutoFetch: false });
        const result = await fetchArcOutline('naruto');
        expect(result).toBeNull();
        expect(backgroundAICall).not.toHaveBeenCalled();
    });

    it('the master switch also blocks fetches even if auto-fetch is on', async () => {
        useSettingsStore.setState({ useCanonCodex: false, useCanonAutoFetch: true });
        await fetchCastRoster('naruto');
        expect(backgroundAICall).not.toHaveBeenCalled();
    });
});
