/** Follow-ups from the independent review of the V2 corrections. */
import { describe, expect, it } from 'vitest';
import type { Conversation, StoryState } from '@/types';
import { auditDirectedComposition, stripDialogue } from '@/lib/ai/beat-auditor';
import { directorContract, normalizeDirectionResponse } from '@/lib/ai/directed-scene';
import { createInitialStoryState } from '@/lib/ai/story-state';

const conversation: Conversation = {
    id: 'review',
    characterId: 'card',
    title: 'review',
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

describe('normalizeDirectionResponse', () => {
    it('maps bare tokens and sentences, keeps the sentence as the note', () => {
        expect(normalizeDirectionResponse('refuse', undefined)).toEqual({
            directionResponse: 'refuse',
            directionResponseNote: undefined,
        });
        expect(
            normalizeDirectionResponse('She follows the direction, grudgingly.', undefined)
        ).toEqual({
            directionResponse: 'accept',
            directionResponseNote: 'She follows the direction, grudgingly.',
        });
        expect(
            normalizeDirectionResponse('bend', 'elle détourne la consigne').directionResponse
        ).toBe('bend');
    });

    it('does not read a negated acceptance as acceptance', () => {
        expect(
            normalizeDirectionResponse("Elle n'accepte pas la consigne.", undefined)
                .directionResponse
        ).toBe('refuse');
        expect(
            normalizeDirectionResponse('He does not follow it.', undefined).directionResponse
        ).toBe('refuse');
        expect(
            normalizeDirectionResponse('They disagree, in pursuit of her.', undefined)
                .directionResponse
        ).toBeUndefined();
    });
});

describe('auditor follow-ups', () => {
    it('an unclosed « does not hide a later narration line', () => {
        const stripped = stripDialogue('« Reste là.\nTu décides de partir.');
        expect(stripped).toContain('Tu décides');
    });

    it('compliance alone is not uniformity when stances differ', () => {
        const state: StoryState = createInitialStoryState({ conversation, profiles: [] });
        const decision = {
            participants: [],
            observedTransitions: [],
            plannedTransitions: [],
            beatKind: 'reaction' as const,
            initiativeOwner: 'world',
            concreteChange: 'x',
        };
        const intents = (stances: [string, string]) =>
            stances.map((stance, index) => ({
                characterRefId: `card:${index}`,
                name: `P${index}`,
                attention: 'brief' as const,
                stance,
                directionResponse: 'accept' as const,
            }));
        const composition = {
            narration: 'La pluie tombe.',
            turns: [
                { characterRefId: 'card:0', text: 'Elle sourit doucement, sans un mot.' },
                { characterRefId: 'card:1', text: 'Il claque la porte et sort en jurant.' },
            ],
        };
        const distinct = auditDirectedComposition({
            composition,
            decision,
            intents: intents(['Prudente et curieuse', 'Furieux et pressé']),
            state,
            solo: false,
            userName: 'Noah',
        });
        expect(distinct.issues.map((issue) => issue.code)).not.toContain('uniform-stances');
        const alike = auditDirectedComposition({
            composition,
            decision,
            intents: intents(['Prudente et curieuse', 'Prudente et curieuse']),
            state,
            solo: false,
            userName: 'Noah',
        });
        expect(alike.issues.map((issue) => issue.code)).toContain('uniform-stances');
    });
});

describe('director contract versions', () => {
    const fresh = createInitialStoryState({ conversation, profiles: [] });
    // A state with rhythm memory: JSON.stringify drops undefined fields, so a fresh state
    // would not show the V2 keys either way.
    const state: StoryState = {
        ...fresh,
        plot: { ...fresh.plot, recentBeatKinds: ['reaction'], recentInitiativeOwners: ['world'] },
    };
    const base = { state, profiles: [], userName: 'Noah', maxSpeakers: 3 };

    it('V1 keeps its historical header and never receives V2 fields', () => {
        const v1 = directorContract({ ...base, version: 1 });
        expect(v1).toContain('has ALREADY made true');
        expect(v1).not.toContain('ADVANCE SCENE');
        expect(v1).not.toContain('recentBeatKinds');
        expect(v1).not.toContain('"mode":"ensemble"');
        expect(v1).not.toContain('"tone"');
        expect(v1).not.toContain('initiativeOwner');
    });

    it('V1 advance-scene beats still get the no-replay rule, V2 gets the new header', () => {
        expect(directorContract({ ...base, version: 1, triggerKind: 'advance-scene' })).toContain(
            'ADVANCE SCENE'
        );
        const v2 = directorContract({ ...base, version: 2 });
        expect(v2).toContain('solo, world-led');
        expect(v2).toContain('recentBeatKinds');
        expect(v2).toContain('Do not repeat the beatKind');
    });
});
