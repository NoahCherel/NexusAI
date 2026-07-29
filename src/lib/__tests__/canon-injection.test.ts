import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildDynamicContextBlock } from '@/lib/ai/context-builder';
import type { CharacterCard } from '@/types/character';
import type { WorldState } from '@/types/chat';
import type { CanonDossier } from '@/types/canon';

const card: CharacterCard = {
    id: 'c1',
    name: 'BleachRPG',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
};

const worldState: WorldState = { inventory: [], location: '', relationships: {} };

const dossier: CanonDossier = {
    work: 'Bleach',
    character: 'Rukia Kuchiki',
    timelineCap: 'S1E20',
    identity: 'Composed, formal Soul Reaper; speaks tersely.',
    backstory: 'Assigned to Karakura Town.',
    relationships: [{ name: 'Ichigo', nature: 'reluctant ally' }],
    abilities: 'Kido, Sode no Shirayuki',
    fetchedAt: 0,
};

describe('buildSystemPrompt canon injection', () => {
    it('injects an immutable canon block scoped to the timeline cap', () => {
        const prompt = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            canonDossiers: [dossier],
        });
        expect(prompt).toContain('CANON — Rukia Kuchiki');
        expect(prompt).toContain('S1E20');
        expect(prompt).toContain('Sode no Shirayuki');
    });

    it('layers the RP journal under a separate "IN THIS RP" block (dynamic zone)', () => {
        // The journal grows every beat, so it now lives in the dynamic context block
        // (after history), not in the cache-stable system prompt.
        const block = buildDynamicContextBlock({
            rpJournal: { 'Rukia Kuchiki': ['Lost her powers to Ichigo'] },
            activeCastNames: ['Rukia Kuchiki'],
        });
        expect(block).toContain('IN THIS RP — Rukia Kuchiki');
        expect(block).toContain('Lost her powers to Ichigo');
    });

    it('does not inject canon when no dossiers are active', () => {
        const prompt = buildSystemPrompt(card, worldState, [], { template: '{{scenario}}' });
        expect(prompt).not.toContain('CANON —');
    });

    it('injects the Director framing + arc map only when the arc is enabled (stable zone)', () => {
        const disabled = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            arc: { enabled: false, work: 'Bleach' },
            arcOutline: '1. Agent of the Shinigami\n2. Soul Society',
        });
        expect(disabled).not.toContain('NARRATIVE DIRECTOR');

        const enabled = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            arc: { enabled: true, work: 'Bleach', nextBeat: 'the Soul Society arc' },
            arcOutline: '1. Agent of the Shinigami\n2. Soul Society',
        });
        expect(enabled).toContain('NARRATIVE DIRECTOR');
        expect(enabled).toContain('Agent of the Shinigami');
    });

    it('renders the arc cursor (position/next beat) in the dynamic zone', () => {
        // The cursor moves with the story — it must not invalidate the cached system prompt.
        const block = buildDynamicContextBlock({
            arcPosition: 'S1E20',
            arcNextBeat: 'the Soul Society arc',
        });
        expect(block).toContain('[ARC]');
        expect(block).toContain('S1E20');
        expect(block).toContain('the Soul Society arc');
    });

    it('injects the momentum nudge when present (dynamic zone)', () => {
        const block = buildDynamicContextBlock({
            momentumNudge: 'The scene is stalling — advance one step.',
        });
        expect(block).toContain('MOMENTUM');
        expect(block).toContain('advance one step');
    });
});
