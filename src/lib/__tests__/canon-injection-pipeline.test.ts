/**
 * End-to-end-style tests for the casting → prompt injection pipeline.
 *
 * These tests demonstrate the contract that determines whether a casting entry actually
 * influences a message:
 *
 *   1. A character's name must appear in the last 10 messages.   → getActiveCanonNames
 *   2. Their dossier must be a FULL one (not a stub) AND enabled. → isInjectable filter
 *   3. Then buildSystemPrompt renders the [CANON — X] block.      → context-builder
 *
 * Failure at any step = no injection.
 */

import { describe, it, expect } from 'vitest';
import { getActiveCanonNames } from '@/lib/ai/canon-context';
import { buildSystemPrompt } from '@/lib/ai/context-builder';
import type { CharacterCard } from '@/types/character';
import type { Message, Conversation, WorldState } from '@/types/chat';
import type { CanonDossier } from '@/types/canon';

const card: CharacterCard = {
    id: 'c1',
    name: 'NarutoRPG',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    work: 'naruto',
    canonCast: ['Naruto Uzumaki', 'Sasuke Uchiha', 'Sakura Haruno'],
};

const worldState: WorldState = { inventory: [], location: '', relationships: {} };

function msg(content: string): Message {
    return {
        id: crypto.randomUUID(),
        conversationId: 'conv1',
        parentId: null,
        role: 'user',
        content,
        isActiveBranch: true,
        createdAt: new Date(),
        messageOrder: 0,
        regenerationIndex: 0,
    };
}

function fullDossier(name: string, overrides: Partial<CanonDossier> = {}): CanonDossier {
    return {
        work: 'naruto',
        character: name,
        timelineCap: 'S1E5',
        identity: `${name} is a young shinobi of Konoha.`,
        backstory: 'Trained by Kakashi.',
        relationships: [],
        appearsInArcs: ['Kazekage Rescue Mission'],
        fetchedAt: 0,
        stub: false,
        enabled: true,
        ...overrides,
    };
}

describe('STEP 1 — getActiveCanonNames detects casting names in recent messages', () => {
    it('matches the full canonical name', () => {
        const found = getActiveCanonNames(
            card,
            undefined,
            [msg("I'll go find Naruto Uzumaki at Ichiraku.")],
            10
        );
        expect(found).toContain('Naruto Uzumaki');
    });

    it('matches the first name alone (most chat references)', () => {
        const found = getActiveCanonNames(
            card,
            undefined,
            [msg('Sasuke smirked and walked off.')],
            10
        );
        expect(found).toContain('Sasuke Uchiha');
    });

    it('returns no one if no cast member is mentioned', () => {
        const found = getActiveCanonNames(
            card,
            undefined,
            [msg('A merchant haggles in the marketplace.')],
            10
        );
        expect(found).toEqual([]);
    });

    it('only scans the last N messages (depth)', () => {
        const history: Message[] = [];
        history.push(msg('Naruto was here long ago.'));
        for (let i = 0; i < 12; i++) history.push(msg('Just a filler message.'));
        const found = getActiveCanonNames(card, undefined, history, 10);
        expect(found).not.toContain('Naruto Uzumaki');
    });
});

describe('STEP 2 — buildSystemPrompt only renders FULL ENABLED dossiers', () => {
    it('injects a full enabled dossier when active', () => {
        const prompt = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            canonDossiers: [fullDossier('Naruto Uzumaki')],
        });
        expect(prompt).toContain('[CANON — Naruto Uzumaki');
        expect(prompt).toContain('young shinobi');
        // Anti-contradiction guardrail wording
        expect(prompt).toContain('Never contradict this personality');
    });

    it('also layers the in-this-RP journal under canon, without overwriting it', () => {
        const prompt = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            canonDossiers: [fullDossier('Naruto Uzumaki')],
            rpJournal: { 'Naruto Uzumaki': ['Lost his headband in the river.'] },
        });
        // Canon block comes first
        expect(prompt.indexOf('[CANON — Naruto Uzumaki')).toBeLessThan(
            prompt.indexOf('[IN THIS RP — Naruto Uzumaki')
        );
        expect(prompt).toContain('Lost his headband in the river');
    });

    it('renders nothing when the dossier list is empty (no active casting)', () => {
        const prompt = buildSystemPrompt(card, worldState, [], { template: '{{scenario}}' });
        expect(prompt).not.toContain('[CANON —');
        expect(prompt).not.toContain('[IN THIS RP —');
    });
});

describe('STEP 3 — Arc + due-to-appear hint reaches the prompt', () => {
    const conv: Pick<Conversation, 'arc'> = {
        arc: { enabled: true, work: 'naruto', currentPosition: 'Kazekage Rescue Mission' },
    };
    it('injects the Director block with the arc map + due-to-appear list', () => {
        const prompt = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            arc: conv.arc,
            arcOutline: '1. Kazekage Rescue Mission\n2. Tenchi Bridge',
            dueToAppear: ['Gaara', 'Kankuro'],
        });
        expect(prompt).toContain('NARRATIVE DIRECTOR');
        expect(prompt).toContain('Kazekage Rescue Mission');
        expect(prompt).toContain('Gaara, Kankuro');
        // Specifies non-railroad + butterfly tolerance
        expect(prompt).toContain('may diverge from canon');
    });
});

describe('STEP 4 — Arc Compass is ON by default', () => {
    it('injects the Director block when `enabled` is undefined (new conversation)', () => {
        const prompt = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            arc: { work: 'naruto', currentPosition: 'S1E1' }, // no `enabled` set
            arcOutline: '1. Kazekage Rescue Mission',
        });
        expect(prompt).toContain('NARRATIVE DIRECTOR');
        expect(prompt).toContain('Kazekage Rescue Mission');
    });

    it('only an explicit `enabled: false` skips the Director block', () => {
        const prompt = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            arc: { enabled: false, work: 'naruto', currentPosition: 'S1E1' },
            arcOutline: '1. Kazekage Rescue Mission',
        });
        expect(prompt).not.toContain('NARRATIVE DIRECTOR');
    });

    it('omits the block entirely when there is no arc data at all (no work, no position)', () => {
        const prompt = buildSystemPrompt(card, worldState, [], {
            template: '{{scenario}}',
            arc: {}, // truly empty
        });
        expect(prompt).not.toContain('NARRATIVE DIRECTOR');
    });
});
