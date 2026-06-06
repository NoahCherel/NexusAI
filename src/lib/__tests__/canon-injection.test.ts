import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '@/lib/ai/context-builder';
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

    it('layers the RP journal under a separate "IN THIS RP" block', () => {
        const prompt = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            canonDossiers: [dossier],
            rpJournal: { 'Rukia Kuchiki': ['Lost her powers to Ichigo'] },
        });
        expect(prompt).toContain('IN THIS RP — Rukia Kuchiki');
        expect(prompt).toContain('Lost her powers to Ichigo');
    });

    it('does not inject canon when no dossiers are active', () => {
        const prompt = buildSystemPrompt(card, worldState, [], { template: '{{scenario}}' });
        expect(prompt).not.toContain('CANON —');
    });

    it('injects the Director arc block only when the arc is enabled', () => {
        const disabled = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            arc: { enabled: false, nextBeat: 'the Soul Society arc' },
        });
        expect(disabled).not.toContain('NARRATIVE DIRECTOR');

        const enabled = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            arc: { enabled: true, work: 'Bleach', nextBeat: 'the Soul Society arc' },
            arcOutline: '1. Agent of the Shinigami\n2. Soul Society',
        });
        expect(enabled).toContain('NARRATIVE DIRECTOR');
        expect(enabled).toContain('the Soul Society arc');
        expect(enabled).toContain('Agent of the Shinigami');
    });

    it('injects the momentum nudge when present', () => {
        const prompt = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            momentumNudge: 'The scene is stalling — advance one step.',
        });
        expect(prompt).toContain('MOMENTUM');
        expect(prompt).toContain('advance one step');
    });
});
